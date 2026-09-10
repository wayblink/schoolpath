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
const reportDir = path.join(process.cwd(), ".tmp", "reviewed-school-sources-round15", stamp);

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
  enrollmentNote?: string;
};

const reviews: Review[] = [
  {
    schoolId: 4667,
    schoolName: "同济实验学校",
    district: "嘉定",
    type: "middle",
    matchedName: "同济大学附属嘉定实验中学",
    address: "上海市嘉定区米夏路99号",
    nature: "公立",
    alias: "同济大学附属嘉定实验中学",
    sourceTitle: "2025年嘉定区义务教育阶段公办学校基本情况",
    sourceUrl: "https://www.shanghai.gov.cn/cmsres/36/363881f703f146b6b50547142c3255e4/0e579ab9fa85681dd7fc712bc74f99a6.pdf",
    sourceDate: "2025-01-01",
    evidence: "嘉定区教育局官方公办学校基本情况表明确列出“同济大学附属嘉定实验中学”，学段为初中、性质为公办、地址为上海市嘉定区米夏路99号；canonical 行为同区同学段的“同济实验学校”，仅登记正式别名和来源。现有地址和坐标来自独立地图记录，本轮不覆盖。",
  },
  {
    schoolId: 5411,
    schoolName: "奉贤实验中学",
    district: "奉贤",
    type: "middle",
    matchedName: "上海外国语大学附属奉贤实验中学",
    address: "金海街道广丰路446号",
    nature: "公立",
    alias: "上海外国语大学附属奉贤实验中学",
    sourceTitle: "2024年奉贤区教育单位学校规模、设施、师资基本情况",
    sourceUrl: "https://www.shanghai.gov.cn/fxqywjy/20241014/b343793a3ee34754bd04c128c0c69ac1.html",
    sourceDate: "2024-10-14",
    evidence: "奉贤区教育局官方学校规模公示明确列出“上海外国语大学附属奉贤实验中学”，类型为公办初中，地址为金海街道广丰路446号；canonical 行为同区同学段同地址的“奉贤实验中学”，仅补空性质、正式别名和来源。",
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
        enrollment_note: string | null;
        aliases: string[] | null;
      }>(
        "SELECT id,name,district,type,address,school_nature,enrollment_note,aliases FROM public.schools WHERE id=$1",
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
        migration: "manual-entity-review-round15",
        district: review.district,
        school_name_at_review: review.schoolName,
        matched_name: review.matchedName,
        stage: review.type,
        address: review.address,
        nature: review.nature,
        alias: review.alias,
        source_title: review.sourceTitle,
        source_url: review.sourceUrl,
        evidence_basis: "official-source-plus-local-entity-match",
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
         VALUES ($1,'official_school_info','上海市人民政府/区教育局公开信息',$2,$3,$4,$5,'high',$6::jsonb,now(),now(),now())
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

