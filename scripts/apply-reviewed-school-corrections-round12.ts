/**
 * Apply the next batch of manually reviewed official school evidence.
 * Dry-run is the default; pass --apply to commit. Updates are by id only,
 * preserve non-empty fields, and append an audit event for every change.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";
import { buildSafePatch, CORRECTIONS, type CurrentSchool } from "./reviewed-school-corrections-round12";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const apply = process.argv.includes("--apply");
const auditLogPath = path.join(process.cwd(), "data", "audit", "school-data-audit-log.jsonl");
const reportDir = path.join(
  process.cwd(),
  "data",
  "audit",
  "reviewed-school-corrections-round12",
  new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z"),
);

type DbSchool = CurrentSchool & {
  lat: number | null;
  lng: number | null;
  tier: string | null;
  website: string | null;
  attrs: Record<string, unknown> | null;
};

function sourcePayload(correction: (typeof CORRECTIONS)[number]) {
  return {
    source_type: correction.source.type,
    source_name: correction.source.name,
    source_title: correction.source.title,
    source_url: correction.source.url,
    source_date: correction.source.date,
    matched_name: correction.source.matchedName,
    raw_nature: correction.source.rawNature,
    raw_address: correction.source.rawAddress,
    reviewed_at: new Date().toISOString(),
    note: correction.note,
  };
}

async function main() {
  mkdirSync(path.dirname(auditLogPath), { recursive: true });
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const events: unknown[] = [];
  let changed = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");
    for (const correction of CORRECTIONS) {
      const result = await client.query<DbSchool>(
        `SELECT id, name, district, type, address, school_nature AS "schoolNature", aliases,
                lat, lng, tier, website, attrs
           FROM public.schools WHERE id = $1 FOR UPDATE`,
        [correction.id],
      );
      const current = result.rows[0];
      const patch = current ? buildSafePatch(current, correction) : null;
      if (!current || !patch) {
        skipped += 1;
        events.push({ mode: apply ? "apply" : "dry-run", school_id: correction.id, status: "skipped", reason: !current ? "missing_row" : "row_drift" });
        continue;
      }

      const source = sourcePayload(correction);
      const attrs = {
        ...(current.attrs ?? {}),
        official_school_info_source: source,
        official_school_info_sources: [
          ...(((current.attrs?.official_school_info_sources as unknown[]) ?? []).filter(Boolean)),
          source,
        ].slice(-20),
      };
      const event = {
        ts: new Date().toISOString(),
        operation: "reviewed_school_correction_round12",
        mode: apply ? "apply" : "dry-run",
        school_id: current.id,
        school_name: current.name,
        changes: patch,
        source: correction.source,
        note: correction.note,
        before: current,
        after: { ...current, ...patch, attrs },
      };
      events.push(event);
      console.log(JSON.stringify(event));
      if (!apply) {
        changed += 1;
        continue;
      }

      const updated = await client.query(
        `UPDATE public.schools
            SET name = COALESCE($1, name),
                address = COALESCE($2, address),
                school_nature = COALESCE($3::school_nature, school_nature),
                aliases = $4,
                attrs = $5::jsonb,
                updated_at = now()
          WHERE id = $6`,
        [patch.name ?? null, patch.address ?? null, patch.schoolNature ?? null, patch.aliases, JSON.stringify(attrs), current.id],
      );
      if ((updated.rowCount ?? 0) === 0) {
        skipped += 1;
        continue;
      }

      await client.query(
        `INSERT INTO public.web_data_source(
           school_id, source_type, source_name, source_url, source_title, source_date,
           evidence, confidence, raw, fetched_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'high', $8::jsonb, now(), now())
         ON CONFLICT (school_id, source_url, source_type)
         DO UPDATE SET source_name=excluded.source_name, source_title=excluded.source_title,
           source_date=excluded.source_date, evidence=excluded.evidence,
           confidence=excluded.confidence, raw=excluded.raw, fetched_at=now(), updated_at=now()`,
        [current.id, correction.source.type, correction.source.name, correction.source.url, correction.source.title, correction.source.date, correction.note, JSON.stringify(source)],
      );
      appendFileSync(auditLogPath, `${JSON.stringify(event)}\n`);
      changed += 1;
    }

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    const summary = { mode: apply ? "apply" : "dry-run", changed, skipped, reportDir };
    writeFileSync(path.join(reportDir, apply ? "applied-events.json" : "dry-run-events.json"), JSON.stringify({ summary, events }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
