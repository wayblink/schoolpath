/**
 * Fill blank school_nature from a unique third-party source row whose
 * admission/evaluation text explicitly states public or private status.
 *
 * This does not infer nature from school names, never overwrites a non-null
 * value, records third-party provenance, and is dry-run by default.
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
const reportDir = path.join(process.cwd(), ".tmp", "third-party-school-nature-backfill", stamp);

type Candidate = {
  school_id: number;
  school_name: string;
  district: string;
  source_id: number;
  source_name: string;
  source_year: number | null;
  source_key: string;
  admission_mode: string | null;
  evaluation: string | null;
  tags: unknown;
};

type Nature = "公立" | "私立";

function explicitNature(row: Pick<Candidate, "admission_mode" | "evaluation" | "tags">): Nature | null {
  const values = [row.admission_mode, row.evaluation, typeof row.tags === "string" ? row.tags : JSON.stringify(row.tags ?? "")]
    .filter((value): value is string => Boolean(value && value.trim()));
  const publicHit = values.some((value) => /公办|公立/.test(value));
  const privateHit = values.some((value) => /民办|私立/.test(value));
  if (publicHit && privateHit) return null;
  if (privateHit) return "私立";
  if (publicHit) return "公立";
  return null;
}

async function main() {
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const rows = (
      await client.query<Candidate>(`
        WITH unique_source AS (
          SELECT public_school_id, max(id) AS source_id
          FROM catalog.source_schools
          WHERE source_name = '学区助手'
            AND public_school_id IS NOT NULL
            AND public_school_id IN (SELECT id FROM public.schools WHERE school_nature IS NULL)
          GROUP BY public_school_id
          HAVING count(*) = 1
        )
        SELECT s.id AS school_id, s.name AS school_name, s.district,
               ss.id AS source_id, ss.source_name, ss.source_year, ss.source_key,
               ss.admission_mode, ss.evaluation, ss.tags
        FROM unique_source us
        JOIN catalog.source_schools ss ON ss.id = us.source_id
        JOIN public.schools s ON s.id = ss.public_school_id
        WHERE s.school_nature IS NULL
        ORDER BY s.district, s.id
      `)
    ).rows;

    const actions: Array<Record<string, unknown>> = [];
    let updated = 0;
    for (const row of rows) {
      const nature = explicitNature(row);
      const action = nature ? (apply ? "update" : "dry-run") : "skip-ambiguous-or-no-explicit-nature";
      const raw = {
        migration: "third_party_school_nature",
        source_name: row.source_name,
        source_year: row.source_year,
        source_key: row.source_key,
        school_name: row.school_name,
        district: row.district,
        admission_mode: row.admission_mode,
        evaluation: row.evaluation,
        tags: row.tags,
        normalized_nature: nature,
        evidence: "第三方结构化记录的招生方式/评价字段明确出现公办、公立、民办或私立；不依据校名推断。",
      };
      if (apply && nature) {
        const result = await client.query(
          `UPDATE public.schools
           SET school_nature = $1::school_nature,
               attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{third_party_school_nature}', $2::jsonb, true),
               updated_at = now()
           WHERE id = $3 AND school_nature IS NULL
           RETURNING id`,
          [nature, JSON.stringify(raw), row.school_id],
        );
        updated += result.rowCount ?? 0;
        if (result.rowCount) {
          await client.query(
            `INSERT INTO public.web_data_source(
               school_id, source_type, source_name, source_url, source_title,
               source_date, evidence, confidence, raw, fetched_at, created_at, updated_at
             ) VALUES ($1, 'third_party_school_nature', $2, 'https://xuequzhushou.cn/', $3, $4, $5, 'medium', $6::jsonb, now(), now(), now())
             ON CONFLICT (school_id, source_url, source_type)
             DO UPDATE SET source_title=excluded.source_title, source_date=excluded.source_date,
                           evidence=excluded.evidence, confidence=excluded.confidence,
                           raw=excluded.raw, fetched_at=now(), updated_at=now()`,
            [row.school_id, row.source_name, `${row.school_name} ${row.source_year ?? ""}办学性质（第三方）`, row.source_year ? String(row.source_year) : null, "第三方学区助手资料明确标注办学性质，仅作为数据补充，不代表官方认定。", JSON.stringify(raw)],
          );
        }
      }
      actions.push({ schoolId: row.school_id, schoolName: row.school_name, district: row.district, sourceId: row.source_id, nature, action, source: raw });
    }
    writeFileSync(path.join(reportDir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: rows.length, planned: actions.filter((item) => item.nature).length, updated, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: rows.length, planned: actions.filter((item) => item.nature).length, updated, reportDir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
