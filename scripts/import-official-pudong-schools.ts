/**
 * Import missing Pudong school entities from the official 2025 school-info
 * catalogue. Dry-run is the default; pass --apply to write the database.
 *
 * The importer is intentionally conservative: it only accepts rows with an
 * official name, stage, explicit public/private nature, address and source
 * URL. Existing schools are never overwritten, and same-name multi-address
 * source rows are reported for manual review instead of being duplicated.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

export type OfficialStage = "primary" | "middle";
export type OfficialSchoolRow = {
  district: string;
  stage: OfficialStage | "unknown";
  name: string;
  campus?: string;
  nature: string;
  address: string;
  sourceTitle: string;
  sourceUrl: string;
};

type ImportableOfficialSchoolRow = OfficialSchoolRow & { stage: OfficialStage };

export type ExistingSchool = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  address: string | null;
  aliases: string[] | null;
};

export type ImportAction = {
  action: "insert" | "dry-run-insert" | "skip-existing-school" | "skip-ambiguous-source" | "skip-invalid-row";
  name: string;
  stage: OfficialStage | "unknown";
  address: string;
  sourceUrl: string;
  existingSchoolId?: number;
  reason?: string;
};

export function normalizeOfficialNature(value: string): "公立" | "私立" | null {
  if (/公办|公立/.test(value)) return "公立";
  if (/民办|私立/.test(value)) return "私立";
  return null;
}

export function normalizedSchoolName(value: string) {
  return value
    .replace(/[\s\u00a0·•\-—]/g, "")
    .replace(/[（）]/g, (char) => (char === "（" ? "(" : ")"))
    .replace(/^上海市/, "")
    .replace(/^浦东新区/, "")
    .trim();
}

export function officialSchoolSourceKey(row: OfficialSchoolRow) {
  const year = row.sourceTitle.match(/20\d{2}/)?.[0] ?? "unknown";
  return `official_pudong_school_${year}:${row.stage}:${normalizedSchoolName(row.name)}`;
}

export function isImportableOfficialSchool(row: OfficialSchoolRow): row is ImportableOfficialSchoolRow {
  return Boolean(
    row.district === "浦东" &&
      (row.stage === "primary" || row.stage === "middle") &&
      row.name?.trim() &&
      row.address?.trim() &&
      normalizeOfficialNature(row.nature) &&
      row.sourceTitle?.trim() &&
      /^https?:\/\//.test(row.sourceUrl) &&
      !/统筹安排|待补充|无对应学校/.test(row.name),
  );
}

export function dedupeOfficialRows<T extends OfficialSchoolRow>(rows: T[]): T[] {
  return [...new Map(rows.map((row) => [`${row.stage}|${normalizedSchoolName(row.name)}|${row.address.trim()}|${row.sourceUrl}`, row])).values()];
}

function schoolKey(stage: OfficialStage, name: string) {
  return `${stage}|${normalizedSchoolName(name)}`;
}

export function selectImportCandidates(rows: OfficialSchoolRow[], existingSchools: ExistingSchool[]) {
  const validRows = dedupeOfficialRows(rows.filter(isImportableOfficialSchool));
  const existingByKey = new Map<string, ExistingSchool[]>();
  for (const school of existingSchools) {
    if (school.type !== "primary" && school.type !== "middle") continue;
    for (const name of [school.name, ...(school.aliases ?? [])]) {
      const key = schoolKey(school.type, name);
      existingByKey.set(key, [...(existingByKey.get(key) ?? []), school]);
    }
  }
  const grouped = new Map<string, OfficialSchoolRow[]>();
  for (const row of validRows) {
    const key = schoolKey(row.stage, row.name);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }

  const candidates: OfficialSchoolRow[] = [];
  const actions: ImportAction[] = [];
  for (const row of validRows) {
    const key = schoolKey(row.stage, row.name);
    const existing = existingByKey.get(key) ?? [];
    if (existing.length) {
      actions.push({ action: "skip-existing-school", name: row.name, stage: row.stage, address: row.address, sourceUrl: row.sourceUrl, existingSchoolId: existing[0]?.id, reason: "同区同学段规范化名称已存在" });
      continue;
    }
    const sameNameRows = grouped.get(key) ?? [];
    const addresses = new Set(sameNameRows.map((item) => item.address.trim()));
    if (addresses.size > 1) {
      actions.push({ action: "skip-ambiguous-source", name: row.name, stage: row.stage, address: row.address, sourceUrl: row.sourceUrl, reason: `同一官方名称对应 ${addresses.size} 个地址，不能自动拆分实体` });
      continue;
    }
    candidates.push(row);
    actions.push({ action: "dry-run-insert", name: row.name, stage: row.stage, address: row.address, sourceUrl: row.sourceUrl });
  }
  return { candidates, actions };
}

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function sourceDate(title: string) {
  const year = title.match(/20\d{2}/)?.[0];
  return year ? `${year}-01-01` : null;
}

function reportDir(apply: boolean) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-pudong-school-import", stamp);
  mkdirSync(dir, { recursive: true });
  return { dir, report: path.join(dir, apply ? "import-applied.json" : "import-dry-run.json") };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const sourcePath = valueArg("--source") ?? path.join(process.cwd(), "data/audit/official-school-info/latest-with-attachments.json");
  if (!existsSync(sourcePath)) throw new Error(`Source JSON not found: ${sourcePath}`);
  const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as { records?: OfficialSchoolRow[] };
  const sourceRows = (parsed.records ?? []).filter((row) => row.district === "浦东" && row.stage !== "unknown");
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const paths = reportDir(apply);
  try {
    const existing = (await client.query<ExistingSchool>(`SELECT id,name,district,type,address,aliases FROM public.schools WHERE district='浦东' ORDER BY id`)).rows;
    const selection = selectImportCandidates(sourceRows, existing);
    const actions = selection.actions.map((action) => ({ ...action, action: action.action === "dry-run-insert" && apply ? "insert" : action.action }));
    let inserted = 0;
    let sourcesUpserted = 0;
    await client.query("BEGIN");
    for (const row of selection.candidates) {
      const nature = normalizeOfficialNature(row.nature);
      if (!nature) continue;
      const raw = { district: row.district, stage: row.stage, official_name: row.name, campus: row.campus ?? "", official_nature: row.nature, official_address: row.address, source_title: row.sourceTitle, source_url: row.sourceUrl, imported_at: new Date().toISOString() };
      const evidence = `${row.sourceTitle}；公开名称：${row.name}；办学性质：${row.nature}；地址：${row.address}`;
      if (!apply) continue;
      const result = await client.query<{ id: number }>(
        `INSERT INTO public.schools (name,district,type,school_nature,address,aliases,attrs,source_key,source_name,source_url,source_year,updated_at)
         VALUES ($1,'浦东',$2,$3,$4,'{}'::text[],$5::jsonb,$6,'上海市浦东新区教育局/上海市人民政府',$7,$8,now())
         ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING RETURNING id`,
        [row.name, row.stage, nature, row.address, JSON.stringify({ official_school_info_source: raw, source_kind: "official_pudong_school_catalogue" }), officialSchoolSourceKey(row), row.sourceUrl, Number(sourceDate(row.sourceTitle)?.slice(0, 4) ?? 0) || null],
      );
      if (!result.rows[0]) continue;
      inserted += 1;
      const sourceResult = await client.query(
        `INSERT INTO public.web_data_source (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at)
         VALUES ($1,'official_school_info','上海市浦东新区教育局/上海市人民政府',$2,$3,$4,$5,'high',$6::jsonb,now(),now())
         ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=excluded.fetched_at,updated_at=now()`,
        [result.rows[0].id, row.sourceUrl, row.sourceTitle, sourceDate(row.sourceTitle), evidence, JSON.stringify(raw)],
      );
      sourcesUpserted += sourceResult.rowCount ?? 0;
    }
    writeFileSync(path.join(paths.dir, "source-rows.json"), JSON.stringify(sourceRows, null, 2), "utf8");
    writeFileSync(path.join(paths.dir, "existing-schools.json"), JSON.stringify(existing, null, 2), "utf8");
    writeFileSync(paths.report, JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: sourceRows.length, candidates: selection.candidates.length, inserted, sourcesUpserted, actions }, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: sourceRows.length, candidates: selection.candidates.length, inserted, sourcesUpserted, report: paths.report }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("import-official-pudong-schools.ts")) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
