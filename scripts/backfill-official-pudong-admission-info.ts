/**
 * Backfill blank Pudong school admission notes from the 2025 official tables.
 *
 * The source table is an official Shanghai government publication. Rows are
 * grouped by school code/name so multi-campus schools become one auditable
 * school record. Dry-run is the default; pass --apply to write.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const primaryPath = valueArg("--primary") ?? path.join(process.cwd(), "data/audit/source-cache/round11/pudong-primary-2025.html");
const middlePath = valueArg("--middle") ?? path.join(process.cwd(), "data/audit/source-cache/round11/pudong-middle-2025.html");
const district = "浦东";
const year = 2025;
const primaryUrl = "https://www.pudong.gov.cn/019020001/20250408/804729.html";
const middleUrl = "https://www.shanghai.gov.cn/pdxqywjy/20250507/79de2fd60f4a42099fad4acc7aa78922.html";

type Stage = "primary" | "middle";
type RawRow = { code: string; name: string; campus: string; nature: string; address: string; scope: string };
type Aggregated = {
  stage: Stage;
  code: string;
  name: string;
  nature: string;
  campuses: string[];
  addresses: string[];
  scopes: string[];
  sourceUrl: string;
  sourceTitle: string;
};
type School = { id: number; name: string; district: string; type: Stage | "nine_year"; address: string | null; school_nature: "公立" | "私立" | null; enrollment_note: string | null; attrs: Record<string, unknown> | null };

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function decode(value: string) {
  return value.replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cellText(value: string) {
  return decode(value.replace(/<br\s*\/?>(?=<)/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function parseRows(html: string, stage: Stage): RawRow[] {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  const table = tables.find((item) => item.includes("学校代码") && item.includes("对口招生范围"));
  if (!table) throw new Error(`Official ${stage} table not found`);
  const rows: RawRow[] = [];
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cellText(m[1] ?? ""));
    if (cells.length < 6 || !/^310\d{6,}$/.test(cells[0] ?? "")) continue;
    const [code, name, campus, nature, address, scope] = cells;
    if (!name) continue;
    rows.push({ code, name, campus: campus === "/" ? "" : campus, nature, address, scope });
  }
  return rows;
}

function normalizeName(value: string) {
  return value.replace(/[\s　·•\-—()（）]/g, "").replace(/^上海市/, "").replace(/浦东新区/g, "").replace(/区/g, "").replace(/教育集团|集团校|小学部|初中部/g, "").trim();
}

function nature(value: string): "公立" | "私立" | null {
  if (/公办|公立/.test(value)) return "公立";
  if (/民办|私立/.test(value)) return "私立";
  return null;
}

function aggregate(rows: RawRow[], stage: Stage, sourceUrl: string) {
  const map = new Map<string, Aggregated>();
  for (const row of rows) {
    const key = `${row.code}|${normalizeName(row.name)}`;
    const current = map.get(key) ?? { stage, code: row.code, name: row.name, nature: row.nature, campuses: [], addresses: [], scopes: [], sourceUrl, sourceTitle: `2025年浦东新区义务教育阶段学校招生入学信息公示（${stage === "primary" ? "小学" : "初中"}）` };
    if (row.campus && !current.campuses.includes(row.campus)) current.campuses.push(row.campus);
    if (row.address && !current.addresses.includes(row.address)) current.addresses.push(row.address);
    if (row.scope && !current.scopes.includes(row.scope)) current.scopes.push(row.scope);
    if (!current.nature && row.nature) current.nature = row.nature;
    map.set(key, current);
  }
  return [...map.values()];
}

function noteFor(row: Aggregated) {
  const parts = [`${year}年浦东官方招生入学公示`];
  if (row.campuses.length) parts.push(`校区：${row.campuses.join("、")}`);
  if (row.addresses.length) parts.push(`地址：${row.addresses.join("；")}`);
  if (row.scopes.length) parts.push(`对口招生范围：${row.scopes.join("；")}`);
  return parts.join("；");
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-pudong-admission-info", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  if (!existsSync(primaryPath) || !existsSync(middlePath)) throw new Error("Official Pudong cache file missing");
  const rows = [
    ...aggregate(parseRows(readFileSync(primaryPath, "utf8"), "primary"), "primary", primaryUrl),
    ...aggregate(parseRows(readFileSync(middlePath, "utf8"), "middle"), "middle", middleUrl),
  ];
  const dir = outputDir();
  writeFileSync(path.join(dir, "source-aggregated.json"), JSON.stringify(rows, null, 2), "utf8");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: unknown[] = [];
  let matched = 0, updated = 0, sources = 0;
  try {
    const schools = (await client.query<School>(`SELECT id,name,district,type,address,school_nature,enrollment_note,attrs FROM public.schools WHERE district=$1 ORDER BY id`, [district])).rows;
    const exact = new Map<string, School[]>();
    for (const school of schools) {
      const key = `${school.type}|${normalizeName(school.name)}`;
      exact.set(key, [...(exact.get(key) ?? []), school]);
    }
    await client.query("BEGIN");
    for (const row of rows) {
      const candidates = exact.get(`${row.stage}|${normalizeName(row.name)}`) ?? [];
      if (candidates.length !== 1) {
        actions.push({ stage: row.stage, code: row.code, sourceName: row.name, action: candidates.length ? "skip-ambiguous-school" : "skip-unmatched-school", candidateIds: candidates.map((s) => s.id) });
        continue;
      }
      const school = candidates[0];
      const officialNature = nature(row.nature);
      const note = noteFor(row);
      const fillNote = !school.enrollment_note?.trim();
      const fillNature = !school.school_nature && Boolean(officialNature);
      const fillAddress = !school.address?.trim() && row.addresses.length > 0;
      if (!fillNote && !fillNature && !fillAddress) {
        actions.push({ schoolId: school.id, stage: row.stage, code: row.code, sourceName: row.name, action: "skip-no-blank-fields" });
        continue;
      }
      matched += 1;
      const raw = { year, stage: row.stage, school_code: row.code, source_name: row.name, campuses: row.campuses, addresses: row.addresses, scopes: row.scopes, source_url: row.sourceUrl };
      const evidence = `${row.sourceTitle}；学校代码 ${row.code}；校区 ${row.campuses.join("、") || "未标注"}；地址 ${row.addresses.join("；") || "未标注"}；对口招生范围 ${row.scopes.join("；") || "未标注"}`;
      if (apply) {
        const result = await client.query(`UPDATE public.schools SET enrollment_note=CASE WHEN (enrollment_note IS NULL OR btrim(enrollment_note)='') THEN $1 ELSE enrollment_note END, school_nature=CASE WHEN school_nature IS NULL THEN $2::school_nature ELSE school_nature END, address=CASE WHEN (address IS NULL OR btrim(address)='') THEN NULLIF($3,'') ELSE address END, attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_pudong_admission_2025}',$4::jsonb,true), updated_at=now() WHERE id=$5 AND district=$6 AND name=$7`, [fillNote ? note : null, fillNature ? officialNature : null, fillAddress ? row.addresses[0] : "", JSON.stringify(raw), school.id, school.district, school.name]);
        updated += result.rowCount ?? 0;
        const sourceResult = await client.query(`INSERT INTO public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at) VALUES($1,'official_admission','上海市浦东新区教育局',$2,$3,$4,$5,'high',$6::jsonb,now(),now()) ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=excluded.fetched_at,updated_at=now() RETURNING id`, [school.id, row.sourceUrl, row.sourceTitle, `${year}-04-01`, evidence, JSON.stringify(raw)]);
        sources += sourceResult.rowCount ?? 0;
      }
      actions.push({ schoolId: school.id, schoolName: school.name, stage: row.stage, code: row.code, sourceName: row.name, action: apply ? "update" : "dry-run", fillNote, fillNature, fillAddress, sourceUrl: row.sourceUrl });
    }
    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: rows.length, schools: schools.length, matched, updated, sources, report: dir }, null, 2));
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { await client.end(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
