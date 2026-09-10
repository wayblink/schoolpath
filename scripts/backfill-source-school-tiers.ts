/**
 * Fill placeholder school tiers from uniquely matched catalog.source_schools rows.
 *
 * This source is third-party evidence (学区助手), not an official ranking. The
 * migration never overwrites an existing valid tier and records provenance in
 * both schools.attrs and web_data_source. Dry-run is the default; pass --apply.
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");

const TIER_LABELS = new Map<number, string>([
  [1, "一梯队"],
  [2, "二梯队"],
  [3, "三梯队"],
  [4, "四梯队"],
]);

export function normalizeTier(value: unknown): string | null {
  const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isInteger(number) ? TIER_LABELS.get(number) ?? null : null;
}

export function shouldFillTier(value: string | null | undefined): boolean {
  return value == null || value.trim() === "" || value.trim() === "未入榜/待补充";
}

type Candidate = {
  school_id: number;
  school_name: string;
  district: string;
  current_tier: string | null;
  source_id: number;
  source_key: string;
  source_name: string;
  source_url: string | null;
  source_year: number | null;
  source_tier: number | null;
  source_note: string | null;
};

async function main() {
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
            AND tier BETWEEN 1 AND 4
          GROUP BY public_school_id
          HAVING count(*) = 1
        )
        SELECT s.id AS school_id, s.name AS school_name, s.district,
               s.tier AS current_tier,
               ss.id AS source_id, ss.source_key, ss.source_name, ss.source_url,
               ss.source_year, ss.tier AS source_tier,
               nullif(btrim(ss.attrs->>'sourceNote'), '') AS source_note
        FROM unique_source us
        JOIN catalog.source_schools ss ON ss.id = us.source_id
        JOIN public.schools s ON s.id = ss.public_school_id
        WHERE (s.tier IS NULL OR btrim(s.tier) = '' OR s.tier = '未入榜/待补充')
        ORDER BY s.district, s.id
      `)
    ).rows;

    const actions: Array<Record<string, unknown>> = [];
    let updated = 0;
    for (const candidate of candidates) {
      const tier = normalizeTier(candidate.source_tier);
      if (!tier) {
        actions.push({ ...candidate, action: "skip-invalid-source-tier" });
        continue;
      }
      const raw = {
        migration: "source_school_tier_backfill",
        source_name: candidate.source_name,
        source_url: candidate.source_url,
        source_year: candidate.source_year,
        source_key: candidate.source_key,
        source_id: candidate.source_id,
        school_name: candidate.school_name,
        district: candidate.district,
        source_tier: candidate.source_tier,
        normalized_tier: tier,
        source_note: candidate.source_note,
        evidence: "学区助手已匹配来源记录的梯队字段；仅作为第三方梯队参考，不代表官方排名。",
      };
      if (apply) {
        const result = await client.query(
          `UPDATE public.schools
           SET tier = $1,
               attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{schoolTierSource}', $2::jsonb, true),
               updated_at = now()
           WHERE id = $3
             AND (tier IS NULL OR btrim(tier) = '' OR tier = '未入榜/待补充')
           RETURNING id`,
          [tier, JSON.stringify(raw), candidate.school_id],
        );
        updated += result.rowCount ?? 0;
        if (result.rowCount) {
          await client.query(
            `INSERT INTO public.web_data_source(
               school_id, source_type, source_name, source_url, source_title,
               source_date, evidence, confidence, raw, fetched_at, created_at, updated_at
             ) VALUES ($1, 'third_party_tier', $2, $3, $4, $5, $6, 'medium', $7::jsonb, now(), now(), now())
             ON CONFLICT (school_id, source_url, source_type)
             DO UPDATE SET source_name = excluded.source_name,
                           source_title = excluded.source_title,
                           source_date = excluded.source_date,
                           evidence = excluded.evidence,
                           confidence = excluded.confidence,
                           raw = excluded.raw,
                           fetched_at = now(),
                           updated_at = now()`,
            [
              candidate.school_id,
              candidate.source_name,
              candidate.source_url ?? "https://xuequzhushou.cn/",
              `${candidate.school_name} 2026梯队资料（第三方）`,
              candidate.source_year ? String(candidate.source_year) : "2026",
              "学区助手资料明确给出梯队，仅作为第三方参考，不代表官方排名。",
              JSON.stringify(raw),
            ],
          );
        }
      }
      actions.push({ schoolId: candidate.school_id, schoolName: candidate.school_name, district: candidate.district, sourceId: candidate.source_id, sourceTier: candidate.source_tier, tier, action: apply ? "updated" : "dry-run" });
    }

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: candidates.length, planned: actions.filter((action) => action.tier).length, updated, actions }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("backfill-source-school-tiers.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
