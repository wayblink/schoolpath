/**
 * Fill blank Putuo enrollment notes from the 2025 official Shanghai government
 * admission-plan tables. The source is fetched at run time, parsed as HTML,
 * and written only when a district + stage + normalized school name resolves
 * to one school. Dry-run is the default; pass --apply to commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

export type Stage = "primary" | "middle";
export type PublicPlanRow = { stage: Stage; name: string; plannedClasses: string; raw: string[] };
export type PrivatePlanRow = {
  stage: Stage;
  name: string;
  totalPlan: string;
  category: string;
  condition: string;
  directPlan: string;
  dayPlan: string;
  boardingPlan: string;
  transfer: string;
  raw: string[];
};
export type MatchSchool = { id: number; name: string; type: "primary" | "middle" | "nine_year" };

export const SOURCES = {
  primaryPublic: {
    url: "https://www.shanghai.gov.cn/ptqywjy/20251107/b1decc1fbc224c3da969a16fdcd55b6d.html",
    title: "2025年普陀区各公办小学招生计划数",
    stage: "primary" as const,
  },
  middlePublic: {
    url: "https://www.shanghai.gov.cn/ptqywjy/20251107/072e26b852ca483fa14bdc1396cc084e.html",
    title: "2025年普陀区各公办初中招生计划数",
    stage: "middle" as const,
  },
  primaryPrivate: {
    url: "https://www.shanghai.gov.cn/ptqywjy/20251107/08112b8edd9246e6b0a59d32ebdb6b5d.html",
    title: "2025年普陀区民办小学招生计划",
    stage: "primary" as const,
  },
  middlePrivate: {
    url: "https://www.shanghai.gov.cn/ptqywjy/20251107/d7d65631dfac4a13bfffac1b48d53740.html",
    title: "2025年普陀区民办初中招生计划",
    stage: "middle" as const,
  },
};

function decode(value: string) {
  return value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cellText(value: string) {
  return decode(value.replace(/<br\s*\/?>(?=<)/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function tableRows(html: string, predicate: (table: string) => boolean) {
  const table = [...html.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((m) => m[0]).find(predicate);
  if (!table) throw new Error("Expected official Putuo table was not found");
  return [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)]
    .map((row) => [...row[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cellText(m[1] ?? "")))
    .filter((row) => row.length > 0);
}

const aliasMap: Record<string, string> = {
  "平利一小": "平利路第一小学",
  "沪太一小": "沪太新村第一小学",
  "中北一小": "中山北路第一小学",
  "曹村六小": "曹杨新村第六小学",
  "华东师大附小": "华东师范大学附属小学",
  "华外实验": "华东师范大学附属外国语实验学校",
  "上外附属普陀实验": "上海外国语大学附属普陀实验学校",
  "真如三小": "真如第三小学",
  "真如文英小学": "真如文英中心小学",
  "新普陀小学新普陀小学东校": "新普陀小学及东校",
  "上师大二实验": "上海师范大学附属第二实验学校",
  "上理工附属普陀实验": "上海理工大学附属普陀实验学校",
  "上外尚阳外国语学校": "上海市上外尚阳外国语学校",
  "上音安师": "上海音乐学院附属安师实验中学",
  "华东师大四附中": "华东师范大学第四附属中学",
  "华东师大四附中小学部": "华东师范大学第四附属中学",
  "曹二实验": "曹杨第二中学附属实验中学",
  "梅陇实验中学": "梅陇实验中学",
  "区教院附中": "教育学院附属中学",
  "宜川附校": "宜川中学附属学校",
  "曹杨附校": "曹杨中学附属学校",
  "区教院附校": "教育学院附属学校",
  "尚阳外国语学校": "上外尚阳外国语学校",
  "同济二附中": "同济大学第二附属中学",
  "曹二东校": "曹杨第二中学附属学校",
  "华二普陀实验": "华东师范大学附属外国语实验学校",
};

export function normalizeName(value: string) {
  const compact = value
    .replace(/[\s　·•\-—]/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市?/, "")
    .replace(/^普陀区/, "")
    .replace(/教育集团|集团校/g, "")
    .replace(/小学部|初中部|中学部/g, "")
    .trim();
  return aliasMap[compact] ?? compact;
}

function stageVariant(value: string, stage: Stage) {
  const compact = value.replace(/[\s　]/g, "");
  return compact
    .replace(stage === "primary" ? /（小学）|\(小学\)/g : /（初中）|\(初中\)/g, "")
    .replace(stage === "primary" ? /小学$/ : /初中$/, "");
}

function validPlan(value: string) {
  return /^\d+(?:\.\d+)?$/.test(value);
}

export function parsePublicPlanRows(html: string, stage: Stage): PublicPlanRow[] {
  const rows = tableRows(html, (table) => table.includes("招生计划") && table.includes("班级数") && !table.includes("民办学校全称"));
  const result: PublicPlanRow[] = [];
  for (const raw of rows.slice(1)) {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      const name = raw[index]?.trim() ?? "";
      const plannedClasses = raw[index + 1]?.trim() ?? "";
      if (name && validPlan(plannedClasses)) result.push({ stage, name, plannedClasses, raw });
    }
  }
  return result;
}

export function parsePrivatePlanRows(html: string): PrivatePlanRow[] {
  const rows = tableRows(html, (table) => table.includes("学校招生") && table.includes("分类计划名称"));
  const result: PrivatePlanRow[] = [];
  let current: { stage: Stage; name: string; totalPlan: string } | null = null;
  let headerHasDirect = false;
  for (const raw of rows.slice(1)) {
    const first = raw[0] ?? "";
    if (first === "小学" || first === "初中") {
      current = { stage: first === "小学" ? "primary" : "middle", name: raw[1] ?? "", totalPlan: raw[3] ?? "" };
      headerHasDirect = raw.length >= 10;
      if (raw.length < 9) continue;
      result.push({ stage: current.stage, name: current.name, totalPlan: current.totalPlan, category: raw[4] ?? "", condition: raw[5] ?? "", directPlan: headerHasDirect ? raw[6] ?? "" : "", dayPlan: raw[headerHasDirect ? 7 : 6] ?? "", boardingPlan: raw[headerHasDirect ? 8 : 7] ?? "", transfer: raw[headerHasDirect ? 9 : 8] ?? "", raw });
      continue;
    }
    // With rowspan, subsequent school headers omit the stage cell. They are
    // still identifiable by the purchase flag, numeric total, and 8/9 cells.
    if (raw.length >= 8 && (raw[1] === "是" || raw[1] === "否") && validPlan(raw[2] ?? "")) {
      current = { stage: current?.stage ?? "primary", name: raw[0] ?? "", totalPlan: raw[2] ?? "" };
      headerHasDirect = raw.length >= 9;
      result.push({ stage: current.stage, name: current.name, totalPlan: current.totalPlan, category: raw[3] ?? "", condition: raw[4] ?? "", directPlan: headerHasDirect ? raw[5] ?? "" : "", dayPlan: raw[headerHasDirect ? 6 : 5] ?? "", boardingPlan: raw[headerHasDirect ? 7 : 6] ?? "", transfer: raw[headerHasDirect ? 8 : 7] ?? "", raw });
      continue;
    }
    if (!current || raw.length < 5) continue;
    result.push({ stage: current.stage, name: current.name, totalPlan: current.totalPlan, category: raw[0] ?? "", condition: raw[1] ?? "", directPlan: headerHasDirect ? raw[2] ?? "" : "", dayPlan: raw[headerHasDirect ? 3 : 2] ?? "", boardingPlan: raw[headerHasDirect ? 4 : 3] ?? "", transfer: raw[headerHasDirect ? 5 : 4] ?? "", raw });
  }
  return result;
}

export function matchSchool(source: { stage: Stage; name: string }, schools: MatchSchool[]) {
  const stageType = source.stage === "primary" ? "primary" : "middle";
  const sourceKey = normalizeName(source.name);
  const sourceVariant = normalizeName(stageVariant(source.name, source.stage));
  const exactStage = schools.filter((school) => school.type === stageType && normalizeName(school.name) === sourceKey);
  if (exactStage.length === 1) return exactStage[0] ?? null;
  if (exactStage.length > 1) return null;
  const candidates = schools.filter((school) => {
    if (school.type !== stageType && school.type !== "nine_year") return false;
    return normalizeName(school.name) === sourceKey || normalizeName(stageVariant(school.name, source.stage)) === sourceVariant;
  });
  if (candidates.length === 0) return null;
  const scored = candidates.map((school) => {
    let score = school.type === stageType ? 4 : 2;
    if (source.stage === "primary" && /小学部/.test(school.name)) score += 3;
    if (source.stage === "middle" && /初中部/.test(school.name)) score += 3;
    return { school, score };
  });
  const bestScore = Math.max(...scored.map((item) => item.score));
  const best = scored.filter((item) => item.score === bestScore).map((item) => item.school);
  if (best.length !== 1) return null;
  // An exact canonical row and a separately named campus row are ambiguous
  // unless the source itself includes the campus marker.
  if (best.length === 1 && candidates.length > 1 && !/小学|初中|中学部|校区/.test(source.name)) return null;
  return best[0] ?? null;
}

function sourceDate(title: string) {
  const year = title.match(/20\d{2}/)?.[0];
  return year ? `${year}-04-07` : null;
}

function noteForPublic(row: PublicPlanRow) {
  return `2025年普陀区官方${row.stage === "primary" ? "公办小学" : "公办初中"}招生计划：${row.plannedClasses}个班`;
}

function noteForPrivate(row: PrivatePlanRow) {
  const parts = [`2025年普陀区官方${row.stage === "primary" ? "民办小学" : "民办初中"}招生计划总数：${row.totalPlan}人`];
  if (row.category) parts.push(`分类计划：${row.category}`);
  if (row.directPlan && row.directPlan !== "/") parts.push(`直升${row.directPlan}人`);
  if (row.dayPlan && row.dayPlan !== "/") parts.push(`走读${row.dayPlan}人`);
  if (row.boardingPlan && row.boardingPlan !== "/") parts.push(`住宿${row.boardingPlan}人`);
  if (row.condition && row.condition !== "/") parts.push(`条件：${row.condition}`);
  if (row.transfer) parts.push(`接受调剂：${row.transfer}`);
  return parts.join("；");
}

type DbSchool = MatchSchool & { district: string; enrollment_note: string | null };
type Action = Record<string, unknown>;

async function main() {
  const apply = process.argv.includes("--apply");
  const reportDir = path.join(process.cwd(), ".tmp", "official-putuo-admission", new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-"));
  mkdirSync(reportDir, { recursive: true });
  const pages = await Promise.all(Object.values(SOURCES).map(async (source) => ({ ...source, html: await fetch(source.url).then(async (res) => { if (!res.ok) throw new Error(`Fetch ${source.url}: ${res.status}`); return res.text(); }) })));
  const publicRows = pages.filter((page) => page === pages[0] || page === pages[1]).flatMap((page) => parsePublicPlanRows(page.html, page.stage));
  const privateRows = pages.filter((page) => page === pages[2] || page === pages[3]).flatMap((page) => parsePrivatePlanRows(page.html));
  const allRows = [...publicRows.map((row) => ({ kind: "public" as const, ...row, source: row.stage === "primary" ? SOURCES.primaryPublic : SOURCES.middlePublic })), ...privateRows.map((row) => ({ kind: "private" as const, ...row, source: row.stage === "primary" ? SOURCES.primaryPrivate : SOURCES.middlePrivate }))];
  writeFileSync(path.join(reportDir, "source-rows.json"), JSON.stringify(allRows, null, 2), "utf8");

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Action[] = [];
  let updated = 0;
  let sourcesUpserted = 0;
  try {
    const schools = (await client.query<DbSchool>(`SELECT id,name,district,type,enrollment_note FROM public.schools WHERE district='普陀' ORDER BY id`)).rows;
    const rowsBySchool = new Map<number, Array<(typeof allRows)[number]>>();
    for (const row of allRows) {
      const school = matchSchool(row, schools);
      if (!school) {
        actions.push({ sourceName: row.name, stage: row.stage, kind: row.kind, action: "skip-unmatched-or-ambiguous" });
        continue;
      }
      rowsBySchool.set(school.id, [...(rowsBySchool.get(school.id) ?? []), row]);
    }
    await client.query("BEGIN");
    for (const [schoolId, matchedRows] of rowsBySchool) {
      const school = schools.find((item) => item.id === schoolId)!;
      if (school.enrollment_note?.trim()) {
        actions.push({ schoolId, schoolName: school.name, action: "skip-existing-note", sourceRows: matchedRows.length });
        continue;
      }
      const note = matchedRows.map((row) => row.kind === "public" ? noteForPublic(row) : noteForPrivate(row)).join("\n");
      const raw = { migration: "official_putuo_admission_2025", district: "普陀", school_id: schoolId, source_rows: matchedRows };
      if (apply) {
        const update = await client.query(`UPDATE public.schools SET enrollment_note=$1, attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_putuo_admission_2025}',$2::jsonb,true), updated_at=now() WHERE id=$3 AND district='普陀' AND (enrollment_note IS NULL OR btrim(enrollment_note)='')`, [note, JSON.stringify(raw), schoolId]);
        updated += update.rowCount ?? 0;
        for (const row of matchedRows) {
          const source = row.source;
          const evidence = `${source.title}；学校：${row.name}；${row.kind === "public" ? `招生计划：${row.plannedClasses}个班` : `计划总数：${row.totalPlan}人；分类计划：${row.category}`}`;
          const sourceResult = await client.query(`INSERT INTO public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at) VALUES($1,'official_admission','普陀区教育局',$2,$3,$4,$5,'high',$6::jsonb,now(),now(),now()) ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=now(),updated_at=now() RETURNING id`, [schoolId, source.url, source.title, sourceDate(source.title), evidence, JSON.stringify(row)]);
          sourcesUpserted += sourceResult.rowCount ?? 0;
        }
      }
      actions.push({ schoolId, schoolName: school.name, sourceRows: matchedRows.length, action: apply ? "update" : "dry-run", note });
    }
    writeFileSync(path.join(reportDir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: allRows.length, matchedSchools: rowsBySchool.size, updated, sourcesUpserted, report: reportDir }, null, 2));
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { await client.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
