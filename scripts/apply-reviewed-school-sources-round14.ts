/** Apply the next explicitly reviewed official school-source batch. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const reportDir = path.join(process.cwd(), ".tmp", "reviewed-school-sources-round14", stamp);

type Review = {
  schoolId: number;
  schoolName: string;
  district: string;
  type: "middle";
  matchedName: string;
  address: string;
  nature: "公立";
  alias: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
  evidence: string;
};

const reviews: Review[] = [
  {
    schoolId: 4706,
    schoolName: "师三实验中学",
    district: "徐汇",
    type: "middle",
    matchedName: "上海师范大学第三附属实验学校",
    address: "三江路310号",
    nature: "公立",
    alias: "上海师范大学第三附属实验学校",
    sourceTitle: "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表",
    sourceUrl: "https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
    sourceDate: "2025-04-11",
    evidence: "徐汇区教育局官方初中公示明确列出“上海师范大学第三附属实验学校”，学段为初中、办学性质为公办九年一贯制、地址为三江路310号；本地徐汇招生边界数据明确将“上海师范大学第三附属实验学校（初中）”列为“师三实验中学”对应初中，且同区同学段无第二候选。仅补空地址和空性质，保留 canonical 简称。",
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
      const result = await client.query<{
        id: number;
        name: string;
        district: string;
        type: string;
        address: string | null;
        school_nature: string | null;
        aliases: string[] | null;
      }>(
        "SELECT id,name,district,type,address,school_nature,aliases FROM public.schools WHERE id=$1",
        [review.schoolId],
      );
      const row = result.rows[0];
      if (!row) {
        actions.push({ ...review, action: "skip-missing-school" });
        continue;
      }
      if (row.name !== review.schoolName || row.district !== review.district || row.type !== review.type) {
        actions.push({ ...review, action: "skip-entity-mismatch", current: row });
        continue;
      }
      const fillAddress = !row.address?.trim();
      const fillNature = !row.school_nature;
      const addAlias = !(row.aliases ?? []).includes(review.alias);
      const raw = {
        migration: "manual-entity-review-round14",
        district: review.district,
        school_name_at_review: review.schoolName,
        matched_name: review.matchedName,
        stage: review.type,
        address: review.address,
        nature: review.nature,
        alias: review.alias,
        source_title: review.sourceTitle,
        source_url: review.sourceUrl,
        evidence_basis: "official-source-plus-local-boundary-entity-match",
      };
      if (!apply) {
        actions.push({ ...review, action: "dry-run", fillAddress, fillNature, addAlias });
        continue;
      }
      const update = await client.query(
        `UPDATE public.schools
            SET address = CASE WHEN (address IS NULL OR btrim(address)='') THEN $1 ELSE address END,
                school_nature = CASE WHEN school_nature IS NULL THEN $2::school_nature ELSE school_nature END,
                aliases = CASE WHEN NOT ($3 = ANY(coalesce(aliases,'{}'::text[]))) THEN array_append(coalesce(aliases,'{}'::text[]),$3) ELSE aliases END,
                attrs = jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_school_info_source}',$4::jsonb,true),
                updated_at = now()
          WHERE id=$5 AND name=$6 AND district=$7 AND type=$8::school_type
            AND (school_nature IS NULL OR address IS NULL OR btrim(address)='' OR NOT ($3 = ANY(coalesce(aliases,'{}'::text[]))))`,
        [review.address, review.nature, review.alias, JSON.stringify(raw), review.schoolId, review.schoolName, review.district, review.type],
      );
      updated += update.rowCount ?? 0;
      const source = await client.query(
        `INSERT INTO public.web_data_source
          (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at)
         VALUES ($1,'official_school_info','上海市人民政府/徐汇区教育局公开信息',$2,$3,$4,$5,'high',$6::jsonb,now(),now(),now())
         ON CONFLICT (school_id, source_url, source_type)
         DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=now(),updated_at=now()
         RETURNING id`,
        [review.schoolId, review.sourceUrl, review.sourceTitle, review.sourceDate, review.evidence, JSON.stringify(raw)],
      );
      sourcesUpserted += source.rowCount ?? 0;
      actions.push({ ...review, action: "update", fillAddress, fillNature, addAlias });
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
