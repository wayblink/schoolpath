/**
 * Safely import missing Baoshan school master rows from official Shanghai Gov pages.
 *
 * Safety rules:
 * - default mode is dry-run; pass --apply to insert
 * - only inserts into schools; never deletes, truncates, resets, seeds, or touches mappings
 * - snapshots current Baoshan school rows and writes a match/import report under .tmp
 * - skips existing schools by district + normalized name + type
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const sourcePath = valueArg("--source") ?? path.join(process.cwd(), ".tmp", "official-school-info", "latest.json");
const district = "宝山";
const year = 2025;

type SchoolType = "primary" | "middle" | "nine_year";

type SourceLink = {
  district: string;
  title: string;
  url: string;
};

type SourceFile = {
  generatedAt: string;
  links: SourceLink[];
};

type OfficialSchoolRow = {
  district: string;
  type: SchoolType;
  name: string;
  address: string;
  enrollmentNote: string;
  currentStudents: string;
  admissionPlanClasses: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceDate: string;
  officialItems: string[];
  committeeItems: string[];
  residentialAreaItems: string[];
};

type ExistingSchoolRow = {
  id: number;
  district: string;
  name: string;
  type: SchoolType;
  address: string | null;
  attrs: Record<string, unknown> | null;
};

type ReportRow = {
  source: OfficialSchoolRow;
  action: "dry-run-insert" | "insert" | "skip-existing" | "skip-duplicate-source";
  existing?: Pick<ExistingSchoolRow, "id" | "name" | "type">;
  insertedId?: number;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "baoshan-school-import", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "baoshan-schools-before.json"),
    parsed: path.join(dir, "parsed-official-baoshan-schools.json"),
    report: path.join(dir, apply ? "import-applied.json" : "import-dry-run.json"),
  };
}

function decodeHtml(value: string) {
  return value
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number.parseInt(num, 10)));
}

function cleanText(html: string) {
  return decodeHtml(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/[ \t\r\f\v　]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{2,}/g, "\n"),
  ).trim();
}

function cleanCell(value: string) {
  return value.replace(/\s+/g, " ").replace(/^[-—]+$/, "").trim();
}

function attrNumber(attrs: string, name: string) {
  const match = attrs.match(new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i"));
  return match ? Number(match[1]) : 1;
}

function parseTable(tableHtml: string) {
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
      const text = cleanCell(cleanText(td[3] ?? ""));
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

function articleDate(html: string) {
  const raw = html.match(/<meta\s+name=["']PubDate["']\s+content=["']([^"']+)["']/i)?.[1] ?? "";
  const normalized = raw.replace(/[∶：]/g, ":").match(/\d{4}-\d{2}-\d{2}/)?.[0];
  return normalized ?? "2025-04-07";
}

function inferType(title: string): SchoolType {
  if (/小学/.test(title)) return "primary";
  if (/初中/.test(title)) return "middle";
  return "nine_year";
}

function findColumn(header: string[], pattern: RegExp) {
  return header.findIndex((cell) => pattern.test(cell));
}

function splitOfficialItems(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[、，,；;]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function committeeItems(items: string[]) {
  return items.filter((item) => /居委|村委|村$|筹/.test(item));
}

function residentialAreaItems(items: string[]) {
  return items.filter((item) => !/居委|村委|村$/.test(item));
}

async function fetchText(url: string) {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 baoshan-school-import/1.0" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  return await res.text();
}

async function parseOfficialRows(links: SourceLink[]) {
  const rows: OfficialSchoolRow[] = [];
  const targetLinks = links.filter(
    (link) => link.district === district && /校区范围与招生计划/.test(link.title) && /小学|初中/.test(link.title),
  );
  for (const link of targetLinks) {
    const html = await fetchText(link.url);
    const sourceDate = articleDate(html);
    const type = inferType(link.title);
    for (const tableMatch of html.matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
      const tableRows = parseTable(tableMatch[0]);
      if (tableRows.length === 0) continue;
      const headerIndex = tableRows.findIndex((row) => /学校名称/.test(row.join(" ")) && /学校地址/.test(row.join(" ")));
      if (headerIndex < 0) continue;

      const header = tableRows[headerIndex]!;
      const nameIndex = findColumn(header, /学校名称/);
      const addressIndex = findColumn(header, /学校地址/);
      const rangeIndex = findColumn(header, /范围|对口|入学/);
      const currentStudentsIndex = findColumn(header, /目前在校人数/);
      const admissionPlanIndex = findColumn(header, /招生计划数/);
      if (nameIndex < 0 || addressIndex < 0 || rangeIndex < 0) continue;

      for (const row of tableRows.slice(headerIndex + 1)) {
        const name = cleanCell(row[nameIndex] ?? "");
        const address = cleanCell(row[addressIndex] ?? "");
        const enrollmentNote = cleanCell(row[rangeIndex] ?? "");
        if (!name || !address || !enrollmentNote) continue;
        if (/学校名称|合计|备注|说明/.test(name)) continue;
        const officialItems = splitOfficialItems(enrollmentNote);
        rows.push({
          district,
          type,
          name,
          address,
          enrollmentNote,
          currentStudents: cleanCell(row[currentStudentsIndex] ?? ""),
          admissionPlanClasses: cleanCell(row[admissionPlanIndex] ?? ""),
          sourceTitle: link.title,
          sourceUrl: link.url,
          sourceDate,
          officialItems,
          committeeItems: committeeItems(officialItems),
          residentialAreaItems: residentialAreaItems(officialItems),
        });
      }
    }
  }
  return disambiguateDuplicateRows(rows);
}

function normalizeName(value: string) {
  return value
    .replace(/^上海市/, "")
    .replace(/^宝山区/, "")
    .replace(/\s+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/[·•\-—]/g, "")
    .trim();
}

function campusLabel(row: OfficialSchoolRow) {
  const addressCampus = row.address.match(/[（(]\s*([^）)]{1,16}校区)\s*[）)]/)?.[1]?.trim();
  if (addressCampus) return addressCampus;

  const addressPrefix = row.address.match(/^([^：:]{1,12})[：:]/)?.[1]?.trim();
  if (addressPrefix) return addressPrefix;

  const shortBoundary = row.enrollmentNote.trim();
  if (shortBoundary && shortBoundary.length <= 16 && !/[、，,；;]/.test(shortBoundary)) return shortBoundary;

  return undefined;
}

function appendCampusName(name: string, label: string | undefined) {
  if (!label) return name;
  if (name.includes(`（${label}）`) || name.includes(`(${label})`)) return name;
  return `${name}（${label}）`;
}

function disambiguateDuplicateRows(rows: OfficialSchoolRow[]) {
  const groups = new Map<string, OfficialSchoolRow[]>();
  for (const row of rows) {
    const key = `${row.district}::${row.type}::${normalizeName(row.name)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return rows.map((row) => {
    const group = groups.get(`${row.district}::${row.type}::${normalizeName(row.name)}`) ?? [];
    if (group.length <= 1) return row;

    const label = campusLabel(row);
    const name = appendCampusName(row.name, label);
    return name === row.name ? row : { ...row, name };
  });
}

function sourceKey(row: Pick<OfficialSchoolRow, "district" | "type" | "name">) {
  return `${row.district}::${row.type}::${normalizeName(row.name)}`;
}

function attrsFor(row: OfficialSchoolRow) {
  return {
    data_source: "上海市人民政府/宝山区教育局 2025 校区范围与招生计划",
    policy_url: row.sourceUrl,
    official_school_info_source: {
      name: row.sourceTitle,
      url: row.sourceUrl,
      date: row.sourceDate,
      fetched_from: sourcePath,
    },
    official_boundary_text: row.enrollmentNote,
    official_boundary_source: row.sourceUrl,
    official_boundary_verified: true,
    official_area_items: row.officialItems,
    official_committee_items: row.committeeItems,
    official_residential_area_items: row.residentialAreaItems,
    official_current_students: row.currentStudents,
    official_admission_plan_classes: row.admissionPlanClasses,
  };
}

async function main() {
  if (!existsSync(sourcePath)) throw new Error(`Source JSON not found: ${sourcePath}`);
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as SourceFile;
  const paths = outputPaths();
  const parsedRows = await parseOfficialRows(source.links ?? []);
  writeFileSync(paths.parsed, JSON.stringify(parsedRows, null, 2), "utf8");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const existing = await client.query<ExistingSchoolRow>(
      `
        SELECT id, district, name, type, address, attrs
        FROM schools
        WHERE district = $1
        ORDER BY id
      `,
      [district],
    );
    writeFileSync(paths.snapshot, JSON.stringify(existing.rows, null, 2), "utf8");

    const existingByKey = new Map(existing.rows.map((row) => [sourceKey(row), row]));
    const seenSourceKeys = new Set<string>();
    const report: ReportRow[] = [];
    let inserted = 0;
    let skippedExisting = 0;
    let skippedDuplicateSource = 0;

    console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
    console.log(`Source: ${sourcePath}`);
    console.log(`Parsed Baoshan official rows: ${parsedRows.length}`);
    console.log(`Existing Baoshan schools: ${existing.rows.length}`);
    console.log(`Snapshot: ${paths.snapshot}`);
    console.log(`Parsed: ${paths.parsed}`);

    await client.query("BEGIN");
    for (const row of parsedRows) {
      const key = sourceKey(row);
      const existingSchool = existingByKey.get(key);
      if (existingSchool) {
        skippedExisting += 1;
        report.push({
          source: row,
          action: "skip-existing",
          existing: { id: existingSchool.id, name: existingSchool.name, type: existingSchool.type },
        });
        continue;
      }

      if (seenSourceKeys.has(key)) {
        skippedDuplicateSource += 1;
        report.push({ source: row, action: "skip-duplicate-source" });
        continue;
      }
      seenSourceKeys.add(key);

      if (!apply) {
        report.push({ source: row, action: "dry-run-insert" });
        continue;
      }

      const result = await client.query<{ id: number }>(
        `
          INSERT INTO schools (
            name, district, tier, type, address, enrollment_note, pit_risk_level, attrs, updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'unknown', $7::jsonb, now())
          RETURNING id
        `,
        [
          row.name,
          row.district,
          "未入榜/待补充",
          row.type,
          row.address,
          row.enrollmentNote,
          JSON.stringify(attrsFor(row)),
        ],
      );
      const id = result.rows[0]!.id;
      existingByKey.set(key, { id, district: row.district, name: row.name, type: row.type, address: row.address, attrs: attrsFor(row) });
      inserted += 1;
      report.push({ source: row, action: "insert", insertedId: id });
    }

    writeFileSync(paths.report, JSON.stringify(report, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(`Report: ${paths.report}`);
    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "dry-run",
          parsed: parsedRows.length,
          existing: existing.rows.length,
          wouldInsert: report.filter((row) => row.action === "dry-run-insert").length,
          inserted,
          skippedExisting,
          skippedDuplicateSource,
        },
        null,
        2,
      ),
    );
    console.log("No communities or school_communities rows were touched.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
