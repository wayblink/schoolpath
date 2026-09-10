/** Copy a single unambiguous tier across exact duplicate school entities.
 *
 * This is an identity repair, not a ranking inference: same district, stage,
 * and exact name only. Conflicting source tiers are skipped. Dry-run default.
 */
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const PLACEHOLDERS = new Set([null, "", "未入榜/待补充", "待补充"]);

export type DuplicateTierSchool = { id: number; name: string; district: string; type: string; tier: string | null; attrs: Record<string, unknown> | null };
export type DuplicateTierPlan = { target: DuplicateTierSchool; source: DuplicateTierSchool; tier: string };

export function planDuplicateTierFills(schools: DuplicateTierSchool[]): DuplicateTierPlan[] {
  const groups = new Map<string, DuplicateTierSchool[]>();
  for (const school of schools) {
    const key = `${school.district}\u0000${school.type}\u0000${school.name}`;
    const group = groups.get(key) ?? [];
    group.push(school);
    groups.set(key, group);
  }
  const plans: DuplicateTierPlan[] = [];
  for (const group of groups.values()) {
    const sources = group.filter((school) => !PLACEHOLDERS.has(school.tier));
    const tiers = [...new Set(sources.map((school) => school.tier as string))];
    if (tiers.length !== 1) continue;
    const source = sources[0];
    if (!source) continue;
    for (const target of group.filter((school) => PLACEHOLDERS.has(school.tier))) plans.push({ target, source, tier: tiers[0]! });
  }
  return plans.sort((a, b) => a.target.district.localeCompare(b.target.district) || a.target.id - b.target.id);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const schools = (await client.query<DuplicateTierSchool>(`SELECT id,name,district,type::text AS type,tier,attrs FROM public.schools ORDER BY district,id`)).rows;
    const plans = planDuplicateTierFills(schools);
    let updated = 0;
    for (const plan of plans) {
      const sourcePayload = {
        migration: "duplicate_school_tier_backfill",
        source_school_id: plan.source.id,
        source_school_name: plan.source.name,
        source_district: plan.source.district,
        source_type: plan.source.type,
        source_tier: plan.tier,
        source_attrs: plan.source.attrs,
        evidence: "同区同学段同名实体已有唯一非占位梯队；本次仅修复重复实体，不重新评价梯队。",
      };
      if (apply) {
        const attrs = { ...(plan.target.attrs ?? {}), duplicate_school_tier_source: sourcePayload };
        const result = await client.query(`UPDATE public.schools SET tier=$1, attrs=$2::jsonb, updated_at=now() WHERE id=$3 AND name=$4 AND district=$5 AND type=$6::school_type AND (tier IS NULL OR btrim(tier)='' OR tier IN ('未入榜/待补充','待补充'))`, [plan.tier, JSON.stringify(attrs), plan.target.id, plan.target.name, plan.target.district, plan.target.type]);
        if (result.rowCount) {
          updated += result.rowCount;
          await client.query(`INSERT INTO public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at) VALUES($1,'third_party_tier','内部重复实体证据',$2,$3,'2026',$4,'medium',$5::jsonb,now(),now(),now()) ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET evidence=excluded.evidence,raw=excluded.raw,updated_at=now()`, [plan.target.id, `internal://school/${plan.source.id}/tier`, `${plan.target.name} 梯队重复实体补全`, sourcePayload.evidence, JSON.stringify(sourcePayload)]);
        }
      }
    }
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", candidates: plans.length, updated, plans: plans.map((plan) => ({ targetId: plan.target.id, targetName: plan.target.name, district: plan.target.district, type: plan.target.type, sourceId: plan.source.id, tier: plan.tier })) }, null, 2));
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error); process.exitCode = 1; });
