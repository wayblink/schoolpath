/**
 * Apply high-confidence official school info with an append-only audit log.
 *
 * This script intentionally avoids any row merges/deletes. It only fills blank
 * address and missing school_nature values from official 2025 district sources.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const minScore = numberArg("--min-score") ?? 220;
const reportPath = valueArg("--report");
const auditLogPath =
  valueArg("--audit-log") ?? path.join(process.cwd(), ".tmp", "school-data-audit-log.jsonl");
const outDir = path.join(
  process.cwd(),
  ".tmp",
  "official-school-info-audited-apply",
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-"),
);

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  aliases: string[] | null;
  address: string | null;
  school_nature: "公立" | "私立" | null;
  attrs: Record<string, unknown> | null;
};

type SourceRecord = {
  district: string;
  stage: "primary" | "middle" | "unknown";
  name: string;
  nature: string;
  address: string;
  sourceTitle: string;
  sourceUrl: string;
};

type MatchReport = {
  school: {
    id: number;
    name: string;
    district: string;
    type: "primary" | "middle" | "nine_year";
    address: string | null;
    attrs: Record<string, unknown> | null;
  };
  match: SourceRecord | null;
  score: number;
  action: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function numberArg(name: string) {
  const raw = valueArg(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function latestOfficialDryRunReport() {
  const base = path.join(process.cwd(), ".tmp", "official-school-info-backfill");
  if (!existsSync(base)) return undefined;
  const candidates = readdirSync(base)
    .map((dir) => path.join(base, dir, "matches-dry-run.json"))
    .filter((file) => existsSync(file))
    .sort();
  return candidates.at(-1);
}

function normalizeNature(value: string | null | undefined): "公立" | "私立" | null {
  if (!value) return null;
  if (value.includes("民办")) return "私立";
  if (value.includes("公办") || value.includes("公立")) return "公立";
  return null;
}

function hasAddress(value: string | null | undefined) {
  return Boolean(value && value.trim());
}

function makeAuditEvent(params: {
  mode: "apply" | "dry-run";
  schoolBefore: SchoolRow;
  schoolAfter: Partial<SchoolRow>;
  match: SourceRecord;
  score: number;
  changes: Record<string, { from: unknown; to: unknown }>;
}) {
  return {
    ts: new Date().toISOString(),
    operation: "official_school_info_backfill",
    mode: params.mode,
    school_id: params.schoolBefore.id,
    school_name: params.schoolBefore.name,
    district: params.schoolBefore.district,
    score: params.score,
    changes: params.changes,
    source: {
      type: "official_school_info",
      name: "上海市各区教育局/政府公开信息",
      title: params.match.sourceTitle,
      url: params.match.sourceUrl,
      matched_name: params.match.name,
      raw_nature: params.match.nature,
      raw_address: params.match.address,
    },
    before: {
      name: params.schoolBefore.name,
      district: params.schoolBefore.district,
      address: params.schoolBefore.address,
      school_nature: params.schoolBefore.school_nature,
      aliases: params.schoolBefore.aliases ?? [],
    },
    after: params.schoolAfter,
  };
}

async function main() {
  const input = reportPath ?? latestOfficialDryRunReport();
  if (!input || !existsSync(input)) {
    throw new Error("Dry-run report not found. Run scripts/backfill-school-info-from-official.ts first.");
  }

  mkdirSync(path.dirname(auditLogPath), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  const reports = JSON.parse(readFileSync(input, "utf8")) as MatchReport[];
  const candidates = reports.filter((item) => item.match && item.score >= minScore);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const events: unknown[] = [];
  let changed = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");
    for (const candidate of candidates) {
      const match = candidate.match!;
      const currentResult = await client.query<SchoolRow>(
        `
          SELECT id, name, district, type, aliases, address, school_nature, attrs
          FROM schools
          WHERE id = $1 AND name = $2 AND district = $3
          FOR UPDATE
        `,
        [candidate.school.id, candidate.school.name, candidate.school.district],
      );
      const current = currentResult.rows[0];
      if (!current) {
        skipped += 1;
        continue;
      }

      const officialNature = normalizeNature(match.nature);
      const nextAddress = !hasAddress(current.address) && hasAddress(match.address) ? match.address.trim() : null;
      const nextNature = current.school_nature == null && officialNature ? officialNature : null;
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (nextAddress) changes.address = { from: current.address, to: nextAddress };
      if (nextNature) changes.school_nature = { from: current.school_nature, to: nextNature };

      if (Object.keys(changes).length === 0) {
        skipped += 1;
        continue;
      }

      const sourcePayload = {
        source_title: match.sourceTitle,
        source_url: match.sourceUrl,
        matched_name: match.name,
        match_score: candidate.score,
        collected_at: new Date().toISOString(),
        filled_fields: Object.keys(changes),
      };
      const attrsPatch = {
        ...(current.attrs ?? {}),
        official_school_info_source: sourcePayload,
        official_school_info_sources: [
          ...(((current.attrs?.official_school_info_sources as unknown[]) ?? []).filter(Boolean)),
          sourcePayload,
        ].slice(-10),
      };

      const event = makeAuditEvent({
        mode: apply ? "apply" : "dry-run",
        schoolBefore: current,
        schoolAfter: {
          name: current.name,
          district: current.district,
          address: nextAddress ?? current.address,
          school_nature: nextNature ?? current.school_nature,
          aliases: current.aliases ?? [],
        },
        match,
        score: candidate.score,
        changes,
      });

      events.push(event);
      console.log(JSON.stringify(event));

      if (apply) {
        const updateResult = await client.query(
          `
            UPDATE schools
            SET
              address = coalesce($1, address),
              school_nature = coalesce($2::school_nature, school_nature),
              attrs = $3::jsonb,
              updated_at = now()
            WHERE id = $4
              AND name = $5
              AND district = $6
              AND (
                ($1::text IS NOT NULL AND (address IS NULL OR btrim(address) = ''))
                OR ($2::school_nature IS NOT NULL AND school_nature IS NULL)
              )
          `,
          [
            nextAddress,
            nextNature,
            JSON.stringify(attrsPatch),
            current.id,
            current.name,
            current.district,
          ],
        );
        if ((updateResult.rowCount ?? 0) > 0) {
          await client.query(
            `
              INSERT INTO web_data_source (
                school_id,
                source_type,
                source_name,
                source_url,
                source_title,
                evidence,
                confidence,
                raw,
                fetched_at,
                updated_at
              )
              VALUES ($1, 'official_school_info', $2, $3, $4, $5, 'high', $6::jsonb, now(), now())
              ON CONFLICT (school_id, source_url, source_type)
              DO UPDATE SET
                source_name = excluded.source_name,
                source_title = excluded.source_title,
                evidence = excluded.evidence,
                confidence = excluded.confidence,
                raw = excluded.raw,
                fetched_at = excluded.fetched_at,
                updated_at = now()
            `,
            [
              current.id,
              "上海市各区教育局/政府公开信息",
              match.sourceUrl,
              match.sourceTitle,
              `官方公开信息匹配学校“${match.name}”，用于补充${Object.keys(changes).join("、")}。`,
              JSON.stringify({
                score: candidate.score,
                raw: match,
                changes,
              }),
            ],
          );
          appendFileSync(auditLogPath, `${JSON.stringify(event)}\n`, "utf8");
          changed += 1;
        }
      } else {
        changed += 1;
      }
    }

    writeFileSync(path.join(outDir, apply ? "applied-events.json" : "dry-run-events.json"), JSON.stringify(events, null, 2));

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(
      JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        input,
        auditLogPath,
        minScore,
        candidates: candidates.length,
        changed,
        skipped,
        eventReport: path.join(outDir, apply ? "applied-events.json" : "dry-run-events.json"),
      }),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
