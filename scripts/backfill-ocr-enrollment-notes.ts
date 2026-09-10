/** Fill blank school enrollment notes from cached official catchment OCR. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const requestedDistrict = valueArg("--district");
const SKIP_AMBIGUOUS = "skip-ambiguous";
type Stage = "primary" | "middle";
type Source = {
  district: string;
  year: number;
  title: string;
  url: string;
  stage: Stage;
  ocr?: string;
  ocrDir?: string;
  schoolMaxX: number;
  areaMinX: number;
  modeMinX?: number;
  classMinX?: number;
};
type Observation = { text: string; confidence: number; x: number; y: number; w: number; h: number };
type Row = { y: number; cells: Observation[] };
type School = { id: number; name: string; district: string; type: string; school_nature: string | null; enrollment_note: string | null };

const SOURCES: Source[] = [
  { district: "静安", year: 2026, title: "2026年静安区公办小学招生划片范围", url: "https://shrxbm.edu.sh.gov.cn/zszc/policy/310106/zszchtml_201601688.html", stage: "primary", ocr: ".tmp/official-policy-images/jingan-primary-2026.ocr.json", schoolMaxX: 420, areaMinX: 420 },
  { district: "杨浦", year: 2026, title: "2026年杨浦区一年级新生招生范围", url: "https://shrxbm.edu.sh.gov.cn/zszc/policy/310110/zszchtml_201601611.html", stage: "primary", ocrDir: ".tmp/official-policy-images/yangpu-primary-slices", schoolMaxX: 520, areaMinX: 500 },
  { district: "静安", year: 2026, title: "2026年静安区公办初中入学方式", url: "https://shrxbm.edu.sh.gov.cn/zszc/policy/310106/zszchtml_201601689.html", stage: "middle", ocr: ".tmp/official-policy-images/jingan-middle-2026.ocr.json", schoolMaxX: 340, areaMinX: 340, modeMinX: 520, classMinX: 640 },
  { district: "杨浦", year: 2026, title: "2026年杨浦区小学对口公办初中方案", url: "https://shrxbm.edu.sh.gov.cn/zszc/policy/310110/zszchtml_201601613.html", stage: "middle", ocr: ".tmp/official-policy-images/yangpu-middle-2026.ocr.json", schoolMaxX: 340, areaMinX: 340 },
];

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function normalize(value: unknown) {
  return String(value ?? "").replace(/上海市|杨浦区|静安区/g, "").replace(/[（）()\s　·•\-—]/g, "").replace(/小学部|初中部|中学部|教育集团|分校/g, "").replace(/附属/g, "附").replace(/实验学校/g, "学校").replace(/风城/g, "凤城").replace(/翔股/g, "翔殷").replace(/菖/g, "育").replace(/阳浦/g, "杨浦").trim();
}

function normalizeArea(value: unknown) {
  return String(value ?? "").replace(/卉/g, "弄").replace(/爱困路/g, "爱国路").replace(/困葭/g, "国霞").replace(/股行/g, "殷行").replace(/翔股/g, "翔殷").replace(/崔山/g, "霍山").replace(/周冢嘴/g, "周家嘴").replace(/靖宁/g, "靖宇").replace(/中费家宅/g, "中原家宅").replace(/[》〉]/g, "）").replace(/\s+/g, "").replace(/[|]/g, "").trim();
}

function ocrRows(file: string, yOffset = 0): Row[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { width: number; height: number; observations: Array<Record<string, number | string>> };
  const observations: Observation[] = (parsed.observations ?? []).map((item) => ({ text: String(item.text ?? "").trim(), confidence: Number(item.confidence ?? 0), x: Number(item.x ?? 0) * parsed.width, y: yOffset + (1 - Number(item.y ?? 0) - Number(item.h ?? 0)) * parsed.height, w: Number(item.w ?? 0) * parsed.width, h: Number(item.h ?? 0) * parsed.height })).filter((item) => item.text).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Row[] = [];
  for (const observation of observations) {
    let row = rows.find((candidate) => Math.abs(candidate.y - observation.y) <= 18);
    if (!row) { row = { y: observation.y, cells: [] }; rows.push(row); }
    row.cells.push(observation);
  }
  for (const row of rows) row.cells.sort((a, b) => a.x - b.x);
  return rows.sort((a, b) => a.y - b.y);
}

function readSourceRows(source: Source) {
  if (source.ocr) return ocrRows(source.ocr);
  return readdirSync(source.ocrDir ?? "").filter((file) => file.endsWith(".ocr.json")).sort().flatMap((file) => ocrRows(path.join(source.ocrDir!, file), Number(file.match(/y(\d+)/)?.[1] ?? 0))).sort((a, b) => a.y - b.y);
}

function matcher(schools: School[], source: Source) {
  const type = source.stage === "middle" ? "middle" : "primary";
  const entries = schools.filter((school) => school.district === source.district && school.type === type && school.school_nature !== "私立").map((school) => ({ school, key: normalize(school.name) })).filter((entry) => entry.key.length >= 3).sort((a, b) => b.key.length - a.key.length);
  return (text: string) => {
    const key = normalize(text);
    if (!key || !/(小学|学校|一师|二师|上外|上音|育鹰|黄兴|市东|昆明|复旦|同济|民办|中学)/.test(text)) return null;
    const exact = entries.filter((entry) => entry.key === key);
    if (exact.length === 1) return exact[0]!.school;
    if (exact.length > 1) return null;
    const partial = entries.filter((entry) => key.includes(entry.key) || entry.key.includes(key));
    // Duplicate canonical rows are deliberately left unresolved; callers can
    // surface this marker in reports instead of attaching evidence by guess.
    if (partial.length > 1) return null;
    return partial.length === 1 ? partial[0]!.school : null;
  };
}

function validBoundary(value: string) {
  const boundary = normalizeArea(value);
  if (boundary.length < 2 || boundary.length > 1200 || /^(学校|招生|班级|序|地段|字母|对口|范围|备注|说明|地址)[:：]?/.test(boundary) || /^[A-Z]$|^\d+$/.test(boundary)) return "";
  return boundary;
}

function validFeeder(value: string) {
  const text = normalize(value);
  if (text.length < 2 || text.length > 160 || /^\d+(?:\.\d+)?$/.test(text) || /^co$/i.test(text)) return "";
  if (/^(学校|初中|小学|招生|班级|序|地段|对口|方式|范围|备注|说明|地址|全区|全市|统筹安排|详见学校招生简章)/.test(text)) return "";
  if (text === "本校") return text;
  if (!/(小学|学校|一师|二师|上外|上音|育鹰|黄兴|市东|昆明|复旦|同济|民办)/.test(text)) return "";
  return text;
}

function looksLikeMiddleSchoolCell(value: string) {
  const text = String(value ?? "").replace(/\s+/g, "").trim();
  return text.length >= 4 && /(中学|学校)/.test(text) && !/^(对口小学|招生学校|本校小学部)$/.test(text);
}

function admissionMode(value: string) {
  const text = String(value ?? "").replace(/\s+/g, "").trim();
  return /^(全部对口|电脑派位|全区|全市|统筹安排|详见学校招生简章|参照小学部招生范围统筹安排)$/.test(text) ? text : "";
}

function reportDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-ocr-enrollment-notes", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const sources = SOURCES.filter((source) => !requestedDistrict || source.district === requestedDistrict);
  if (!sources.length) throw new Error(`No OCR source configured for district: ${requestedDistrict}`);
  const dir = reportDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Record<string, unknown>[] = [];
  let candidates = 0;
  let updated = 0;
  let sourcesUpserted = 0;
  try {
    const districts = sources.map((source) => source.district);
    const schools = (await client.query<School>(`SELECT id,name,district,type,school_nature,enrollment_note FROM public.schools WHERE district = ANY($1) ORDER BY district,id`, [districts])).rows;
    await client.query("BEGIN");
    for (const source of sources) {
      const findSchool = matcher(schools, source);
      const grouped = new Map<number, { school: School; areas: string[]; feederSchools: string[]; modes: string[]; classCounts: string[]; rows: Record<string, unknown>[] }>();
      let currentSchool: School | null = null;
      for (const row of readSourceRows(source)) {
        const left = row.cells.filter((cell) => cell.x < source.schoolMaxX).map((cell) => cell.text);
        const rightCells = row.cells.filter((cell) => cell.x >= source.areaMinX);
        const right = rightCells.map((cell) => cell.text).join("、");
        const matched = left.slice().sort((a, b) => b.length - a.length).map(findSchool).find(Boolean) ?? null;
        if (matched) currentSchool = matched;
        else if (source.stage === "middle" && left.some(looksLikeMiddleSchoolCell)) currentSchool = null;
        if (!currentSchool) continue;
        const entry = grouped.get(currentSchool.id) ?? { school: currentSchool, areas: [], feederSchools: [], modes: [], classCounts: [], rows: [] };
        if (source.stage === "primary") {
          const boundary = validBoundary(right);
          if (!boundary) continue;
          if (!entry.areas.includes(boundary)) entry.areas.push(boundary);
        } else {
          for (const cell of rightCells) {
            const text = cell.text.trim();
            const mode = admissionMode(text);
            if (mode && !entry.modes.includes(mode)) entry.modes.push(mode);
            else if (source.classMinX && cell.x >= source.classMinX && /^\d+(?:\.\d+)?$/.test(text) && !entry.classCounts.includes(text)) entry.classCounts.push(text);
            else {
              const feeder = validFeeder(text);
              if (feeder && !entry.feederSchools.includes(feeder)) entry.feederSchools.push(feeder);
            }
          }
        }
        entry.rows.push({ rowY: Math.round(row.y), rawCells: row.cells.map((cell) => ({ text: cell.text, x: Math.round(cell.x), y: Math.round(cell.y), confidence: cell.confidence })) });
        grouped.set(currentSchool.id, entry);
      }
      for (const entry of grouped.values()) {
        const hasData = source.stage === "primary" ? entry.areas.length > 0 : entry.feederSchools.length > 0 || entry.modes.length > 0 || entry.classCounts.length > 0;
        if (entry.school.enrollment_note?.trim() || !hasData) continue;
        candidates += 1;
        const boundaryText = entry.areas.join("；");
        const feederText = entry.feederSchools.join("、");
        const modeText = entry.modes.join("、");
        const classText = entry.classCounts.join("、");
        const note = source.stage === "primary"
          ? `${source.year}年${source.district}区官方公办小学招生划片范围：${boundaryText}`
          : `${source.year}年${source.district}区官方公办初中招生安排${feederText ? `：对口小学：${feederText}` : ""}${modeText ? `；对口方式：${modeText}` : ""}${classText ? `；招生班级数：${classText}` : ""}`;
        const raw = { migration: "official_ocr_to_enrollment_note", district: source.district, stage: source.stage, school_name: entry.school.name, source_title: source.title, source_url: source.url, boundary_text: boundaryText || null, feeder_schools: entry.feederSchools, admission_modes: entry.modes, class_counts: entry.classCounts, ocr_rows: entry.rows };
        const evidence = source.stage === "primary" ? `${source.title}；学校：${entry.school.name}；对口地块/地段：${boundaryText}` : `${source.title}；学校：${entry.school.name}；对口小学：${feederText || "未列明"}；对口方式：${modeText || "未列明"}；招生班级数：${classText || "未列明"}`;
        if (apply) {
          const result = await client.query(`UPDATE public.schools SET enrollment_note=$1, attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_ocr_enrollment_note}',$2::jsonb,true), updated_at=now() WHERE id=$3 AND district=$4 AND name=$5 AND (enrollment_note IS NULL OR btrim(enrollment_note)='')`, [note, JSON.stringify(raw), entry.school.id, entry.school.district, entry.school.name]);
          updated += result.rowCount ?? 0;
          const sourceResult = await client.query(`INSERT INTO public.web_data_source (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at) VALUES ($1,'official_admission',$2,$3,$4,$5,$6,'high',$7::jsonb,now(),now()) ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=now(),updated_at=now() RETURNING id`, [entry.school.id, `${source.district}区教育局`, source.url, source.title, `${source.year}-01-01`, evidence, JSON.stringify(raw)]);
          sourcesUpserted += sourceResult.rowCount ?? 0;
        }
        actions.push({ district: entry.school.district, stage: source.stage, schoolId: entry.school.id, schoolName: entry.school.name, sourceUrl: source.url, areaCount: entry.areas.length, feederCount: entry.feederSchools.length, modeCount: entry.modes.length, classCount: entry.classCounts.length, rawRows: entry.rows.length, action: apply ? "update" : "dry-run", note });
      }
    }
    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", districts, candidates, updated, sourcesUpserted, report: dir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
