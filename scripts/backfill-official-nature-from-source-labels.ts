/**
 * Fill null school_nature from an explicit public/private label in an already
 * recorded official source. It never infers nature from a school name alone.
 * Dry-run is the default; pass --apply to commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const apply = process.argv.includes("--apply");

type Candidate = {
  school_id: number;
  school_name: string;
  district: string;
  source_type: string;
  source_title: string | null;
  source_url: string | null;
  raw: Record<string, unknown> | null;
};

type Nature = "公立" | "私立";

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function explicitNature(candidate: Pick<Candidate, "source_title" | "raw">): Nature | null {
  const raw = candidate.raw ?? {};
  const source = raw.source && typeof raw.source === "object" && !Array.isArray(raw.source)
    ? raw.source as Record<string, unknown>
    : {};
  const values = [
    text(candidate.source_title),
    text(raw.school),
    text(raw.name),
    text(raw.nature),
    text(raw.raw_nature),
    text(source.school),
    text(source.nature),
  ].filter(Boolean);
  const hasPrivate = values.some((value) => /民办|私立/.test(value));
  const hasPublic = values.some((value) => /公办|公立/.test(value));
  // An official row with both labels is contradictory evidence. Keep the
  // field blank for review instead of silently choosing one interpretation.
  if (hasPrivate && hasPublic) return null;
  if (hasPrivate) return "私立";
  if (hasPublic) return "公立";
  return null;
}

async function main() {
  loadLocalEnv();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const reportDir = path.join(process.cwd(), ".tmp", "official-nature-label-backfill", stamp);
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const sourceRows = (
      await client.query<Candidate>(`
        SELECT s.id AS school_id, s.name AS school_name, s.district,
               wd.source_type, wd.source_title, wd.source_url, wd.raw
        FROM public.schools s
        JOIN public.web_data_source wd ON wd.school_id = s.id
        WHERE s.school_nature IS NULL
          AND wd.source_type IN ('official_school_info', 'official_admission')
        ORDER BY s.district, s.id, wd.id
      `)
    ).rows;

    const bySchool = new Map<number, { candidate: Candidate; nature: Nature; sourceCount: number }>();
    const natureRows = new Map<number, Array<{ candidate: Candidate; nature: Nature }>>();
    for (const row of sourceRows) {
      const nature = explicitNature(row);
      if (!nature) continue;
      natureRows.set(row.school_id, [...(natureRows.get(row.school_id) ?? []), { candidate: row, nature }]);
    }
    for (const [schoolId, rows] of natureRows) {
      const natures = new Set(rows.map((row) => row.nature));
      if (natures.size === 1) {
        const first = rows[0]!;
        bySchool.set(schoolId, { candidate: first.candidate, nature: first.nature, sourceCount: rows.length });
      }
    }

    const actions: Array<Record<string, unknown>> = [];
    let updated = 0;
    for (const { candidate, nature, sourceCount } of bySchool.values()) {
      const raw = {
        migration: "official_source_nature_label",
        school_name: candidate.school_name,
        district: candidate.district,
        normalized_nature: nature,
        source_type: candidate.source_type,
        source_title: candidate.source_title,
        source_url: candidate.source_url,
        source_count_consistent: sourceCount,
        evidence: "官方来源标题或学校条目明确包含公办/民办标签。",
      };
      const result = await client.query(
        `UPDATE public.schools
         SET school_nature = $1::school_nature,
             attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{official_source_nature_label}', $2::jsonb, true),
             updated_at = now()
         WHERE id = $3 AND school_nature IS NULL
         RETURNING id`,
        [nature, JSON.stringify(raw), candidate.school_id],
      );
      updated += result.rowCount ?? 0;
      actions.push({ schoolId: candidate.school_id, schoolName: candidate.school_name, district: candidate.district, nature, sourceType: candidate.source_type, sourceTitle: candidate.source_title, sourceUrl: candidate.source_url, sourceCount, action: result.rowCount ? "filled" : "skipped_nonnull" });
    }
    writeFileSync(path.join(reportDir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: sourceRows.length, candidates: bySchool.size, updated, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: sourceRows.length, candidates: bySchool.size, updated, reportDir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
