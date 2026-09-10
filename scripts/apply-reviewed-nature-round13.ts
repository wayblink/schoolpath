/** Apply a small, explicitly reviewed official school-nature backfill. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const reportDir = path.join(process.cwd(), ".tmp", "reviewed-nature-round13", stamp);

type Review = {
  schoolId: number;
  schoolName: string;
  district: string;
  matchedName: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
  evidence: string;
  raw: Record<string, unknown>;
};

const reviews: Review[] = [
  {
    schoolId: 6159,
    schoolName: "清流中学",
    district: "浦东",
    matchedName: "上海市清流中学（上南校区、昌里校区）",
    sourceTitle: "2025年浦东新区义务教育阶段学校招生入学信息公示（初中）",
    sourceUrl: "https://www.shanghai.gov.cn/pdxqywjy/20250507/57ff6e427b4c4846b03a5d414c820531.html",
    sourceDate: "2025-05-07",
    evidence: "官方初中招生公示同时列出上海市清流中学上南校区（上南路801号）和昌里校区（昌里路85号），两条记录办学性质均为公办；数据库简称“清流中学”与两校区唯一对应。仅补办学性质，不覆盖现有地址。",
    raw: {
      migration: "reviewed_official_nature_round13",
      school_id: 6159,
      school_name: "清流中学",
      matched_name: "上海市清流中学（上南校区、昌里校区）",
      nature: "公办",
      campuses: [
        { name: "上南校区", address: "上南路801号", nature: "公办" },
        { name: "昌里校区", address: "昌里路85号", nature: "公办" },
      ],
    },
  },
  {
    schoolId: 6172,
    schoolName: "明强小学(西校)",
    district: "闵行",
    matchedName: "闵行区七宝镇明强小学西校区",
    sourceTitle: "2025年闵行区义务教育阶段学校(小学）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
    sourceUrl: "https://www.shanghai.gov.cn/mhqywjy/20250407/a8a110c367464ede8f98ec270dee505f.html",
    sourceDate: "2025-04-07",
    evidence: "官方小学基本情况公示唯一列出“闵行区七宝镇明强小学西校区”（华茂路108号），办学性质为公办；数据库“明强小学(西校)”与该校区名称唯一匹配。仅补办学性质，不覆盖现有地址。",
    raw: {
      migration: "reviewed_official_nature_round13",
      school_id: 6172,
      school_name: "明强小学(西校)",
      matched_name: "闵行区七宝镇明强小学西校区",
      nature: "公办",
      source_address: "华茂路108号",
    },
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
      const current = await client.query<{ id: number; name: string; district: string; school_nature: string | null }>(
        "SELECT id,name,district,school_nature FROM public.schools WHERE id=$1",
        [review.schoolId],
      );
      const row = current.rows[0];
      if (!row) {
        actions.push({ ...review, action: "skip-missing-school" });
        continue;
      }
      if (row.name !== review.schoolName || row.district !== review.district) {
        actions.push({ ...review, action: "skip-entity-mismatch", current: row });
        continue;
      }
      if (row.school_nature) {
        actions.push({ ...review, action: "skip-nonblank-nature", currentNature: row.school_nature });
        continue;
      }
      if (!apply) {
        actions.push({ ...review, action: "dry-run-update" });
        continue;
      }
      const update = await client.query(
        "UPDATE public.schools SET school_nature='公立'::school_nature, attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_reviewed_nature}',$1::jsonb,true), updated_at=now() WHERE id=$2 AND name=$3 AND district=$4 AND school_nature IS NULL",
        [JSON.stringify(review.raw), review.schoolId, review.schoolName, review.district],
      );
      updated += update.rowCount ?? 0;
      const source = await client.query(
        "INSERT INTO public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at) VALUES($1,'official_school_info','上海市各区教育局/政府公开信息',$2,$3,$4,$5,'high',$6::jsonb,now(),now(),now()) ON CONFLICT(school_id,source_url,source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=now(),updated_at=now() RETURNING id",
        [review.schoolId, review.sourceUrl, review.sourceTitle, review.sourceDate, review.evidence, JSON.stringify(review.raw)],
      );
      sourcesUpserted += source.rowCount ?? 0;
      actions.push({ ...review, action: "update" });
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
