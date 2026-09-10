/**
 * Fill blank enrollment notes from published official enrollment-area evidence.
 *
 * The source rows are deliberately limited to the catalog relation records
 * tagged as administrative_or_enrollment_area. They are aggregated per school,
 * preserve the source quotes/URLs in attrs and web_data_source, and never
 * overwrite a non-empty enrollment note. Dry-run is the default; pass --apply.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const reportDir = path.join(process.cwd(), ".tmp", "official-area-enrollment-notes", stamp);

export type OfficialAreaRow = {
  school_id: number;
  school_name: string;
  district: string;
  school_type: string;
  source_url: string;
  source_name: string;
  source_year: number;
  area: string | null;
  committee_name: string | null;
  source_quote: string | null;
  source_title: string | null;
};

export function buildOfficialAreaNote(rows: Pick<OfficialAreaRow, "district" | "source_year" | "area" | "committee_name">[]) {
  const areas = [...new Set(rows.map((row) => (row.committee_name ?? row.area ?? "").trim()).filter(Boolean))];
  if (areas.length === 0) return "";
  return `${rows[0]?.source_year ?? 2026}年${rows[0]?.district ?? ""}区官方招生区域（行政/居委口径）：${areas.join("、")}。`;
}

async function main() {
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const rows = (await client.query<OfficialAreaRow>(`
      SELECT r.school_id, s.name AS school_name, s.district, s.type::text AS school_type,
             r.source_url, r.source_name, r.source_year, r.area, r.committee_name,
             r.attrs->>'source_quote' AS source_quote,
             r.attrs->>'source_title' AS source_title
        FROM catalog.school_district_relations r
        JOIN public.schools s ON s.id = r.school_id
       WHERE r.school_id IS NOT NULL
         AND r.attrs->>'official_area_level' = 'administrative_or_enrollment_area'
         AND r.source_url IS NOT NULL
         AND r.source_url <> ''
         AND (s.enrollment_note IS NULL OR btrim(s.enrollment_note) = '')
       ORDER BY r.school_id, r.id
    `)).rows;
    const grouped = new Map<number, OfficialAreaRow[]>();
    for (const row of rows) grouped.set(row.school_id, [...(grouped.get(row.school_id) ?? []), row]);
    const actions: Array<Record<string, unknown>> = [];
    let updated = 0;
    let sourcesUpserted = 0;
    for (const schoolRows of grouped.values()) {
      const first = schoolRows[0]!;
      const note = buildOfficialAreaNote(schoolRows);
      const raw = {
        migration: "official_catalog_area_to_enrollment_note",
        school_id: first.school_id,
        school_name: first.school_name,
        district: first.district,
        school_type: first.school_type,
        source_year: first.source_year,
        areas: [...new Set(schoolRows.map((row) => row.committee_name ?? row.area).filter(Boolean))],
        source_quotes: [...new Set(schoolRows.map((row) => row.source_quote).filter(Boolean))],
        source_urls: [...new Set(schoolRows.map((row) => row.source_url))],
        boundary_assertion: true,
        residential_relation: false,
      };
      let action = "dry-run";
      if (apply) {
        const update = await client.query(`
          UPDATE public.schools
             SET enrollment_note = $1,
                 attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{official_catalog_area_enrollment_note}', $2::jsonb, true),
                 updated_at = now()
           WHERE id = $3 AND (enrollment_note IS NULL OR btrim(enrollment_note) = '')
           RETURNING id
        `, [note, JSON.stringify(raw), first.school_id]);
        updated += update.rowCount ?? 0;
        if (update.rowCount) {
          for (const source of [...new Map(schoolRows.map((row) => [row.source_url, row])).values()]) {
            const result = await client.query(`
              INSERT INTO public.web_data_source(
                school_id, source_type, source_name, source_url, source_title,
                source_date, evidence, confidence, raw, fetched_at, created_at, updated_at
              ) VALUES ($1, 'official_admission', $2, $3, $4, $5, $6, 'high', $7::jsonb, now(), now(), now())
              ON CONFLICT (school_id, source_url, source_type) DO UPDATE SET
                source_title = excluded.source_title, source_date = excluded.source_date,
                evidence = excluded.evidence, confidence = excluded.confidence,
                raw = excluded.raw, fetched_at = now(), updated_at = now()
              RETURNING id
            `, [first.school_id, source.source_name, source.source_url, source.source_title ?? "官方招生区域", String(source.source_year), source.source_quote ?? note, JSON.stringify(raw)]);
            sourcesUpserted += result.rowCount ?? 0;
          }
          action = "updated";
        } else action = "skipped_nonblank_or_changed";
      }
      actions.push({ schoolId: first.school_id, schoolName: first.school_name, district: first.district, note, sourceUrls: raw.source_urls, action });
    }
    writeFileSync(path.join(reportDir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: grouped.size, rows: rows.length, updated, sourcesUpserted, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: grouped.size, rows: rows.length, updated, sourcesUpserted, report: reportDir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("backfill-enrollment-notes-from-catalog-official-areas.ts")) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
