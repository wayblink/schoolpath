/**
 * Safely backfill official school boundary text from reviewed official files.
 *
 * Safety rules:
 * - default mode is dry-run; pass --apply to write
 * - only updates schools.attrs, never communities or school_communities
 * - never deletes, truncates, resets, seeds, or cascades anything
 * - never overwrites existing official boundary fields unless --force is passed
 * - every UPDATE is guarded by id + district + name
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const force = process.argv.includes("--force");
const district = valueArg("--district") ?? "奉贤";

type SchoolRow = {
  id: number;
  district: string;
  type: "primary" | "middle" | "nine_year";
  name: string;
  attrs: Record<string, unknown> | null;
};

type BoundaryRecord = {
  town: string;
  schoolName: string;
  boundaryText: string;
  areaItems: string[];
  administrativeAreaItems: string[];
  committees: string[];
  explicitCommunities: string[];
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
};

type ReportRow = {
  source: BoundaryRecord;
  school: Pick<SchoolRow, "id" | "name" | "type"> | null;
  action:
    | "dry-run"
    | "update"
    | "skip-district-filter"
    | "skip-not-found"
    | "skip-ambiguous-match"
    | "skip-existing-official-field"
    | "skip-empty-boundary";
  matchedBy?: string;
  candidates?: Array<Pick<SchoolRow, "id" | "name" | "type">>;
  updatedRows: number;
};

type Cell = { ref: string; row: number; col: number; value: string };

const fengxianSourceTitle = "2025年奉贤区义务教育阶段公办学校学区划分";
const fengxianSourceUrl = "https://xxgk.fengxian.gov.cn/art/info/9595/i20250408-mkbqe7v0xqibcfvdrs";
const fengxianSourceDate = "2025-04-07";
const fengxianXlsx = path.join(process.cwd(), ".tmp", "fengxian-attachments", "districts-0.xlsx");
const huangpuSourceTitle = "2025年黄浦区公办小学办学基本情况公示表（含对口范围）";
const huangpuSourceUrl = "https://www.shanghai.gov.cn/hpqywjy/20250416/e1823c7eac2a46af9a27036dc13f3715.html";
const huangpuSourceDate = "2025-04-16";
const huangpuHtml = path.join(process.cwd(), ".tmp", "huangpu-primary-range.html");

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-school-area-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "target-schools-before.json"),
    parsed: path.join(dir, "parsed-official-boundaries.json"),
    report: path.join(dir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

function xmlDecode(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&#xA;/gi, "\n")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(Number.parseInt(n, 16)));
}

function cleanHtmlText(html: string) {
  return normalizeSpaces(
    xmlDecode(
      html
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/p>|<\/div>|<\/li>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{2,}/g, "\n"),
    ),
  );
}

function cleanCell(value: string) {
  return normalizeSpaces(value).replace(/^[-—]+$/, "").trim();
}

function attrNumber(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i"));
  return match ? Number(match[1]) : 1;
}

function parseHtmlTable(tableHtml: string) {
  const rows: string[][] = [];
  const spans = new Map<number, { text: string; remaining: number }>();
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(tableHtml))) {
    const row: string[] = [];
    let col = 0;
    const tdRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let td: RegExpExecArray | null;

    function flushSpans() {
      while (spans.has(col)) {
        const span = spans.get(col)!;
        row[col] = span.text;
        span.remaining -= 1;
        if (span.remaining <= 0) spans.delete(col);
        col += 1;
      }
    }

    flushSpans();
    while ((td = tdRe.exec(tr[1] ?? ""))) {
      flushSpans();
      const text = cleanCell(cleanHtmlText(td[3] ?? ""));
      const rowspan = attrNumber(td[2] ?? "", "rowspan");
      const colspan = attrNumber(td[2] ?? "", "colspan");
      for (let i = 0; i < colspan; i += 1) {
        row[col + i] = text;
        if (rowspan > 1) spans.set(col + i, { text, remaining: rowspan - 1 });
      }
      col += colspan;
    }
    flushSpans();
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function unzipText(xlsxPath: string, entry: string) {
  return execFileSync("unzip", ["-p", xlsxPath, entry], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
}

function parseSharedStrings(xml: string) {
  const strings: string[] = [];
  for (const si of xml.matchAll(/<si\b[\s\S]*?<\/si>/g)) {
    const text = [...si[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlDecode(m[1])).join("");
    strings.push(text);
  }
  return strings;
}

function columnNumber(ref: string) {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "";
  let value = 0;
  for (const ch of letters) value = value * 26 + ch.charCodeAt(0) - 64;
  return value;
}

function rowNumber(ref: string) {
  return Number(ref.match(/\d+$/)?.[0] ?? "0");
}

function parseCells(sheetXml: string, sharedStrings: string[]) {
  const cells = new Map<string, Cell>();
  const xmlWithoutEmptyCells = sheetXml.replace(/<c\b[^>]*\/>/g, "");
  for (const match of xmlWithoutEmptyCells.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attrs = match[1];
    const body = match[2];
    const ref = attrs.match(/\br="([^"]+)"/)?.[1];
    if (!ref) continue;
    const type = attrs.match(/\bt="([^"]+)"/)?.[1];
    const rawValue = body.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? "";
    let value = "";
    if (type === "s") value = sharedStrings[Number(rawValue)] ?? "";
    else if (type === "inlineStr") value = xmlDecode(body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "");
    else value = xmlDecode(rawValue);
    cells.set(ref, { ref, row: rowNumber(ref), col: columnNumber(ref), value: normalizeSpaces(value) });
  }
  return cells;
}

function parseMergeRanges(sheetXml: string) {
  return [...sheetXml.matchAll(/<mergeCell\b[^>]*\bref="([^"]+)"/g)].map((m) => m[1]);
}

function expandMergedCells(cells: Map<string, Cell>, ranges: string[]) {
  for (const range of ranges) {
    const [start, end] = range.split(":");
    if (!start || !end) continue;
    const source = cells.get(start);
    if (!source || !source.value) continue;
    const startCol = columnNumber(start);
    const endCol = columnNumber(end);
    const startRow = rowNumber(start);
    const endRow = rowNumber(end);
    for (let row = startRow; row <= endRow; row++) {
      for (let col = startCol; col <= endCol; col++) {
        const ref = `${columnName(col)}${row}`;
        if (!cells.get(ref)?.value) cells.set(ref, { ref, row, col, value: source.value });
      }
    }
  }
}

function columnName(num: number) {
  let name = "";
  while (num > 0) {
    const rem = (num - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    num = Math.floor((num - 1) / 26);
  }
  return name;
}

function normalizeSpaces(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function normalizeName(value: string) {
  return normalizeSpaces(value)
    .replace(/^上海市/, "")
    .replace(/^奉贤区/, "")
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[()]/g, "")
    .replace(/校区$/g, "")
    .trim();
}

function splitBoundaryItems(text: string) {
  return normalizeSpaces(text)
    .replace(/\n/g, "、")
    .replace(/小学学区[:：]/g, "")
    .replace(/初中学区[:：]/g, "")
    .replace(/[；;]/g, "、")
    .split(/[、，,]/)
    .map((item) => normalizeSpaces(item).replace(/[。.]$/g, ""))
    .filter(Boolean);
}

function stripAddressSuffix(item: string) {
  return item
    .replace(/[（(][^()（）]*(路|弄|号|街|公路|大道)[^()（）]*[)）]/g, "")
    .replace(/[（(]筹备[)）]/g, "筹备")
    .trim();
}

function isDirectionalBoundary(item: string) {
  return /^(东至|西至|南至|北至)/.test(item) || /(东至|西至|南至|北至).*(东至|西至|南至|北至)/.test(item);
}

function isCommitteeLike(item: string) {
  const cleaned = stripAddressSuffix(item);
  if (isDirectionalBoundary(cleaned)) return false;
  return /(居委|社区)$/.test(cleaned) || /(居委筹备组|居委\(筹备\)|居委（筹备）)/.test(cleaned);
}

function isAdministrativeAreaLike(item: string) {
  const cleaned = stripAddressSuffix(item);
  if (isDirectionalBoundary(cleaned)) return false;
  return /(居委|社区|村|街道|镇|开发区|旅游区|全区招生)$/.test(cleaned) || /(居委筹备组|居委\(筹备\)|居委（筹备）)/.test(cleaned);
}

function isExplicitCommunityLike(item: string) {
  const cleaned = stripAddressSuffix(item);
  if (isDirectionalBoundary(cleaned)) return false;
  if (isCommitteeLike(cleaned)) return false;
  return /(小区|新村|花园|苑|公寓|别墅|名都|华庭|雅苑|家园|佳苑|丽景|兰亭|馨苑|美颂|戈雅园|名墅|公馆|乐庭|璞悦|新筑|一村|二村|三村|四村|二区|三区|四区|B区)$/.test(cleaned);
}

function uniq(values: string[]) {
  return [...new Set(values.map((v) => normalizeSpaces(v)).filter(Boolean))];
}

function normalizeCommitteeName(item: string) {
  const cleaned = stripAddressSuffix(item)
    .replace(/(居委会|居民委员会)$/g, "居委")
    .replace(/(居委|社区)$/g, "")
    .trim();
  return cleaned ? `${cleaned}居委` : "";
}

function extractCommittees(text: string, options: { appendCommitteeSuffix?: boolean } = {}) {
  const items = splitBoundaryItems(text).map(stripAddressSuffix);
  if (options.appendCommitteeSuffix) return uniq(items.map(normalizeCommitteeName).filter(Boolean));
  return uniq(items.filter(isCommitteeLike));
}

function extractAdministrativeAreaItems(text: string) {
  return uniq(splitBoundaryItems(text).map(stripAddressSuffix).filter(isAdministrativeAreaLike));
}

function extractAreaItems(text: string) {
  return uniq(splitBoundaryItems(text).map(stripAddressSuffix).filter((item) => !isDirectionalBoundary(item)));
}

function extractExplicitCommunities(text: string) {
  return uniq(splitBoundaryItems(text).map(stripAddressSuffix).filter(isExplicitCommunityLike));
}

function toBoundaryRecord(town: string, schoolName: string, boundaryText: string): BoundaryRecord {
  return {
    town,
    schoolName,
    boundaryText,
    areaItems: extractAreaItems(boundaryText),
    administrativeAreaItems: extractAdministrativeAreaItems(boundaryText),
    committees: extractCommittees(boundaryText),
    explicitCommunities: extractExplicitCommunities(boundaryText),
    sourceTitle: fengxianSourceTitle,
    sourceUrl: fengxianSourceUrl,
    sourceDate: fengxianSourceDate,
  };
}

function toBoundaryRecordWithSource(
  town: string,
  schoolName: string,
  boundaryText: string,
  source: Pick<BoundaryRecord, "sourceTitle" | "sourceUrl" | "sourceDate">,
  options: { appendCommitteeSuffix?: boolean } = {},
): BoundaryRecord {
  return {
    town,
    schoolName,
    boundaryText,
    areaItems: extractAreaItems(boundaryText),
    administrativeAreaItems: extractAdministrativeAreaItems(boundaryText),
    committees: extractCommittees(boundaryText, options),
    explicitCommunities: extractExplicitCommunities(boundaryText),
    sourceTitle: source.sourceTitle,
    sourceUrl: source.sourceUrl,
    sourceDate: source.sourceDate,
  };
}

function parseFengxianBoundaries() {
  if (!existsSync(fengxianXlsx)) throw new Error(`Missing official attachment: ${fengxianXlsx}`);

  const workDir = mkdtempSync(path.join(tmpdir(), "house-xlsx-"));
  try {
    const sharedXml = unzipText(fengxianXlsx, "xl/sharedStrings.xml");
    const sheetXml = unzipText(fengxianXlsx, "xl/worksheets/sheet1.xml");
    const sharedStrings = parseSharedStrings(sharedXml);
    const cells = parseCells(sheetXml, sharedStrings);
    expandMergedCells(cells, parseMergeRanges(sheetXml));

    const rawRecords: Array<{ town: string; schoolName: string; boundaryText: string }> = [];
    for (let row = 3; row <= 72; row++) {
      const town = cells.get(`A${row}`)?.value ?? "";
      const schoolName = cells.get(`B${row}`)?.value ?? "";
      const boundaryText = cells.get(`C${row}`)?.value ?? "";
      if (!schoolName || !boundaryText) continue;
      rawRecords.push({ town, schoolName, boundaryText });
    }

    const grouped = new Map<string, { town: string; schoolName: string; parts: string[] }>();
    for (const record of rawRecords) {
      const key = `${record.town}::${normalizeName(record.schoolName)}`;
      const existing = grouped.get(key);
      if (existing) existing.parts.push(record.boundaryText);
      else grouped.set(key, { town: record.town, schoolName: record.schoolName, parts: [record.boundaryText] });
    }

    return [...grouped.values()].map((record) =>
      toBoundaryRecord(record.town, record.schoolName, uniq(record.parts).join("\n")),
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function parseHuangpuBoundaries() {
  if (!existsSync(huangpuHtml)) throw new Error(`Missing official page snapshot: ${huangpuHtml}`);

  const html = readFileSync(huangpuHtml, "utf8");
  const table = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error(`No table found in official page snapshot: ${huangpuHtml}`);

  const rows = parseHtmlTable(table);
  const headers = rows[2] ?? [];
  const schoolIndex = headers.findIndex((cell) => /学校名称/.test(cell));
  const streetIndex = headers.findIndex((cell) => /所属街道/.test(cell));
  const committeeIndex = headers.findIndex((cell) => /对口居委/.test(cell));
  if (schoolIndex < 0 || committeeIndex < 0) {
    throw new Error(`Could not find 黄浦 school/committee columns in ${huangpuHtml}`);
  }

  return rows
    .slice(3)
    .map((row) => {
      const schoolName = cleanCell(row[schoolIndex] ?? "");
      const town = cleanCell(streetIndex >= 0 ? (row[streetIndex] ?? "") : "");
      const committeeText = cleanCell(row[committeeIndex] ?? "");
      if (!schoolName || !committeeText || /学校名称|合计|备注/.test(schoolName)) return null;
      return toBoundaryRecordWithSource(
        town,
        schoolName,
        committeeText,
        {
          sourceTitle: huangpuSourceTitle,
          sourceUrl: huangpuSourceUrl,
          sourceDate: huangpuSourceDate,
        },
        { appendCommitteeSuffix: true },
      );
    })
    .filter((record): record is BoundaryRecord => Boolean(record));
}

function findSchool(record: BoundaryRecord, schools: SchoolRow[]) {
  const sourceName = normalizeName(record.schoolName);
  const exact = schools.filter((school) => normalizeName(school.name) === sourceName);
  if (exact.length === 1) return { school: exact[0], matchedBy: "exact" };
  if (exact.length > 1) return { candidates: exact };

  const contains = schools.filter((school) => {
    const dbName = normalizeName(school.name);
    return dbName.includes(sourceName) || sourceName.includes(dbName);
  });
  if (contains.length === 1) return { school: contains[0], matchedBy: "contains" };
  if (contains.length > 1) return { candidates: contains };

  return {};
}

function hasOfficialField(attrs: Record<string, unknown> | null) {
  if (!attrs) return false;
  return Boolean(attrs.official_boundary_text || attrs.official_boundary_source);
}

function buildAttrs(existing: Record<string, unknown> | null, record: BoundaryRecord) {
  const attrs = { ...(existing ?? {}) };
  delete attrs.official_boundary_text;
  delete attrs.official_boundary_town;
  delete attrs.official_boundary_source;
  delete attrs.official_matching_committees;
  delete attrs.official_explicit_communities;
  delete attrs.official_boundary_verified;
  delete attrs.official_area_items;
  delete attrs.official_administrative_area_items;
  delete attrs.official_committee_items;
  delete attrs.official_residential_area_items;

  return {
    ...attrs,
    official_boundary_text: record.boundaryText,
    official_boundary_town: record.town,
    official_boundary_source: {
      name: record.sourceTitle,
      url: record.sourceUrl,
      date: record.sourceDate,
      district,
      importedAt: new Date().toISOString(),
    },
    official_area_items: record.areaItems,
    official_administrative_area_items: record.administrativeAreaItems,
    official_committee_items: record.committees,
    official_residential_area_items: record.explicitCommunities,
    official_boundary_verified: true,
  };
}

async function main() {
  if (!["奉贤", "黄浦"].includes(district)) {
    console.log(`Only 奉贤 and 黄浦 are implemented in this official-source script. requested=${district}`);
  }

  const paths = outputPaths();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const schoolsResult = await client.query<SchoolRow>(
      `
        SELECT id, district, type, name, attrs
        FROM schools
        WHERE district = $1
        ORDER BY id
      `,
      [district],
    );
    const schools = schoolsResult.rows;
    writeFileSync(paths.snapshot, JSON.stringify(schools, null, 2));

    const records =
      district === "奉贤" ? parseFengxianBoundaries() : district === "黄浦" ? parseHuangpuBoundaries() : [];
    writeFileSync(paths.parsed, JSON.stringify(records, null, 2));

    const report: ReportRow[] = [];
    for (const record of records) {
      if (!record.boundaryText) {
        report.push({ source: record, school: null, action: "skip-empty-boundary", updatedRows: 0 });
        continue;
      }

      const match = findSchool(record, schools);
      if (!match.school) {
        report.push({
          source: record,
          school: null,
          action: match.candidates?.length ? "skip-ambiguous-match" : "skip-not-found",
          candidates: match.candidates?.map(({ id, name, type }) => ({ id, name, type })),
          updatedRows: 0,
        });
        continue;
      }

      const school = match.school;
      if (hasOfficialField(school.attrs) && !force) {
        report.push({
          source: record,
          school: { id: school.id, name: school.name, type: school.type },
          action: "skip-existing-official-field",
          matchedBy: match.matchedBy,
          updatedRows: 0,
        });
        continue;
      }

      if (!apply) {
        report.push({
          source: record,
          school: { id: school.id, name: school.name, type: school.type },
          action: "dry-run",
          matchedBy: match.matchedBy,
          updatedRows: 0,
        });
        continue;
      }

      const updatedAttrs = buildAttrs(school.attrs, record);
      const updateResult = await client.query(
        `
          UPDATE schools
          SET attrs = $1::jsonb, updated_at = now()
          WHERE id = $2
            AND district = $3
            AND name = $4
        `,
        [JSON.stringify(updatedAttrs), school.id, school.district, school.name],
      );

      report.push({
        source: record,
        school: { id: school.id, name: school.name, type: school.type },
        action: "update",
        matchedBy: match.matchedBy,
        updatedRows: updateResult.rowCount ?? 0,
      });
    }

    writeFileSync(paths.report, JSON.stringify(report, null, 2));

    const counts = report.reduce<Record<string, number>>((acc, row) => {
      acc[row.action] = (acc[row.action] ?? 0) + 1;
      return acc;
    }, {});

    console.log(`official school area backfill (${district})`);
    console.log(`mode: ${apply ? "APPLY" : "DRY-RUN"}${force ? " force" : ""}`);
    console.log(`source records: ${records.length}`);
    console.table(counts);
    console.log(`snapshot: ${paths.snapshot}`);
    console.log(`parsed:   ${paths.parsed}`);
    console.log(`report:   ${paths.report}`);

    const notFound = report.filter((row) => row.action === "skip-not-found" || row.action === "skip-ambiguous-match");
    if (notFound.length > 0) {
      console.log("\nunmatched official school rows:");
      for (const row of notFound) {
        console.log(`- ${row.source.schoolName} (${row.source.town}) -> ${row.action}`);
      }
    }

    console.log("\nNo communities or school_communities rows were touched.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
