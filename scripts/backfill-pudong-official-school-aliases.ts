/**
 * Add only reviewed official 2026 Pudong source spellings as school aliases.
 *
 * This is deliberately narrow: every target id, stage, address and alias was
 * checked against the current public school row before this script was written.
 * It never merges, deletes, renames, or overwrites scalar school fields.
 * Default is dry-run; pass --apply to commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

type SchoolType = "primary" | "middle";
type AliasReview = {
  schoolId: number;
  name: string;
  type: SchoolType;
  address: string;
  aliases: string[];
  sourceName: string;
  sourceUrl: string;
  sourceYear: number;
  evidence: string;
};

export const REVIEWED_ALIASES: AliasReview[] = [
  {
    schoolId: 3776,
    name: "上海交通大学附属浦东实验中学",
    type: "middle",
    address: "峨山路638号",
    aliases: ["上海交通大学附属中学浦东实验学校"],
    sourceName: "official_pudong_middle_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354040.html",
    sourceYear: 2026,
    evidence: "2026浦东官方初中招生表使用‘上海交通大学附属中学浦东实验学校’；现有浦东同学段学校行的官方地址为峨山路638号，且已有2025官方招生信息将该地址对应为‘上海交通大学附属浦东实验中学’。",
  },
  {
    schoolId: 6413,
    name: "上海市三墩学校（东部校区）",
    type: "primary",
    address: "三宣公路245号",
    aliases: ["上海市三墩学校"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘上海市三墩学校’；2025官方小学信息公示同学段唯一对应校区为东部校区，地址三宣公路245号，初中西部校区为另一学段实体。",
  },
  {
    schoolId: 6415,
    name: "上海市实验学校附属光明学校（东校区）",
    type: "primary",
    address: "千汇路751弄1号",
    aliases: ["上海市实验学校附属光明学校（分校）"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘上海市实验学校附属光明学校（分校）’；2025官方小学信息公示同地址正式名称为东校区，初中总校为另一学段实体。",
  },
  {
    schoolId: 6411,
    name: "上海市川沙中学南校（川环南路校区）",
    type: "primary",
    address: "川环南路1295号",
    aliases: ["上海市川沙中学南校（北校区）"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘上海市川沙中学南校（北校区）’；2025官方小学信息公示同地址正式名称为川环南路校区，初中平川路校区为另一学段实体。",
  },
  {
    schoolId: 6412,
    name: "上海师范大学附属秋萍学校",
    type: "primary",
    address: "芦云路5号",
    aliases: ["上海师范大学附属浦东秋萍学校"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘上海师范大学附属浦东秋萍学校’；2025官方小学信息公示同地址正式名称为上海师范大学附属秋萍学校。",
  },
  {
    schoolId: 3730,
    name: "上海师范大学附属秋萍学校",
    type: "middle",
    address: "芦云路5号",
    aliases: ["上海师范大学附属浦东秋萍学校"],
    sourceName: "official_pudong_middle_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354040.html",
    sourceYear: 2026,
    evidence: "2026浦东官方初中招生表使用‘上海师范大学附属浦东秋萍学校’；2025官方初中信息公示同地址正式名称为上海师范大学附属秋萍学校。",
  },
  {
    schoolId: 6414,
    name: "上海市浦东新区进才万祥学校（小学部校区）",
    type: "primary",
    address: "宝悦路55号",
    aliases: ["上海市浦东新区进才万祥学校"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘上海市浦东新区进才万祥学校’；2025官方小学信息公示同地址正式名称为小学部校区，初中万耘路校区为另一学段实体。",
  },
  {
    schoolId: 6361,
    name: "上海交通大学附属浦东实验小学北校（南泉校区）",
    type: "primary",
    address: "浦建路207弄58号",
    aliases: ["上海交通大学附属浦东实验小学（南泉校区）"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘上海交通大学附属浦东实验小学（南泉校区）’；2025官方小学信息公示同地址正式名称为‘上海交通大学附属浦东实验小学北校（南泉校区）’，为同学段唯一校址实体。",
  },
  {
    schoolId: 3713,
    name: "上海市浦东新区建平临港中学",
    type: "middle",
    address: "紫荆花路299号",
    aliases: ["上海市浦东新区建平临港中学（紫荆校区）"],
    sourceName: "official_pudong_middle_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354040.html",
    sourceYear: 2026,
    evidence: "2026浦东官方初中招生表使用‘上海市浦东新区建平临港中学（紫荆校区）’；2025官方初中信息公示同地址正式名称为建平临港中学，地址紫荆花路299号。古棕校区为另一校址，未并入本实体。",
  },
  {
    schoolId: 6380,
    name: "上海市浦东新区高行镇高行小学",
    type: "primary",
    address: "高行街399号",
    aliases: ["上海市浦东新区高行小学"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘上海市浦东新区高行小学’；2025官方学校名录同区同学段地址为高行街399号。",
  },
  {
    schoolId: 6376,
    name: "上海市浦东新区华高小学（东靖路校区）",
    type: "primary",
    address: "高建路40号",
    aliases: ["上海市浦东新区华高小学（东靖校区）"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表将‘东靖校区’列为招生学校；2025官方名录同地址正式名称为‘东靖路校区’。",
  },
  {
    schoolId: 6375,
    name: "上海市浦东新区华高小学（巨峰路校区）",
    type: "primary",
    address: "巨峰路997弄华高二村73号",
    aliases: ["上海市浦东新区华高小学（巨峰校区）"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘巨峰校区’；2025官方名录同地址正式名称为‘巨峰路校区’。",
  },
  {
    schoolId: 6392,
    name: "上海市浦东新区龚路中心小学",
    type: "primary",
    address: "龚华路69号",
    aliases: ["上海市浦东新区龚路中心小学（东校区）"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘龚路中心小学（东校区）’；2025官方名录同地址正式名称省略东校区括号。",
  },
  {
    schoolId: 6405,
    name: "上海市浦东新区曹路打一小学",
    type: "primary",
    address: "海鹊路58号",
    aliases: ["上海市浦东新区曹路打一小学（东校区）"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表使用‘曹路打一小学（东校区）’；2025官方名录同地址正式名称为‘曹路打一小学’。",
  },
  {
    schoolId: 6419,
    name: "上海中医药大学附属浦东鹤沙学校（沪南校区）",
    type: "primary",
    address: "沪南公路5248号",
    aliases: ["上海中医药大学附属浦东鹤沙学校（小学部）"],
    sourceName: "official_pudong_primary_2026",
    sourceUrl: "https://www.pudong.gov.cn/zwgk/ywjy-jyjzdgz/2026/97/354039.html",
    sourceYear: 2026,
    evidence: "2026浦东官方小学招生表将该校标为‘小学部’；2025官方名录同地址为沪南校区，学段均为小学。",
  },
];

type SchoolRow = { id: number; name: string; district: string; type: SchoolType; address: string | null; aliases: string[] | null; attrs: Record<string, unknown> | null };

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "backfill-pudong-official-school-aliases", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dir = outputDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Array<Record<string, unknown>> = [];
  try {
    await client.query("BEGIN");
    for (const item of REVIEWED_ALIASES) {
      const result = await client.query<SchoolRow>(
        `SELECT id,name,district,type,address,aliases,attrs FROM public.schools WHERE id=$1 FOR UPDATE`,
        [item.schoolId],
      );
      const target = result.rows[0];
      if (!target) throw new Error(`missing school id=${item.schoolId}`);
      if (target.district !== "浦东" || target.type !== item.type || target.name !== item.name || target.address !== item.address) {
        throw new Error(`identity guard failed for id=${item.schoolId}: ${target.district}/${target.type}/${target.name}/${target.address}`);
      }
      const aliases = Array.from(new Set([...(target.aliases ?? []), ...item.aliases])).filter((alias) => alias !== target.name);
      const sourcePayload = {
        source_type: "official_school_info",
        source_name: item.sourceName,
        source_url: item.sourceUrl,
        source_year: item.sourceYear,
        evidence: item.evidence,
        matched_name: item.aliases[0],
        applied_at: new Date().toISOString(),
      };
      const attrs = {
        ...(target.attrs ?? {}),
        official_alias_sources: [
          ...((Array.isArray(target.attrs?.official_alias_sources) ? target.attrs?.official_alias_sources : []) as unknown[]),
          sourcePayload,
        ].slice(-10),
      };
      actions.push({ schoolId: item.schoolId, before: target, aliases, source: sourcePayload, action: aliases.length === (target.aliases ?? []).length ? "skip-existing" : apply ? "update" : "dry-run-update" });
      if (apply && aliases.length !== (target.aliases ?? []).length) {
        await client.query(`UPDATE public.schools SET aliases=$1::text[],attrs=$2::jsonb,updated_at=now() WHERE id=$3`, [aliases, JSON.stringify(attrs), item.schoolId]);
      }
    }
    writeFileSync(path.join(dir, apply ? "applied.json" : "dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", reviewed: REVIEWED_ALIASES.length, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", reviewed: REVIEWED_ALIASES.length, updated: actions.filter((a) => a.action === "update").length, report: path.join(dir, apply ? "applied.json" : "dry-run.json") }, null, 2));
    console.log("No deletes, merges, renames, or scalar overwrites were performed.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("backfill-pudong-official-school-aliases.ts")) main().catch((error) => { console.error(error); process.exitCode = 1; });
