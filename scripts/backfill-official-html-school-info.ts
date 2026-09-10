/**
 * Backfill blank school address/nature from cached official HTML tables.
 *
 * The script is intentionally strict: it matches district + stage + a
 * normalized canonical name or alias, and writes only when one database row
 * remains. Dry-run is the default; --apply commits the audited changes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const defaultSources = [
  {
    district: "长宁",
    stage: "middle" as const,
    file: path.join(process.cwd(), "data/audit/source-cache/round11/changning-school-contact-2026.html"),
    url: "https://zwgk.shcn.gov.cn/xxgk/ywjyzs-jyjzsgl/2025/99/77226.html",
    title: "2025年长宁区初中校园开放日情况一览表 / 2026年长宁区中小学校和托幼机构通讯信息表",
    date: "2026-01-01",
    parser: "contact" as const,
  },
  {
    district: "长宁",
    stage: "middle" as const,
    file: path.join(process.cwd(), "data/audit/source-cache/round11/changning-basic-middle-2025.html"),
    url: "https://zwgk.shcn.gov.cn/xxgk/77181.html",
    title: "2025年长宁区义务教育学校办学规模与设施等基本情况公示（初中）",
    date: "2025-04-07",
    parser: "basic" as const,
  },
  {
    district: "闵行",
    stage: "middle" as const,
    file: path.join(process.cwd(), "data/audit/source-cache/round11/minhang-middle-2025.html"),
    url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
    title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
    date: "2025-04-07",
    parser: "minhang" as const,
  },
];

type Stage = "primary" | "middle";
type SourceConfig = (typeof defaultSources)[number];
type Row = { district: string; stage: Stage; name: string; nature: "公立" | "私立" | null; address: string; source: SourceConfig; raw: string[] };
type School = { id: number; name: string; district: string; type: "primary" | "middle" | "nine_year"; aliases: string[] | null; address: string | null; school_nature: "公立" | "私立" | null };

function decode(value: string) {
  return value.replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cellText(value: string) {
  return decode(value.replace(/<br\s*\/?>(?=<)/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tables(html: string) {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
}

function tableRows(table: string) {
  return (table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map((tr) => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cellText(m[1] ?? ""))).filter((r) => r.length > 0);
}

function officialNature(value: string): "公立" | "私立" | null {
  if (/公办|公立/.test(value)) return "公立";
  if (/民办|私立/.test(value)) return "私立";
  return null;
}

function normalize(value: string) {
  return value
    .replace(/[\s　·•\-—]/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市/, "")
    .replace(/长宁区|闵行区|浦东新区|宝山区|区/g, "")
    .replace(/教育集团|集团校|小学部|初中部/g, "")
    .trim();
}

function parseSource(config: SourceConfig, html: string): Row[] {
  const all = tables(html);
  const table = config.parser === "contact"
    ? all.find((t) => t.includes("学校（全称）") && t.includes("办学性质") && t.includes("学段") && t.includes("地址"))
    : config.parser === "basic"
      ? all.find((t) => t.includes("学校名称") && t.includes("学校性质"))
      : all.find((t) => t.includes("学校名称") && t.includes("学校地址") && t.includes("学校性质"));
  if (!table) throw new Error(`Official table not found: ${config.file}`);
  const rows: Row[] = [];
  for (const cells of tableRows(table)) {
    let name = "", nature: "公立" | "私立" | null = null, address = "";
    if (config.parser === "contact") {
      if (cells.length < 6 || !/初中/.test(cells[3] ?? "")) continue;
      name = cells[1] ?? ""; nature = officialNature(cells[2] ?? ""); address = cells[5] ?? "";
    } else if (config.parser === "basic") {
      if (cells.length < 3 || !/^\d+$/.test(cells[0] ?? "")) continue;
      name = cells[1] ?? ""; nature = officialNature(cells[2] ?? "");
    } else {
      if (cells.length < 4 || !/^\d+$/.test(cells[0] ?? "")) continue;
      name = cells[1] ?? ""; nature = officialNature(cells[2] ?? ""); address = cells[3] ?? "";
    }
    if (!name || (!nature && !address)) continue;
    rows.push({ district: config.district, stage: config.stage, name, nature, address, source: config, raw: cells });
  }
  return rows;
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-html-school-info", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const configs = defaultSources.filter((source) => existsSync(source.file));
  if (configs.length !== defaultSources.length) throw new Error("One or more official cache files are missing.");
  const rows = configs.flatMap((config) => parseSource(config, readFileSync(config.file, "utf8")));
  const dir = outputDir();
  writeFileSync(path.join(dir, "parsed-source-rows.json"), JSON.stringify(rows, null, 2), "utf8");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const schools = (await client.query<School>(`SELECT id,name,district,type,aliases,address,school_nature FROM public.schools WHERE district = ANY($1::text[]) ORDER BY district,id`, [["长宁", "闵行"]])).rows;
    const actions: Record<string, unknown>[] = [];
    let matched = 0, updated = 0, sources = 0;
    const plannedSourceKeys = new Set<string>();
    await client.query("BEGIN");
    for (const row of rows) {
      const keys = new Set([normalize(row.name)]);
      const candidates = schools.filter((school) => {
        if (school.district !== row.district || (school.type !== row.stage && school.type !== "nine_year")) return false;
        const names = [school.name, ...(school.aliases ?? [])].map(normalize);
        return names.some((name) => keys.has(name));
      });
      if (candidates.length !== 1) {
        actions.push({ action: candidates.length ? "skip-ambiguous" : "skip-unmatched", sourceName: row.name, district: row.district, stage: row.stage, candidateIds: candidates.map((s) => s.id) });
        continue;
      }
      const school = candidates[0]!;
      const fillNature = !school.school_nature && Boolean(row.nature);
      const fillAddress = !school.address?.trim() && Boolean(row.address);
      if (!fillNature && !fillAddress) { actions.push({ action: "skip-no-blank-fields", schoolId: school.id, sourceName: row.name }); continue; }
      const sourceKey = `${school.id}|${row.source.url}|official_school_info`;
      if (plannedSourceKeys.has(sourceKey)) {
        actions.push({ action: "skip-duplicate-source", schoolId: school.id, sourceName: row.name, sourceUrl: row.source.url });
        continue;
      }
      plannedSourceKeys.add(sourceKey);
      matched += 1;
      const raw = { district: row.district, stage: row.stage, source_name: row.name, official_nature: row.nature, official_address: row.address, raw_cells: row.raw, source_file: row.source.file };
      const evidence = `${row.source.title}；公开名称：${row.name}；办学性质：${row.nature ?? "未标注"}；地址：${row.address || "未标注"}`;
      if (apply) {
        const result = await client.query(`UPDATE public.schools SET school_nature=CASE WHEN school_nature IS NULL THEN $1::school_nature ELSE school_nature END, address=CASE WHEN (address IS NULL OR btrim(address)='') THEN NULLIF($2,'') ELSE address END, attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_html_school_info}',$3::jsonb,true), updated_at=now() WHERE id=$4 AND district=$5 AND name=$6`, [fillNature ? row.nature : null, fillAddress ? row.address : "", JSON.stringify(raw), school.id, school.district, school.name]);
        updated += result.rowCount ?? 0;
        const sourceResult = await client.query(`INSERT INTO public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at) VALUES($1,'official_school_info','${row.district}区教育局',$2,$3,$4,$5,'high',$6::jsonb,now(),now()) ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=excluded.fetched_at,updated_at=now() RETURNING id`, [school.id, row.source.url, row.source.title, row.source.date, evidence, JSON.stringify(raw)]);
        sources += sourceResult.rowCount ?? 0;
      }
      actions.push({ action: apply ? "update" : "dry-run", schoolId: school.id, schoolName: school.name, sourceName: row.name, fillNature, fillAddress, sourceUrl: row.source.url });
    }
    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: rows.length, schools: schools.length, matched, updated, sources, report: dir }, null, 2));
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { await client.end(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
