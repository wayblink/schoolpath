/**
 * Backfill blank admission notes and explicit school nature from cached
 * official Shanghai enrollment pages.
 *
 * The cache is treated as evidence, not as a fuzzy source: district and stage
 * are inferred from the official index filename/title, and a row is accepted
 * only when exactly one database school has the same normalized name.
 * Dry-run is the default; pass --apply to commit.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const cacheDir = valueArg("--cache-dir") ?? path.join(process.cwd(), ".tmp", "official-policy-cache");

type Stage = "primary" | "middle" | "unknown";
type School = {
  id: number;
  name: string;
  district: string;
  type: Stage | "nine_year";
  school_nature: "公立" | "私立" | null;
  enrollment_note: string | null;
  attrs: Record<string, unknown> | null;
};
export type CachedSource = { file: string; district: string; stage: Stage; title: string; url: string | null; html: string };
export type CachedRow = { source: CachedSource; cells: string[]; schoolNames: string[] };
export type CachedSchool = {
  id: number;
  name: string;
  district: string;
  type: Stage | "nine_year";
  aliases?: string[] | null;
  school_nature?: "公立" | "私立" | null;
  enrollment_note?: string | null;
  attrs?: Record<string, unknown> | null;
};

const DISTRICT_BY_CODE: Record<string, string> = {
  "310101": "黄浦", "310104": "徐汇", "310105": "长宁", "310106": "静安",
  "310107": "普陀", "310109": "虹口", "310110": "杨浦", "310112": "闵行",
  "310113": "宝山", "310114": "嘉定", "310115": "浦东", "310116": "金山",
  "310117": "松江", "310118": "青浦", "310120": "奉贤", "310151": "崇明",
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function decode(value: string) {
  return value
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function cellText(value: string) {
  return decode(value.replace(/<br\s*\/?>(?=<)/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function normalizeSchoolName(value: string) {
  return value
    .replace(/[\s　·•\-—]/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市/, "")
    .replace(/新区|区/g, "")
    .replace(/教育集团|集团校|小学部|初中部/g, "")
    .trim();
}

function stageMatches(sourceStage: Stage, schoolType: CachedSchool["type"]) {
  if (sourceStage === "unknown") return true;
  if (sourceStage === "primary") return schoolType === "primary" || schoolType === "nine_year";
  return schoolType === "middle" || schoolType === "nine_year";
}

/** Match a cached official row only when its canonical name or reviewed alias is unique. */
export function matchCachedSchool(
  source: Pick<CachedSource, "district" | "stage">,
  rawName: string,
  schools: CachedSchool[],
) {
  const normalized = normalizeSchoolName(rawName);
  const matches = schools.filter((school) => {
    if (school.district !== source.district || !stageMatches(source.stage, school.type)) return false;
    return [school.name, ...(school.aliases ?? [])].some((name) => normalizeSchoolName(name) === normalized);
  });
  return matches.length === 1 ? matches[0] : null;
}

function inferDistrict(file: string) {
  const code = file.match(/policy_(\d{6})_/)?.[1];
  return code ? DISTRICT_BY_CODE[code] ?? "" : "";
}

function inferStage(title: string): Stage {
  if (/小学|一年级|幼升小/.test(title)) return "primary";
  if (/初中|中学|六年级|小升初/.test(title)) return "middle";
  return "unknown";
}

function inferTitle(html: string) {
  return cellText((html.match(/<div[^>]*class=["']ZCBT["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "") || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""));
}

function inferUrl(html: string) {
  const href = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)/i)?.[1]
    ?? html.match(/<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)/i)?.[1];
  return href ? decode(href) : null;
}

export function inferCachedSourceUrl(file: string) {
  const match = file.match(/policy_(\d{6})_zszchtml_(\d+)\.html(?:\.html)?$/);
  return match ? `https://shrxbm.edu.sh.gov.cn/zszc/policy/${match[1]}/zszchtml_${match[2]}.html` : null;
}

export function parseCachedRows(source: CachedSource, knownNames: Set<string>): CachedRow[] {
  const rows: CachedRow[] = [];
  for (const table of source.html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cellText(m[1] ?? "")).filter(Boolean);
      if (cells.length < 2) continue;
      const schoolNames = cells.filter((cell) => knownNames.has(normalizeSchoolName(cell)));
      if (schoolNames.length !== 1) continue;
      rows.push({ source, cells, schoolNames });
    }
  }
  return rows;
}

function validSource(source: CachedSource) {
  return Boolean(source.district && /招生|对口|划片|学区|入学方式|办学基本情况/.test(source.title));
}

function natureFrom(source: CachedSource, cells: string[]) {
  const text = `${source.title} ${cells.join(" ")}`;
  const publicHit = /公办|公立/.test(text);
  const privateHit = /民办|私立/.test(text);
  if (publicHit === privateHit) return null;
  return privateHit ? "私立" as const : "公立" as const;
}

function noteFrom(source: CachedSource, cells: string[]) {
  const body = cells.join("；").slice(0, 1800);
  return `${source.title}：${body}`;
}

function reportDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-policy-cache-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function loadSources() {
  if (!existsSync(cacheDir)) throw new Error(`Official cache directory not found: ${cacheDir}`);
  return readdirSync(cacheDir).filter((file) => file.endsWith(".html")).map((file) => {
    const html = readFileSync(path.join(cacheDir, file), "utf8");
    const title = inferTitle(html);
    return { file: path.join(cacheDir, file), district: inferDistrict(file), stage: inferStage(title), title, url: inferUrl(html) ?? inferCachedSourceUrl(file), html } satisfies CachedSource;
  }).filter(validSource);
}

async function main() {
  const dir = reportDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const schools = (await client.query<School & { aliases: string[] | null }>("SELECT id,name,district,type,school_nature,enrollment_note,attrs,aliases FROM public.schools ORDER BY district,id")).rows;
    const knownNames = new Set(schools.flatMap((school) => [school.name, ...(school.aliases ?? [])].map(normalizeSchoolName)));
    const sources = loadSources();
    const rows = sources.flatMap((source) => parseCachedRows(source, knownNames));
    const actions: Record<string, unknown>[] = [];
    let updated = 0;
    let sourcesUpserted = 0;
    await client.query("BEGIN");
    for (const row of rows) {
      const source = row.source;
      const school = matchCachedSchool(source, row.schoolNames[0]!, schools);
      if (!school) {
        const normalized = normalizeSchoolName(row.schoolNames[0]!);
        const candidateIds = schools.filter((candidate) => candidate.district === source.district && stageMatches(source.stage, candidate.type) && [candidate.name, ...(candidate.aliases ?? [])].some((name) => normalizeSchoolName(name) === normalized)).map((candidate) => candidate.id);
        actions.push({ action: candidateIds.length ? "skip-ambiguous" : "skip-unmatched", source: source.file, sourceTitle: source.title, sourceName: row.schoolNames[0], candidateIds });
        continue;
      }
      const explicitNature = natureFrom(source, row.cells);
      const fillNote = !school.enrollment_note?.trim();
      const fillNature = !school.school_nature && Boolean(explicitNature);
      if (!fillNote && !fillNature) {
        actions.push({ action: "skip-no-blank-fields", schoolId: school.id, schoolName: school.name, sourceTitle: source.title });
        continue;
      }
      const raw = { migration: "official_policy_cache", file: source.file, source_url: source.url, title: source.title, district: source.district, stage: source.stage, school_name: row.schoolNames[0], cells: row.cells };
      const evidence = `${source.title}；学校：${row.schoolNames[0]}；原始表格行：${row.cells.join(" | ")}`;
      if (apply) {
        const result = await client.query(`UPDATE public.schools SET enrollment_note=CASE WHEN (enrollment_note IS NULL OR btrim(enrollment_note)='') THEN $1 ELSE enrollment_note END, school_nature=CASE WHEN school_nature IS NULL THEN $2::school_nature ELSE school_nature END, attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_policy_cache}',$3::jsonb,true), updated_at=now() WHERE id=$4 AND district=$5 AND name=$6`, [fillNote ? noteFrom(source, row.cells) : null, fillNature ? explicitNature : null, JSON.stringify(raw), school.id, school.district, school.name]);
        updated += result.rowCount ?? 0;
        const sourceResult = await client.query(`INSERT INTO public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at) VALUES($1,'official_admission','上海市义务教育入学报名系统',$2,$3,$4,$5,'high',$6::jsonb,now(),now()) ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=now(),updated_at=now() RETURNING id`, [school.id, source.url ?? `file://${source.file}`, source.title, source.title.match(/20\d{2}/)?.[0] ?? null, evidence, JSON.stringify(raw)]);
        sourcesUpserted += sourceResult.rowCount ?? 0;
      }
      actions.push({ action: apply ? "update" : "dry-run", schoolId: school.id, schoolName: school.name, district: school.district, stage: source.stage, sourceTitle: source.title, sourceFile: source.file, sourceName: row.schoolNames[0], fillNote, fillNature, explicitNature, cells: row.cells });
    }
    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceCount: sources.length, parsedRows: rows.length, eligible: actions.filter((action) => action.action === "dry-run" || action.action === "update").length, updated, sourcesUpserted, actions }, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceCount: sources.length, parsedRows: rows.length, eligible: actions.filter((action) => action.action === "dry-run" || action.action === "update").length, updated, sourcesUpserted, report: dir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
