/**
 * Backfill six uniquely matched blank Baoshan enrollment notes from the
 * cached 2025 Shanghai Government admission-range tables.
 *
 * The source contains school-level admission ranges and class plans. This
 * migration deliberately uses a reviewed id allowlist because several rows in
 * the source represent multiple campuses or historical school names that map
 * to one catalog entity. Dry-run is the default; pass --apply to commit.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

export type BaoshanStage = "primary" | "middle" | "nine_year";

export type OfficialBaoshanRow = {
  district: string;
  type: BaoshanStage;
  name: string;
  address: string;
  enrollmentNote: string;
  admissionPlanClasses: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
  officialItems?: string[];
  committeeItems?: string[];
  residentialAreaItems?: string[];
  [key: string]: unknown;
};

export type BaoshanSchool = {
  id: number;
  name: string;
  district: string;
  type: BaoshanStage;
  enrollment_note: string | null;
  attrs: Record<string, unknown> | null;
};

export const SOURCE_PATH = path.join(
  process.cwd(),
  ".tmp",
  "baoshan-school-import",
  "20260604-123510",
  "parsed-official-baoshan-schools.json",
);

// Reviewed in the preceding audit. Other source rows include multi-campus or
// renamed entities and must remain available for later manual resolution.
export const TARGET_SCHOOL_IDS = new Set([4633, 5790, 5791, 5793, 5794, 5803]);

export function normalizeName(value: string) {
  return value
    .replace(/[\s　·•\-—]/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市?/, "")
    .replace(/^宝山区?/, "")
    .replace(/小学部|初中部|中学部/g, "")
    .trim();
}

export function validOfficialRow(row: OfficialBaoshanRow) {
  return (
    row.district === "宝山" &&
    (row.type === "primary" || row.type === "middle") &&
    Boolean(row.name?.trim()) &&
    Boolean(row.enrollmentNote?.trim()) &&
    /^\d+(?:\.\d+)?$/.test(row.admissionPlanClasses?.trim() ?? "") &&
    Boolean(row.sourceTitle?.trim()) &&
    Boolean(row.sourceUrl?.trim())
  );
}

/** Return a row only when the reviewed school resolves to one source row. */
export function matchUniqueOfficialRow(school: BaoshanSchool, rows: OfficialBaoshanRow[]) {
  if (!TARGET_SCHOOL_IDS.has(school.id) || school.district !== "宝山") return null;
  const candidates = rows.filter(
    (row) =>
      validOfficialRow(row) &&
      row.type === school.type &&
      normalizeName(row.name) === normalizeName(school.name),
  );
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

export function noteForOfficialRow(row: OfficialBaoshanRow) {
  const stage = row.type === "primary" ? "小学" : "初中";
  return `2025年宝山区官方${stage}招生范围：${row.enrollmentNote.trim()}；招生计划：${row.admissionPlanClasses.trim()}个班`;
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-baoshan-admission-notes", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadRows(sourcePath: string) {
  const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`Expected an array in ${sourcePath}`);
  return parsed as OfficialBaoshanRow[];
}

type Action = Record<string, unknown>;

async function main() {
  const apply = process.argv.includes("--apply");
  const sourcePath = process.argv.find((arg) => arg.startsWith("--source="))?.slice("--source=".length) ?? SOURCE_PATH;
  const rows = loadRows(sourcePath);
  const dir = outputDir();
  writeFileSync(path.join(dir, "source-rows.json"), JSON.stringify(rows, null, 2), "utf8");

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Action[] = [];
  let updated = 0;
  let sourcesUpserted = 0;

  try {
    const schools = (
      await client.query<BaoshanSchool>(
        `SELECT id,name,district,type,enrollment_note,attrs
         FROM public.schools WHERE district='宝山' ORDER BY id`,
      )
    ).rows;
    writeFileSync(path.join(dir, "target-schools-before.json"), JSON.stringify(schools, null, 2), "utf8");
    await client.query("BEGIN");

    for (const school of schools) {
      if (!TARGET_SCHOOL_IDS.has(school.id)) continue;
      const row = matchUniqueOfficialRow(school, rows);
      if (!row) {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-unmatched-or-ambiguous" });
        continue;
      }
      if (school.enrollment_note?.trim()) {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-existing-note" });
        continue;
      }

      const note = noteForOfficialRow(row);
      const raw = {
        migration: "official_baoshan_admission_2025",
        district: "宝山",
        school_id: school.id,
        source_row: row,
      };
      if (apply) {
        const result = await client.query(
          `UPDATE public.schools
           SET enrollment_note=$1,
               attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_baoshan_admission_2025}',$2::jsonb,true),
               updated_at=now()
           WHERE id=$3 AND district='宝山'
             AND (enrollment_note IS NULL OR btrim(enrollment_note)='')`,
          [note, JSON.stringify(raw), school.id],
        );
        updated += result.rowCount ?? 0;
        const evidence = `${row.sourceTitle}；学校：${row.name}；招生范围：${row.enrollmentNote}；招生计划：${row.admissionPlanClasses}个班`;
        const sourceResult = await client.query(
          `INSERT INTO public.web_data_source
             (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at)
           VALUES ($1,'official_admission','宝山区教育局',$2,$3,$4,$5,'high',$6::jsonb,now(),now(),now())
           ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET
             source_title=excluded.source_title,source_date=excluded.source_date,
             evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,
             fetched_at=now(),updated_at=now()
           RETURNING id`,
          [school.id, row.sourceUrl, row.sourceTitle, row.sourceDate || "2025-04-07", evidence, JSON.stringify(raw)],
        );
        sourcesUpserted += sourceResult.rowCount ?? 0;
      }
      actions.push({ schoolId: school.id, schoolName: school.name, sourceName: row.name, sourceUrl: row.sourceUrl, action: apply ? "update" : "dry-run", note });
    }

    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: rows.length, reviewedSchoolIds: TARGET_SCHOOL_IDS.size, eligible: actions.filter((a) => a.action === "update" || a.action === "dry-run").length, updated, sourcesUpserted, report: dir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
