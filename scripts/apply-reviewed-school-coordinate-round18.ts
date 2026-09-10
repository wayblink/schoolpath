/** Apply one manually reviewed exact-address school map coordinate from round 18. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const reportDir = path.join(process.cwd(), ".tmp", "reviewed-school-coordinate-round18", stamp);

export const reviews = [
  {
    schoolId: 5588,
    schoolName: "上海市西延安中学",
    district: "长宁",
    type: "middle" as const,
    address: "清池路211号",
    poiName: "上海市延安中学(西校)",
    poiUid: "5b25f44679165fe811293591",
    sourceUrl:
      "https://map.baidu.com/poi/%E4%B8%8A%E6%B5%B7%E5%B8%82%E5%BB%B6%E5%AE%89%E4%B8%AD%E5%AD%A6(%E8%A5%BF%E6%A0%A1)/@13511169.125,3639946,19z?uid=5b25f44679165fe811293591&querytype=detailConInfo",
    sourceDate: "2026-08-14",
    lat: 31.220518484213088,
    lng: 121.36541952186718,
    evidence:
      "百度地图详情页 POI 展示名为“上海市延安中学(西校)”，详情正文明确写出“上海市西延安中学分部位于清池路211号”，地址页同样定位清池路211号；长宁区官方学校信息确认数据库实体名称和地址。展示别名与官方实体闭合，仅补空坐标，不改学校名称。",
  },
];

async function main() {
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Array<Record<string, unknown>> = [];
  let updated = 0;
  let sourcesUpserted = 0;
  try {
    await client.query("BEGIN");
    for (const review of reviews) {
      const row = (
        await client.query<{ id: number; name: string; district: string; type: string; address: string | null; lat: number | null; lng: number | null }>(
          "SELECT id,name,district,type,address,lat,lng FROM public.schools WHERE id=$1",
          [review.schoolId],
        )
      ).rows[0];
      if (!row) {
        actions.push({ ...review, action: "skip-missing-school" });
        continue;
      }
      if (row.name !== review.schoolName || row.district !== review.district || row.type !== review.type || row.address !== review.address) {
        actions.push({ ...review, action: "skip-entity-mismatch", current: row });
        continue;
      }
      const fillCoordinates = row.lat == null && row.lng == null;
      const raw = { migration: "reviewed-school-coordinate-round18", ...review, coordinate_source: "baidu_detail_url_mercator_to_gcj02" };
      if (apply && fillCoordinates) {
        const result = await client.query(
          `UPDATE public.schools SET lat=$1,lng=$2,attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{reviewed_school_coordinate_source}',$3::jsonb,true),updated_at=now()
           WHERE id=$4 AND name=$5 AND district=$6 AND type=$7::school_type AND address=$8 AND lat IS NULL AND lng IS NULL`,
          [review.lat, review.lng, JSON.stringify(raw), review.schoolId, review.schoolName, review.district, review.type, review.address],
        );
        updated += result.rowCount ?? 0;
        if (result.rowCount) {
          const source = await client.query(
            `INSERT INTO public.web_data_source (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at)
             VALUES ($1,'map','百度地图',$2,$3,$4,$5,'high',$6::jsonb,now(),now(),now())
             ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=now(),updated_at=now()
             RETURNING id`,
            [review.schoolId, review.sourceUrl, `${review.poiName}（学校坐标）`, review.sourceDate, review.evidence, JSON.stringify(raw)],
          );
          sourcesUpserted += source.rowCount ?? 0;
        }
      }
      actions.push({ ...review, action: apply ? (fillCoordinates ? "updated" : "skip-existing-coordinates") : "dry-run", fillCoordinates });
    }
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    const report = path.join(reportDir, apply ? "applied.json" : "dry-run.json");
    writeFileSync(report, JSON.stringify({ mode: apply ? "apply" : "dry-run", updated, sourcesUpserted, actions }, null, 2), "utf8");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", reviewed: reviews.length, updated, sourcesUpserted, report }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
