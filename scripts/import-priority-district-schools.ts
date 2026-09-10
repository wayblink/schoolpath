/**
 * Safely import missing school master rows for priority districts.
 *
 * Safety rules:
 * - default mode is dry-run; pass --apply to insert
 * - snapshots current district school rows before any write
 * - inserts missing schools only; never deletes, truncates, resets, or seeds
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
const sourcePath =
  valueArg("--source") ?? path.join(process.cwd(), ".tmp", "official-school-info", "latest-with-attachments.json");
const prioritySourcePath = valueArg("--priority-source") ?? path.join(process.cwd(), "data", "priority-district-schools.json");
const districts = (valueArg("--districts") ?? "普陀,杨浦")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

type SchoolType = "primary" | "middle" | "nine_year";
type Stage = "primary" | "middle" | "unknown";

type OfficialBasicRow = {
  district: string;
  stage: Stage;
  name: string;
  campus?: string;
  nature?: string;
  address?: string;
  sourceTitle?: string;
  sourceUrl?: string;
};

type SourceFile = {
  generatedAt?: string;
  records?: OfficialBasicRow[];
};

type PrioritySourceFile = {
  items?: ImportRow[];
};

type ImportRow = {
  district: string;
  type: SchoolType;
  name: string;
  nature: string;
  address: string;
  sourceName: string;
  sourceUrl: string;
  sourceDate: string;
  sourceNote?: string;
};

type ExistingSchoolRow = {
  id: number;
  district: string;
  name: string;
  type: SchoolType;
  address: string | null;
};

type ReportRow = {
  source: ImportRow;
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
  const dir = path.join(process.cwd(), ".tmp", "priority-district-school-import", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "schools-before.json"),
    parsed: path.join(dir, "parsed-priority-schools.json"),
    report: path.join(dir, apply ? "import-applied.json" : "import-dry-run.json"),
  };
}

function stageToType(stage: Stage, name: string): SchoolType {
  if (stage === "primary") return "primary";
  if (stage === "middle") return "middle";
  if (/九年|一贯|学校/.test(name) && !/小学|中学/.test(name)) return "nine_year";
  return "primary";
}

function normalizeName(value: string) {
  return value
    .replace(/^上海市/, "")
    .replace(/[\s　·•\-—]+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/小学部|初中部/g, "")
    .replace(/区/g, "")
    .trim();
}

function sourceKey(row: Pick<ImportRow, "district" | "type" | "name">) {
  return `${row.district}::${row.type}::${normalizeName(row.name)}`;
}

function campusLabel(row: OfficialBasicRow) {
  const fromCampus = row.campus?.trim();
  if (fromCampus) return fromCampus;
  const address = row.address ?? "";
  const addressCampus = address.match(/[（(]\s*([^）)]{1,16}(?:校区|总部|分部|本部))\s*[）)]/)?.[1]?.trim();
  return addressCampus;
}

function mergeOfficialRows(rows: ImportRow[]) {
  const merged = new Map<string, ImportRow>();
  for (const row of rows) {
    const key = sourceKey(row);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, row);
      continue;
    }
    const addresses = new Set(
      `${existing.address}；${row.address}`
        .split(/[；;]/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
    merged.set(key, {
      ...existing,
      address: Array.from(addresses).join("；"),
    });
  }
  return Array.from(merged.values());
}

function loadPutuoRows() {
  if (!existsSync(sourcePath)) return [];
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as SourceFile;
  const rows = (source.records ?? [])
    .filter((record) => record.district === "普陀" && record.name?.trim() && record.address?.trim())
    .map((record): ImportRow => {
      const label = campusLabel(record);
      const name =
        label && !record.name.includes(label) && /校区/.test(label)
          ? `${record.name}（${label}）`
          : record.name.trim();
      return {
        district: record.district,
        type: stageToType(record.stage, record.name),
        name,
        nature: record.nature?.trim() || "",
        address: record.address?.trim() || "",
        sourceName: record.sourceTitle || "2025年普陀区义务教育阶段学校教育教学、后勤设施设备和师资配置基本情况表",
        sourceUrl: record.sourceUrl || "",
        sourceDate: "2025-11-10",
        sourceNote: `从本地官方学校基础信息文件导入：${sourcePath}`,
      };
    });
  return mergeOfficialRows(rows);
}

function loadPriorityRows() {
  if (!existsSync(prioritySourcePath)) return [];
  const source = JSON.parse(readFileSync(prioritySourcePath, "utf8")) as PrioritySourceFile;
  return (source.items ?? []).filter((row) => row.district && row.type && row.name?.trim() && row.address?.trim());
}

function attrsFor(row: ImportRow) {
  return {
    data_source: row.sourceName,
    policy_url: row.sourceUrl,
    school_nature: natureToPublicPrivate(row.nature),
    official_school_info_source: {
      name: row.sourceName,
      url: row.sourceUrl,
      date: row.sourceDate,
      note: row.sourceNote,
      fetched_from: row.district === "普陀" ? sourcePath : prioritySourcePath,
    },
  };
}

function natureToPublicPrivate(nature: string) {
  if (nature.includes("民办")) return "private";
  if (nature.includes("公办")) return "public";
  return "";
}

async function main() {
  const parsedRows = [...loadPutuoRows(), ...loadPriorityRows()].filter((row) => districts.includes(row.district));
  const paths = outputPaths();
  writeFileSync(paths.parsed, JSON.stringify(parsedRows, null, 2), "utf8");

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const existing = await client.query<ExistingSchoolRow>(
      `
        SELECT id, district, name, type, address
        FROM schools
        WHERE district = ANY($1::text[])
        ORDER BY district, id
      `,
      [districts],
    );
    writeFileSync(paths.snapshot, JSON.stringify(existing.rows, null, 2), "utf8");

    const existingByKey = new Map(existing.rows.map((school) => [sourceKey(school), school]));
    const seenSourceKeys = new Set<string>();
    const report: ReportRow[] = [];
    let inserted = 0;
    let skippedExisting = 0;
    let skippedDuplicateSource = 0;

    console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
    console.log(`Districts: ${districts.join(", ")}`);
    console.log(`Parsed priority schools: ${parsedRows.length}`);
    console.log(`Existing target schools: ${existing.rows.length}`);
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
            name, district, tier, type, address, pit_risk_level, attrs, updated_at
          )
          VALUES ($1, $2, '未入榜/待补充', $3, $4, 'unknown', $5::jsonb, now())
          RETURNING id
        `,
        [row.name, row.district, row.type, row.address, JSON.stringify(attrsFor(row))],
      );
      const id = result.rows[0]!.id;
      existingByKey.set(key, { id, district: row.district, name: row.name, type: row.type, address: row.address });
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
          wouldInsert: report.filter((item) => item.action === "dry-run-insert").length,
          inserted,
          skippedExisting,
          skippedDuplicateSource,
        },
        null,
        2,
      ),
    );
    console.log("No deletes, resets, seeds, communities, or school_communities rows were touched.");
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
