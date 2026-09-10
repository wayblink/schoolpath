/**
 * Fill blank enrollment notes from district-level fields retained in the
 * 2026 学区助手 snapshot. These are third-party context, not school-specific
 * boundary assertions. Dry-run is the default; pass --apply to commit.
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
const reportDir = path.join(process.cwd(), ".tmp", "third-party-district-admission-backfill", stamp);

type Candidate = {
  id: number;
  name: string;
  district: string;
  school_type: string;
  district_admission_system: unknown;
  district_note: unknown;
};

function text(value: unknown) {
  return value === null || value === undefined ? "" : String(value).trim();
}

export function buildEnrollmentNote(candidate: Pick<Candidate, "district_admission_system" | "district_note">) {
  const system = text(candidate.district_admission_system);
  const note = text(candidate.district_note);
  const fields = [
    system ? `本区招生制度：${system}` : "",
    note ? `区级说明：${note}` : "",
  ].filter(Boolean);
  return fields.length > 0 ? `2026学区助手资料：${fields.join("；")}。` : "";
}

async function main() {
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const candidates = (
      await client.query<Candidate>(`
        SELECT id, name, district, type::text AS school_type,
               attrs->>'districtAdmissionSystem' AS district_admission_system,
               attrs->>'districtNote' AS district_note
        FROM public.schools
        WHERE nullif(btrim(coalesce(enrollment_note, '')), '') IS NULL
          AND (nullif(btrim(attrs->>'districtAdmissionSystem'), '') IS NOT NULL
            OR nullif(btrim(attrs->>'districtNote'), '') IS NOT NULL)
        ORDER BY district, id
      `)
    ).rows.filter((candidate) => buildEnrollmentNote(candidate));

    const actions: Array<Record<string, unknown>> = [];
    let notesFilled = 0;
    let sourcesUpserted = 0;
    for (const candidate of candidates) {
      const note = buildEnrollmentNote(candidate);
      const raw = {
        migration: "third_party_district_admission_note",
        source_name: "学区助手",
        source_url: "https://xuequzhushou.cn/",
        source_year: 2026,
        school_name: candidate.name,
        district: candidate.district,
        school_type: candidate.school_type,
        district_admission_system: text(candidate.district_admission_system) || null,
        district_note: text(candidate.district_note) || null,
        boundary_assertion: false,
      };
      const update = await client.query(
        `UPDATE public.schools
         SET enrollment_note = $1,
             attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{third_party_district_admission_note}', $2::jsonb, true),
             updated_at = now()
         WHERE id = $3
           AND (enrollment_note IS NULL OR btrim(enrollment_note) = '')
         RETURNING id`,
        [note, JSON.stringify(raw), candidate.id],
      );
      const source = await client.query(
        `INSERT INTO public.web_data_source(
           school_id, source_type, source_name, source_url, source_title,
           source_date, evidence, confidence, raw, fetched_at, created_at, updated_at
         ) VALUES ($1, 'third_party_admission', '学区助手', 'https://xuequzhushou.cn/', $2, '2026', $3, 'medium', $4::jsonb, now(), now(), now())
         ON CONFLICT (school_id, source_url, source_type)
         DO UPDATE SET source_title = excluded.source_title,
                       source_date = excluded.source_date,
                       evidence = excluded.evidence,
                       confidence = excluded.confidence,
                       raw = excluded.raw,
                       fetched_at = now(), updated_at = now()
         RETURNING id`,
        [candidate.id, `${candidate.name} 2026区级招生制度（第三方）`, "学区助手区级资料，仅作招生制度参考，不代表官方招生或具体学区边界结论。", JSON.stringify(raw)],
      );
      notesFilled += update.rowCount ?? 0;
      sourcesUpserted += source.rowCount ?? 0;
      actions.push({ schoolId: candidate.id, schoolName: candidate.name, district: candidate.district, note, noteAction: update.rowCount ? "filled" : "skipped_nonblank", sourceAction: source.rowCount ? "upserted" : "unchanged" });
    }
    writeFileSync(path.join(reportDir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: candidates.length, notesFilled, sourcesUpserted, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: candidates.length, notesFilled, sourcesUpserted, reportDir }, null, 2));
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
