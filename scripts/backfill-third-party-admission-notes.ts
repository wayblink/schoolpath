/**
 * Fill blank enrollment notes from the existing 2026 学区助手 source snapshot.
 *
 * This is a third-party enrichment only: it never overwrites an existing note,
 * does not infer school-community relations, and records the source fields in
 * web_data_source for later review. Dry-run is the default; pass --apply.
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
const reportDir = path.join(process.cwd(), ".tmp", "third-party-admission-backfill", stamp);

type Candidate = {
  school_id: number;
  school_name: string;
  district: string;
  school_type: string;
  admission_mode: unknown;
  area: unknown;
  street: unknown;
  feeder_middle_school: unknown;
  middle_school_tier: unknown;
  class_count: unknown;
  source_key: string;
};

export function buildEnrollmentNote(candidate: Pick<Candidate, "admission_mode" | "area" | "street" | "feeder_middle_school" | "middle_school_tier" | "class_count">) {
  const text = (value: unknown) => (value === null || value === undefined ? "" : String(value).trim());
  const admissionMode = text(candidate.admission_mode);
  const fields = [
    admissionMode ? `入学方式：${admissionMode}` : "",
    text(candidate.area) ? `片区：${text(candidate.area)}` : "",
    text(candidate.street) ? `街道：${text(candidate.street)}` : "",
    text(candidate.feeder_middle_school) ? `对口初中：${text(candidate.feeder_middle_school)}` : "",
    text(candidate.middle_school_tier) ? `初中梯队：${text(candidate.middle_school_tier)}` : "",
    text(candidate.class_count) ? `招生班级：${text(candidate.class_count)}` : "",
  ].filter(Boolean);
  return `2026学区助手资料：${fields.join("；")}。`;
}

async function main() {
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const candidates = (
      await client.query<Candidate>(`
        WITH unique_source AS (
          SELECT public_school_id, max(id) AS source_id
          FROM catalog.source_schools
          WHERE source_name = '学区助手'
            AND source_year = 2026
            AND public_school_id IS NOT NULL
            AND nullif(btrim(admission_mode), '') IS NOT NULL
          GROUP BY public_school_id
          HAVING count(*) = 1
        )
        SELECT s.id AS school_id, s.name AS school_name, s.district,
               ss.school_type, ss.admission_mode, ss.area, ss.street,
               ss.feeder_middle_school, ss.middle_school_tier, ss.class_count,
               ss.source_key
        FROM unique_source us
        JOIN catalog.source_schools ss ON ss.id = us.source_id
        JOIN public.schools s ON s.id = ss.public_school_id
        WHERE nullif(btrim(coalesce(s.enrollment_note, '')), '') IS NULL
        ORDER BY s.district, s.id
      `)
    ).rows;

    const actions: Array<Record<string, unknown>> = [];
    let notesFilled = 0;
    let sourcesUpserted = 0;
    for (const candidate of candidates) {
      const note = buildEnrollmentNote(candidate);
      const raw = {
        migration: "third_party_admission_note",
        source_key: candidate.source_key,
        source_name: "学区助手",
        source_url: "https://xuequzhushou.cn/",
        source_year: 2026,
        school_name: candidate.school_name,
        district: candidate.district,
        school_type: candidate.school_type,
        admission_mode: candidate.admission_mode,
        area: candidate.area,
        street: candidate.street,
        feeder_middle_school: candidate.feeder_middle_school,
        middle_school_tier: candidate.middle_school_tier,
        class_count: candidate.class_count,
      };
      const update = await client.query(
        `UPDATE public.schools
         SET enrollment_note = $1,
             attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{third_party_admission_note}', $2::jsonb, true),
             updated_at = now()
         WHERE id = $3
           AND (enrollment_note IS NULL OR btrim(enrollment_note) = '')
         RETURNING id`,
        [note, JSON.stringify(raw), candidate.school_id],
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
                       fetched_at = now(),
                       updated_at = now()
         RETURNING id`,
        [
          candidate.school_id,
          `${candidate.school_name} 2026招生信息（第三方）`,
          "学区助手结构化资料，仅作招生方式参考，不代表官方招生或学区结论。",
          JSON.stringify(raw),
        ],
      );
      notesFilled += update.rowCount ?? 0;
      sourcesUpserted += source.rowCount ?? 0;
      actions.push({ schoolId: candidate.school_id, schoolName: candidate.school_name, district: candidate.district, note, noteAction: update.rowCount ? "filled" : "skipped_nonblank", sourceAction: source.rowCount ? "upserted" : "unchanged" });
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
