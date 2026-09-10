/**
 * Apply a small, manually reviewed batch of official school evidence.
 *
 * The batch is deliberately explicit: source rows are tied to a canonical
 * school id after checking district, stage, public name and the official
 * table context. Existing address, coordinates, tier, notes and non-null
 * nature values are never overwritten.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const sourceName = "上海市人民政府/区教育局公开信息";

type Entry = {
  schoolId: number;
  schoolName: string;
  district: string;
  matchedName: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDate: string;
  nature?: "公立" | "私立";
  alias?: string;
  evidence: string;
};

const ENTRIES: Entry[] = [
  {
    schoolId: 4658,
    schoolName: "同济大学附属实验",
    district: "嘉定",
    matchedName: "同济大学附属实验中学",
    sourceUrl: "https://www.shanghai.gov.cn/cmsres/36/363881f703f146b6b50547142c3255e4/0e579ab9fa85681dd7fc712bc74f99a6.pdf",
    sourceTitle: "2025年嘉定区义务教育阶段公办学校基本情况",
    sourceDate: "2025-01-01",
    nature: "公立",
    alias: "同济大学附属实验中学",
    evidence: "嘉定区教育局公办学校基本情况表明确列出“同济大学附属实验中学”，学段为初中、性质为公办、地址为上海市嘉定区安亭镇荣泽路108号；与 canonical 学校同区同学段，现有百度 POI 亦为该正式名称。",
  },
  {
    schoolId: 4610,
    schoolName: "上海市中远实验学校（初中部）",
    district: "普陀",
    matchedName: "上海市中远实验学校",
    sourceUrl: "https://www.shanghai.gov.cn/ptqywjy/20251110/d17caa0f4c8c41d4ba91f0516f53ef12.html",
    sourceTitle: "2025年普陀区义务教育阶段学校教育教学、后勤设施设备和师资配置基本情况表",
    sourceDate: "2025-11-10",
    nature: "公立",
    evidence: "普陀区教育局官方基本情况表明确列出“上海市中远实验学校”，性质为公办九年一贯制学校，地址为远景路801号；canonical 行保留初中部后缀，实体由既有名称规范化记录和同区同地址证据确认。",
  },
  {
    schoolId: 4609,
    schoolName: "上海市晋元高级中学附属学校（初中部）",
    district: "普陀",
    matchedName: "上海市晋元高级中学附属学校（含西校及南校）",
    sourceUrl: "https://www.shanghai.gov.cn/ptqywjy/20251110/d17caa0f4c8c41d4ba91f0516f53ef12.html",
    sourceTitle: "2025年普陀区义务教育阶段学校教育教学、后勤设施设备和师资配置基本情况表",
    sourceDate: "2025-11-10",
    nature: "公立",
    evidence: "普陀区教育局官方基本情况表明确列出“上海市晋元高级中学附属学校（含西校及南校）”，性质为公办九年一贯制学校，并列出四个校区地址；canonical 行是该学校的初中部实体，既有名称规范化记录已确认正式名称，不覆盖现有地址。",
  },
  {
    schoolId: 5635,
    schoolName: "圣华紫竹双语",
    district: "闵行",
    matchedName: "上海民办圣华紫竹双语学校",
    sourceUrl: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
    sourceTitle: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
    sourceDate: "2025-04-07",
    nature: "私立",
    alias: "上海民办圣华紫竹双语学校",
    evidence: "闵行区教育局官方初中和一贯制学校表明确列出“上海民办圣华紫竹双语学校”，性质为民办，地址为紫凤路500号、谈家塘路155-2号；官方缓存记录虽因表格解析标为 primary，但来源标题和原始表格均为初中/一贯制范围，canonical 行为同区同校初中实体。",
  },
  {
    schoolId: 4643,
    schoolName: "上海市市北初级中学",
    district: "静安",
    matchedName: "上海市市北初级中学 / 上海市静安区市北初级中学西校",
    sourceUrl: "https://www.shanghai.gov.cn/jaqywjy/20250407/ba037217144a4d7e8f92f5c5f495704c.html",
    sourceTitle: "2025年静安区义务教育阶段公办学校教育教学设施和师资配置公示表",
    sourceDate: "2025-04-07",
    evidence: "静安区教育局公办学校公示表明确列出“上海市市北初级中学 / 上海市静安区市北初级中学西校”，地址为西藏北路803号；canonical 行为同区同学段正式校名，现有性质已为公立，本批仅登记官方来源。",
  },
];

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const reportDir = path.join(process.cwd(), ".tmp", "round13-official-school-sources", stamp);
  mkdirSync(reportDir, { recursive: true });
  const actions: Array<Record<string, unknown>> = [];
  try {
    await client.query("BEGIN");
    for (const entry of ENTRIES) {
      const schoolResult = await client.query<{
        id: number;
        name: string;
        district: string;
        type: string;
        school_nature: string | null;
        aliases: string[] | null;
      }>(
        "SELECT id,name,district,type,school_nature,aliases FROM public.schools WHERE id=$1",
        [entry.schoolId],
      );
      const school = schoolResult.rows[0];
      if (!school) throw new Error(`school ${entry.schoolId} not found`);
      if (school.district !== entry.district || school.name !== entry.schoolName) {
        throw new Error(`school identity changed for ${entry.schoolId}: ${school.district}/${school.name}`);
      }
      const raw = {
        district: entry.district,
        school: entry.schoolName,
        matched_name: entry.matchedName,
        source_title: entry.sourceTitle,
        source_url: entry.sourceUrl,
        nature: entry.nature ?? null,
        evidence_basis: "manual-entity-review-round13",
      };
      if (apply) {
        await client.query(
          `INSERT INTO public.web_data_source
            (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at)
           VALUES ($1,'official_school_info',$2,$3,$4,$5,$6,'high',$7::jsonb,now(),now())
           ON CONFLICT (school_id,source_url,source_type)
           DO UPDATE SET source_name=excluded.source_name,source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=excluded.fetched_at,updated_at=now()`,
          [entry.schoolId, sourceName, entry.sourceUrl, entry.sourceTitle, entry.sourceDate, entry.evidence, JSON.stringify(raw)],
        );
        if (entry.nature) {
          await client.query(
            "UPDATE public.schools SET school_nature=CASE WHEN school_nature IS NULL THEN $1::school_nature ELSE school_nature END, updated_at=now() WHERE id=$2",
            [entry.nature, entry.schoolId],
          );
        }
        if (entry.alias) {
          await client.query(
            "UPDATE public.schools SET aliases=CASE WHEN NOT ($1 = ANY(coalesce(aliases,'{}'::text[]))) THEN array_append(coalesce(aliases,'{}'::text[]),$1) ELSE aliases END, updated_at=now() WHERE id=$2",
            [entry.alias, entry.schoolId],
          );
        }
      }
      actions.push({
        schoolId: entry.schoolId,
        schoolName: entry.schoolName,
        sourceUrl: entry.sourceUrl,
        action: apply ? "applied" : "dry-run",
        natureBefore: school.school_nature,
        natureAfter: entry.nature ?? school.school_nature,
        aliasAdded: entry.alias ?? null,
      });
    }
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    const report = path.join(reportDir, apply ? "applied.json" : "dry-run.json");
    writeFileSync(report, JSON.stringify({ generatedAt: new Date().toISOString(), mode: apply ? "apply" : "dry-run", actions }, null, 2));
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", entries: ENTRIES.length, sources: ENTRIES.length, report }, null, 2));
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
