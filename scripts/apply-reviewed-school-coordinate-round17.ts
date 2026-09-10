/** Apply manually reviewed exact-address school map coordinates from round 17. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const reportDir = path.join(process.cwd(), ".tmp", "reviewed-school-coordinate-round17", stamp);

type Review = {
  schoolId: number;
  schoolName: string;
  district: string;
  type: "primary" | "middle";
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
    schoolId: 4342,
    schoolName: "上海市宝山区祁连镇中心校",
    district: "宝山",
    type: "primary",
    address: "祁连二村118号",
    poiName: "祁连中心校",
    poiUid: "298d1a58cd808eed3517dc25",
    sourceUrl:
      "https://map.baidu.com/poi/%E7%A5%81%E8%BF%9E%E4%B8%AD%E5%BF%83%E6%A0%A1/@13512716.622451613,3655832.176967741,12.09z?uid=298d1a58cd808eed3517dc25&querytype=detailConInfo",
    sourceDate: "2026-08-14",
    lat: 31.343981332414632,
    lng: 121.378960132264,
    evidence:
      "百度地图详情页 POI 名称为“祁连中心校”，类型为小学，地址为上海市宝山区祁连山路118号；数据库官方招生信息对应同一宝山区小学实体，地址“祁连二村118号”是该校地址别称。仅补空坐标，不改地址字段。",
  },
  {
    schoolId: 5367,
    schoolName: "上海外国语大学松江外国语学校（初中部）",
    district: "松江",
    type: "middle",
    address: "松江区梅家浜路1701号",
    poiName: "上海外国语大学松江外国语学校(中学部)",
    poiUid: "273db708ed45185b82288a1c",
    sourceUrl:
      "https://map.baidu.com/poi/%E4%B8%8A%E6%B5%B7%E5%A4%96%E5%9B%BD%E8%AF%AD%E5%A4%A7%E5%AD%A6%E6%9D%BE%E6%B1%9F%E5%A4%96%E5%9B%BD%E8%AF%AD%E5%AD%A6%E6%A0%A1(%E4%B8%AD%E5%AD%A6%E9%83%A8)/@13495334.769844895,3618253.1573180677,17.47z?uid=273db708ed45185b82288a1c&querytype=detailConInfo",
    sourceDate: "2026-08-14",
    lat: 31.05394723323684,
    lng: 121.22276780858365,
    evidence:
      "百度地图详情页唯一对应“上海外国语大学松江外国语学校(中学部)”POI，类型为初中，地址为梅家浜路1701号；数据库行是同一九年一贯制学校的初中部投影，官方学校公示也确认该地址。仅补空坐标。",
  },
  {
    schoolId: 3806,
    schoolName: "上海市周浦实验学校（瑞阳校区）",
    district: "浦东",
    type: "middle",
    address: "瑞阳路261号",
    poiName: "上海市周浦实验学校(总校)",
    poiUid: "a481bfedea0cdf2d451a32e3",
    sourceUrl:
      "https://map.baidu.com/poi/%E4%B8%8A%E6%B5%B7%E5%B8%82%E5%91%A8%E6%B5%A6%E5%AE%9E%E9%AA%8C%E5%AD%A6%E6%A0%A1(%E6%80%BB%E6%A0%A1)/@13536133.025052344,3626132.3071295517,12.73z?uid=a481bfedea0cdf2d451a32e3&querytype=detailConInfo",
    sourceDate: "2026-08-14",
    lat: 31.114483780994206,
    lng: 121.58936146019184,
    evidence:
      "百度地图结果为上海市周浦实验学校(总校)，地址上海市浦东新区瑞阳路261弄，并显示瑞阳路261号校门；浦东官方学校公示对应“上海市周浦实验学校（瑞阳校区）”，数据库地址为瑞阳路261号。两者指向同一瑞阳校区，仅补空坐标。",
  },
  {
    schoolId: 5629,
    schoolName: "上海市民办文绮中学（初中部）",
    district: "闵行",
    type: "middle",
    address: "江川东路980号",
    poiName: "上海市民办文绮中学-西南门",
    poiUid: "912a7dfe26e8a1ca40afe60b",
    sourceUrl:
      "https://map.baidu.com/poi/%E4%B8%8A%E6%B5%B7%E5%B8%82%E6%B0%91%E5%8A%9E%E6%96%87%E7%BB%AE%E4%B8%AD%E5%AD%A6-%E8%A5%BF%E5%8D%97%E9%97%A8/@13517700.668899836,3612730.3985154782,14.64z?uid=912a7dfe26e8a1ca40afe60b&querytype=detailConInfo",
    sourceDate: "2026-08-14",
    lat: 31.01103415025653,
    lng: 121.4237285043473,
    evidence:
      "百度地图搜索结果列出“上海市民办文绮中学-西南门”，地址为上海市闵行区江川东路980号；官方闵行区学校公示确认数据库实体为民办文绮中学（初中部），地址同为江川东路980号。坐标取学校西南门 POI，仅补空坐标并保留门点证据。",
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
        }>(
          "SELECT id,name,district,type,address,lat,lng FROM public.schools WHERE id=$1",
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
        migration: "reviewed-school-coordinate-round17",
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
