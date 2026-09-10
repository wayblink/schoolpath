/** Apply one manually reviewed, exact-name/address school map coordinate. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const reportDir = path.join(process.cwd(), ".tmp", "reviewed-school-coordinate-round16", stamp);

type Review = {
  schoolId: number;
  schoolName: string;
  district: string;
  type: "middle";
  address: string;
  poiName: string;
  poiUid: string;
  sourceUrl: string;
  sourceDate: string;
  lat: number;
  lng: number;
  evidence: string;
};

export const reviews: Review[] = [
  {
    schoolId: 4706,
    schoolName: "师三实验中学",
    district: "徐汇",
    type: "middle",
    address: "三江路310号",
    poiName: "上海师大第三附属实验学校",
    poiUid: "d4502a1378a89011e01103e4",
    sourceUrl:
      "https://map.baidu.com/poi/%E4%B8%8A%E6%B5%B7%E5%B8%88%E5%A4%A7%E7%AC%AC%E4%B8%89%E9%99%84%E5%B1%9E%E5%AE%9E%E9%AA%8C%E5%AD%A6%E6%A0%A1/@13519290.97618951,3632474.4255994214,18.99z?uid=d4502a1378a89011e01103e4&querytype=detailConInfo",
    sourceDate: "2026-08-14",
    // Baidu detail URL mercator converted to GCJ-02 by the existing browser-ingest converter.
    lat: 31.163659111058575,
    lng: 121.43802716776578,
    evidence:
      "百度地图真实页面唯一 POI 名称为“上海师大第三附属实验学校”，类型为九年一贯制学校，地址为上海市徐汇区三江路310号；徐汇区官方学校公示和本地招生实体映射确认其对应 canonical 行“师三实验中学”。仅补空坐标，保留地图 UID 和官方实体来源。",
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
        await client.query<{
          id: number;
          name: string;
          district: string;
          type: string;
          address: string | null;
          lat: number | null;
          lng: number | null;
          attrs: Record<string, unknown> | null;
        }>(
          "SELECT id,name,district,type,address,lat,lng,attrs FROM public.schools WHERE id=$1",
          [review.schoolId],
        )
      ).rows[0];
      if (!row) {
        actions.push({ ...review, action: "skip-missing-school" });
        continue;
      }
      if (
        row.name !== review.schoolName ||
        row.district !== review.district ||
        row.type !== review.type ||
        row.address !== review.address
      ) {
        actions.push({ ...review, action: "skip-entity-mismatch", current: row });
        continue;
      }
      const fillCoordinates = row.lat == null && row.lng == null;
      const raw = {
        migration: "reviewed-school-coordinate-round16",
        school_id: review.schoolId,
        school_name: review.schoolName,
        district: review.district,
        type: review.type,
        address: review.address,
        poi_name: review.poiName,
        poi_uid: review.poiUid,
        source_url: review.sourceUrl,
        coordinate_source: "baidu_detail_url_mercator_to_gcj02",
        lat: review.lat,
        lng: review.lng,
        evidence: review.evidence,
      };
      if (apply && fillCoordinates) {
        const result = await client.query(
          `UPDATE public.schools
              SET lat=$1,lng=$2,
                  attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{reviewed_school_coordinate_source}',$3::jsonb,true),
                  updated_at=now()
            WHERE id=$4 AND name=$5 AND district=$6 AND type=$7::school_type
              AND address=$8 AND lat IS NULL AND lng IS NULL`,
          [review.lat, review.lng, JSON.stringify(raw), review.schoolId, review.schoolName, review.district, review.type, review.address],
        );
        updated += result.rowCount ?? 0;
        if (result.rowCount) {
          const source = await client.query(
            `INSERT INTO public.web_data_source
              (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at)
             VALUES ($1,'map','百度地图',$2,$3,$4,$5,'high',$6::jsonb,now(),now(),now())
             ON CONFLICT (school_id,source_url,source_type)
             DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,
                           evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,
                           fetched_at=now(),updated_at=now()
             RETURNING id`,
            [review.schoolId, review.sourceUrl, `${review.poiName}（学校坐标）`, review.sourceDate, review.evidence, JSON.stringify(raw)],
          );
          sourcesUpserted += source.rowCount ?? 0;
        }
      }
      actions.push({ ...review, action: apply ? (fillCoordinates ? "updated" : "skip-existing-coordinates") : "dry-run", fillCoordinates });
    }
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
