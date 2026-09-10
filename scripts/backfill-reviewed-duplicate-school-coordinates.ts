/**
 * Fill coordinates for a reviewed duplicate school row.
 *
 * Dry-run is the default; pass --apply to commit. The allowlist is deliberately
 * small and requires the source and target rows to retain their reviewed
 * district, stage, name, and address identity before copying only empty
 * coordinates.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");

export type ReviewedCoordinateCopy = {
  sourceId: number;
  targetId: number;
  district: string;
  type: "primary" | "middle" | "nine_year";
  name: string;
  address: string;
  reason: string;
};

/** Reviewed as the same school entity; do not broaden without a new review. */
export const REVIEWED_COPIES: ReviewedCoordinateCopy[] = [
  {
    sourceId: 3912,
    targetId: 5638,
    district: "闵行",
    type: "middle",
    name: "上海中医药大学附属闵行晶城中学",
    address: "朱行路16号",
    reason: "同区、同学段、官方规范全称和地址完全一致；5638 是缺坐标的重复导入行，3912 保留完整学校来源和坐标。",
  },
];

type School = {
  id: number;
  name: string;
  district: string;
  type: ReviewedCoordinateCopy["type"];
  address: string | null;
  lat: number | null;
  lng: number | null;
  attrs: Record<string, unknown> | null;
};

export function eligibleCoordinateCopy(source: School, target: School, review: ReviewedCoordinateCopy) {
  return Boolean(
    source.id === review.sourceId &&
      target.id === review.targetId &&
      source.district === review.district &&
      target.district === review.district &&
      source.type === review.type &&
      target.type === review.type &&
      source.name === review.name &&
      target.name === review.name &&
      source.address === review.address &&
      target.address === review.address &&
      source.lat != null &&
      source.lng != null &&
      target.lat == null &&
      target.lng == null
  );
}

async function main() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const reportDir = path.join(process.cwd(), ".tmp", "reviewed-duplicate-school-coordinates", stamp);
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Array<Record<string, unknown>> = [];
  let updated = 0;

  try {
    await client.query("BEGIN");
    for (const review of REVIEWED_COPIES) {
      const rows = (
        await client.query<School>(
          `SELECT id,name,district,type,address,lat,lng,attrs
             FROM public.schools
            WHERE id = ANY($1::int[])
            ORDER BY id
            FOR UPDATE`,
          [[review.sourceId, review.targetId]],
        )
      ).rows;
      const source = rows.find((row) => row.id === review.sourceId);
      const target = rows.find((row) => row.id === review.targetId);
      const eligible = Boolean(source && target && eligibleCoordinateCopy(source, target, review));
      if (!eligible || !source || !target) {
        actions.push({ review, action: "skip", reason: !source || !target ? "missing-row" : "identity-or-null-guard-failed", source, target });
        continue;
      }

      const evidence = {
        migration: "reviewed_duplicate_school_coordinate_backfill",
        source_school_id: source.id,
        target_school_id: target.id,
        school_name: review.name,
        district: review.district,
        type: review.type,
        address: review.address,
        copied_lat: source.lat,
        copied_lng: source.lng,
        review_reason: review.reason,
        evidence: "仅从已审阅的一一对应同实体行复制坐标；目标其他字段不变。",
        reviewed_at: new Date().toISOString(),
      };
      const attrs = { ...(target.attrs ?? {}), reviewed_duplicate_coordinate_source: evidence };
      const result = await client.query(
        `UPDATE public.schools
            SET lat = $1, lng = $2, attrs = $3::jsonb, updated_at = now()
          WHERE id = $4 AND name = $5 AND district = $6 AND type = $7
            AND address = $8 AND lat IS NULL AND lng IS NULL
          RETURNING id`,
        [source.lat, source.lng, JSON.stringify(attrs), target.id, review.name, review.district, review.type, review.address],
      );
      updated += result.rowCount ?? 0;
      if (result.rowCount) {
        await client.query(
          `INSERT INTO public.web_data_source(
             school_id,source_type,source_name,source_url,source_title,source_date,
             evidence,confidence,raw,fetched_at,created_at,updated_at
           ) VALUES ($1,'reviewed_duplicate_coordinate','内部实体复核',$2,$3,$4,$5,'high',$6::jsonb,now(),now(),now())
           ON CONFLICT (school_id,source_url,source_type)
           DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,
                         evidence=excluded.evidence,confidence=excluded.confidence,
                         raw=excluded.raw,fetched_at=now(),updated_at=now()`,
          [
            target.id,
            `https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html`,
            `同实体复核：${review.name} 坐标补全`,
            "2025-04-07",
            review.reason,
            JSON.stringify(evidence),
          ],
        );
      }
      actions.push({ review, action: apply ? "updated" : "dry-run", updated: result.rowCount ?? 0, source, target: { ...target, lat: source.lat, lng: source.lng, attrs } });
    }

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  const report = path.join(reportDir, apply ? "applied.json" : "dry-run.json");
  writeFileSync(report, JSON.stringify({ mode: apply ? "apply" : "dry-run", reviewed: REVIEWED_COPIES.length, updated, actions }, null, 2), "utf8");
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", reviewed: REVIEWED_COPIES.length, updated, report }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
