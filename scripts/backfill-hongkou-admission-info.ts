/**
 * Fill blank Hongkou middle-school admission notes from the official 2025
 * public-middle-school PDF parsed by round12.
 *
 * The PDF's ninth column is an explicit school-level "对口小学" field. It is
 * kept as a note and source evidence; it is deliberately not promoted to a
 * school-community relation because it describes feeder schools, not housing
 * committee boundaries.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to commit
 * - only official public-middle PDF rows with a non-empty raw[8]
 * - strict district + middle-stage normalized-name match, exactly one school
 * - only fills blank enrollment_note; never overwrites existing fields
 * - writes a snapshot and per-row report; every applied row gets provenance
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
  feederPrimary?: string;
  action: "update" | "dry-run" | "skip-no-source" | "skip-ambiguous" | "skip-no-feeder" | "skip-existing-note" | "skip-incompatible-stage";
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
    .replace(/虹口区/g, "")
    .replace(/教育集团|集团校|初中部/g, "")
    .trim();
}

function sourceDate(title: string) {
  const year = title.match(/20\d{2}/)?.[0];
  return year ? `${year}-01-01` : null;
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-hongkou-admission", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  if (!existsSync(sourcePath)) throw new Error(`Source JSON not found: ${sourcePath}`);
  const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as { records?: SourceRecord[] };
  const sourceRows = (parsed.records ?? []).filter(
    (row) =>
      row.district === "虹口" &&
      row.stage === "middle" &&
      row.sourceTitle.includes("公办初中") &&
      Array.isArray(row.raw) &&
      Boolean(row.raw[8]?.trim()) &&
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
         WHERE district='虹口'
         ORDER BY id`,
      )
    ).rows;
    writeFileSync(path.join(dir, "target-schools-before.json"), JSON.stringify(schools, null, 2), "utf8");
    writeFileSync(path.join(dir, "source-records.json"), JSON.stringify(sourceRows, null, 2), "utf8");

    await client.query("BEGIN");
    for (const school of schools) {
      if (school.type !== "middle") {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-incompatible-stage", reason: "仅导入独立初中实体；九年一贯制不自动合并" });
        continue;
      }
      const candidates = byName.get(normalizeName(school.name)) ?? [];
      if (candidates.length === 0) {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-no-source", reason: "无唯一虹口公办初中官方记录" });
        continue;
      }
      const unique = [...new Map(candidates.map((row) => [`${row.sourceUrl}|${row.name}`, row])).values()];
      if (unique.length !== 1) {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-ambiguous", reason: `官方记录 ${unique.length} 条，需人工确认实体` });
        continue;
      }
      const source = unique[0];
      const feederPrimary = source.raw?.[8]?.trim() ?? "";
      if (!feederPrimary) {
        actions.push({ schoolId: school.id, schoolName: school.name, action: "skip-no-feeder", reason: "官方字段为空" });
        continue;
      }
      if (school.enrollment_note?.trim()) {
        actions.push({ schoolId: school.id, schoolName: school.name, sourceName: source.name, sourceUrl: source.sourceUrl, feederPrimary, action: "skip-existing-note", reason: "保留已有招生说明" });
        continue;
      }

      const note = `2025年虹口区公办初中对口小学：${feederPrimary}`;
      const raw = {
        district: source.district,
        stage: source.stage,
        source_name: source.name,
        source_title: source.sourceTitle,
        source_url: source.sourceUrl,
        feeder_primary: feederPrimary,
        raw_row: source.raw,
      };
      const evidence = `${source.sourceTitle}；学校：${source.name}；对口小学：${feederPrimary}`;
      if (apply) {
        const update = await client.query(
          `UPDATE public.schools
           SET enrollment_note=$1,
               attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_hongkou_admission_2025}',$2::jsonb,true),
               updated_at=now()
           WHERE id=$3 AND district='虹口' AND name=$4
             AND (enrollment_note IS NULL OR btrim(enrollment_note)='')`,
          [note, JSON.stringify(raw), school.id, school.name],
        );
        updates += update.rowCount ?? 0;
        const sourceResult = await client.query(
          `INSERT INTO public.web_data_source
             (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at)
           VALUES ($1,'official_admission','虹口区教育局',$2,$3,$4,$5,'high',$6::jsonb,now(),now())
           ON CONFLICT (school_id,source_url,source_type) DO UPDATE SET
             source_title=excluded.source_title,source_date=excluded.source_date,
             evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,
             fetched_at=now(),updated_at=now()
           RETURNING id`,
          [school.id, source.sourceUrl, source.sourceTitle, sourceDate(source.sourceTitle), evidence, JSON.stringify(raw)],
        );
        sourcesUpserted += sourceResult.rowCount ?? 0;
      }
      actions.push({ schoolId: school.id, schoolName: school.name, sourceName: source.name, sourceUrl: source.sourceUrl, feederPrimary, action: apply ? "update" : "dry-run" });
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
