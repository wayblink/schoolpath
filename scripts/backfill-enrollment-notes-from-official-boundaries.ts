/**
 * Promote already stored official catchment text into blank enrollment notes.
 *
 * This does not infer school-community relations. It only uses rows that have
 * an explicit attrs.official_boundary_text and a structured official source
 * URL, preserving the original evidence in attrs and web_data_source.
 * Dry-run is the default; pass --apply to commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const districtArg = valueArg("--district") ?? "黄浦";
const reportDir = path.join(
  process.cwd(),
  ".tmp",
  "official-boundary-enrollment-notes",
  new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-"),
);

type Source = { url?: string; date?: string; name?: string; district?: string };
type School = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  enrollment_note: string | null;
  boundary: string | null;
  source: Source | null;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function sourceDate(source: Source | null) {
  if (source?.date && /^20\d{2}-\d{2}-\d{2}$/.test(source.date)) return source.date;
  const year = source?.date?.match(/20\d{2}/)?.[0] ?? source?.name?.match(/20\d{2}/)?.[0];
  return year ? `${year}-01-01` : null;
}

async function main() {
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Record<string, unknown>[] = [];
  let matched = 0;
  let updated = 0;
  let sourcesUpserted = 0;
  try {
    const schools = (
      await client.query<School>(
        `SELECT id,name,district,type,enrollment_note,
                nullif(attrs->>'official_boundary_text','') AS boundary,
                CASE WHEN jsonb_typeof(attrs->'official_boundary_source')='object'
                     THEN attrs->'official_boundary_source' ELSE '{}'::jsonb END AS source
           FROM public.schools
          WHERE district=$1
            AND nullif(btrim(attrs->>'official_boundary_text'),'') IS NOT NULL
            AND nullif(btrim(attrs->'official_boundary_source'->>'url'),'') IS NOT NULL
          ORDER BY id`,
        [districtArg],
      )
    ).rows;
    writeFileSync(path.join(reportDir, "target-schools-before.json"), JSON.stringify(schools, null, 2), "utf8");
    await client.query("BEGIN");
    for (const school of schools) {
      if (school.enrollment_note?.trim()) {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-existing-note" });
        continue;
      }
      const boundary = school.boundary?.trim() ?? "";
      const url = school.source?.url?.trim() ?? "";
      if (!boundary || !url) {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-invalid-source" });
        continue;
      }
      matched += 1;
      const note = `${school.source?.date?.slice(0, 4) ?? "2025"}年${school.district}区官方公办小学对口范围：${boundary}`;
      const raw = {
        migration: "official_boundary_to_enrollment_note",
        district: school.district,
        school_name: school.name,
        school_type: school.type,
        official_boundary_text: boundary,
        official_boundary_source: school.source,
      };
      const evidence = `${school.source?.name ?? "官方办学基本情况公示表"}；学校：${school.name}；对口范围：${boundary}`;
      if (apply) {
        const result = await client.query(
          `UPDATE public.schools
              SET enrollment_note=$1,
                  attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_boundary_enrollment_note}',$2::jsonb,true),
                  updated_at=now()
            WHERE id=$3 AND district=$4 AND name=$5
              AND (enrollment_note IS NULL OR btrim(enrollment_note)='')`,
          [note, JSON.stringify(raw), school.id, school.district, school.name],
        );
        updated += result.rowCount ?? 0;
        const sourceResult = await client.query(
          `INSERT INTO public.web_data_source
             (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at)
           VALUES ($1,'official_admission',$2,$3,$4,$5,$6,'high',$7::jsonb,now(),now())
           ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET
             source_title=excluded.source_title,source_date=excluded.source_date,
             evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,
             fetched_at=now(),updated_at=now()
           RETURNING id`,
          [school.id, school.source?.district ? `${school.source.district}区教育局` : `${school.district}区教育局`, url, school.source?.name ?? "官方对口范围公示", sourceDate(school.source), evidence, JSON.stringify(raw)],
        );
        sourcesUpserted += sourceResult.rowCount ?? 0;
      }
      actions.push({ schoolId: school.id, schoolName: school.name, sourceUrl: url, action: apply ? "update" : "dry-run" });
    }
    writeFileSync(path.join(reportDir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: schools.length, matched, updated, sourcesUpserted, report: reportDir }, null, 2));
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
