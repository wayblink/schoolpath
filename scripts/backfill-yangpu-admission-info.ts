/**
 * Fill blank Yangpu primary-school admission notes from the official 2025 PDF.
 *
 * The final PDF column is explicitly labelled "招收班级数". It is kept as a
 * school-level admission note and source evidence. This script does not infer
 * housing-community boundaries or create school_communities relations.
 * Dry-run is the default; pass --apply to commit the audited changes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const sourcePath = valueArg("--source") ?? path.join(process.cwd(), ".tmp/official-school-info/round12-official-pdfs.json");

type SourceRecord = {
  district: string;
  stage: string;
  name: string;
  sourceTitle: string;
  sourceUrl: string;
  raw?: string[];
};

type School = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  enrollment_note: string | null;
  attrs: Record<string, unknown> | null;
};

type Action = {
  schoolId: number;
  schoolName: string;
  sourceName?: string;
  sourceUrl?: string;
  classPlan?: string;
  action: "update" | "dry-run" | "skip-no-source" | "skip-ambiguous" | "skip-invalid-plan" | "skip-existing-note" | "skip-incompatible-stage";
  reason?: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function normalizeName(value: string) {
  return value
    .replace(/[\s　·•\-—]/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市/, "")
    .replace(/杨浦区/g, "")
    .replace(/教育集团|集团校|小学部|初中部/g, "")
    .trim();
}

function sourceDate(title: string) {
  const year = title.match(/20\d{2}/)?.[0];
  return year ? `${year}-01-01` : null;
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-yangpu-admission", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function classPlan(raw: string[] | undefined) {
  const value = raw?.[raw.length - 1]?.trim() ?? "";
  return /^\d+(?:\.\d+)?$/.test(value) ? value : "";
}

async function main() {
  if (!existsSync(sourcePath)) throw new Error(`Source JSON not found: ${sourcePath}`);
  const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as { records?: SourceRecord[] };
  const sourceRows = (parsed.records ?? []).filter(
    (row) =>
      row.district === "杨浦" &&
      row.stage === "primary" &&
      row.sourceTitle.includes("杨浦区") &&
      row.sourceTitle.includes("公办小学") &&
      Boolean(row.sourceUrl?.trim()),
  );
  const byName = new Map<string, SourceRecord[]>();
  for (const row of sourceRows) {
    const key = normalizeName(row.name);
    byName.set(key, [...(byName.get(key) ?? []), row]);
  }

  const dir = outputDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let updates = 0;
  let sourcesUpserted = 0;
  const actions: Action[] = [];

  try {
    const schools = (
      await client.query<School>(
        `SELECT id,name,district,type,enrollment_note,attrs
         FROM public.schools
         WHERE district='杨浦'
         ORDER BY id`,
      )
    ).rows;
    writeFileSync(path.join(dir, "target-schools-before.json"), JSON.stringify(schools, null, 2), "utf8");
    writeFileSync(path.join(dir, "source-records.json"), JSON.stringify(sourceRows, null, 2), "utf8");

    await client.query("BEGIN");
    for (const school of schools) {
      if (school.type !== "primary") {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-incompatible-stage", reason: "仅导入独立小学实体；九年一贯制不自动跨学段合并" });
        continue;
      }
      const candidates = byName.get(normalizeName(school.name)) ?? [];
      if (candidates.length === 0) {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-no-source", reason: "无唯一杨浦公办小学官方记录" });
        continue;
      }
      const unique = [...new Map(candidates.map((row) => [`${row.sourceUrl}|${row.name}`, row])).values()];
      if (unique.length !== 1) {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-ambiguous", reason: `官方记录 ${unique.length} 条，需人工确认实体` });
        continue;
      }
      const source = unique[0]!;
      const plannedClasses = classPlan(source.raw);
      if (!plannedClasses) {
        actions.push({ schoolId: school.id, schoolName: school.name, sourceName: source.name, sourceUrl: source.sourceUrl, action: "skip-invalid-plan", reason: "官方最后一列缺少可解析的招收班级数" });
        continue;
      }
      if (school.enrollment_note?.trim()) {
        actions.push({ schoolId: school.id, schoolName: school.name, sourceName: source.name, sourceUrl: source.sourceUrl, classPlan: plannedClasses, action: "skip-existing-note", reason: "保留已有招生说明" });
        continue;
      }

      const note = `2025年杨浦区公办小学招生计划：招收${plannedClasses}个班`;
      const raw = {
        district: source.district,
        stage: source.stage,
        source_name: source.name,
        source_title: source.sourceTitle,
        source_url: source.sourceUrl,
        admission_field: "招收班级数",
        planned_classes: plannedClasses,
        raw_row: source.raw,
      };
      const evidence = `${source.sourceTitle}；学校：${source.name}；招收班级数：${plannedClasses}`;
      if (apply) {
        const update = await client.query(
          `UPDATE public.schools
           SET enrollment_note=$1,
               attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_yangpu_admission_2025}',$2::jsonb,true),
               updated_at=now()
           WHERE id=$3 AND district='杨浦' AND name=$4
             AND (enrollment_note IS NULL OR btrim(enrollment_note)='')`,
          [note, JSON.stringify(raw), school.id, school.name],
        );
        updates += update.rowCount ?? 0;
        const sourceResult = await client.query(
          `INSERT INTO public.web_data_source
             (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at)
           VALUES ($1,'official_admission','杨浦区教育局',$2,$3,$4,$5,'high',$6::jsonb,now(),now())
           ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET
             source_title=excluded.source_title,source_date=excluded.source_date,
             evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,
             fetched_at=now(),updated_at=now()
           RETURNING id`,
          [school.id, source.sourceUrl, source.sourceTitle, sourceDate(source.sourceTitle), evidence, JSON.stringify(raw)],
        );
        sourcesUpserted += sourceResult.rowCount ?? 0;
      }
      actions.push({ schoolId: school.id, schoolName: school.name, sourceName: source.name, sourceUrl: source.sourceUrl, classPlan: plannedClasses, action: apply ? "update" : "dry-run" });
    }

    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceRows: sourceRows.length, schoolRows: schools.length, eligible: actions.filter((a) => a.action === "update" || a.action === "dry-run").length, updates, sourcesUpserted, report: dir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
