/**
 * Fill blank school nature/address from unique, stage-compatible official rows.
 *
 * This is intentionally narrower than the fuzzy school-info backfill:
 * - dry-run by default; pass --apply to commit
 * - requires one unique source row for the district/name/stage key
 * - only fills blank canonical fields and never overwrites hand-maintained data
 * - records the source evidence in attrs and web_data_source
 * - does not turn a basic-info table into an enrollment/catchment note
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const sourcePath = valueArg("--source") ?? path.join(process.cwd(), "data/audit/official-school-info/latest-with-attachments.json");
const district = valueArg("--district");

type SourceRecord = {
  district: string;
  stage: "primary" | "middle" | "unknown";
  name: string;
  campus?: string;
  nature: string;
  address: string;
  sourceTitle: string;
  sourceUrl: string;
};

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  address: string | null;
  school_nature: "公立" | "私立" | null;
  enrollment_note: string | null;
  attrs: Record<string, unknown> | null;
};

type Action = {
  schoolId: number;
  schoolName: string;
  district: string;
  sourceName: string;
  sourceTitle: string;
  sourceUrl: string;
  sourceNature: string;
  action: "update" | "dry-run" | "skip-no-valid-nature" | "skip-ambiguous" | "skip-no-source";
  filled: { address: boolean; schoolNature: boolean; provenance: boolean };
  reason?: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function compactName(value: string) {
  return value
    .replace(/[\s　·•\-—]+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市/, "")
    .replace(/（.*?）|\(.*?\)/g, "")
    .trim();
}

function normalizedName(value: string) {
  return compactName(value)
    .replace(/区/g, "")
    .replace(/教育集团|集团校|小学部|初中部/g, "")
    .replace(/学校名称/g, "")
    .trim();
}

function sourceStageForSchool(type: SchoolRow["type"]) {
  if (type === "primary") return "primary";
  if (type === "middle") return "middle";
  return "unknown";
}

function natureEnum(value: string): "公立" | "私立" | null {
  if (/公办/.test(value)) return "公立";
  if (/民办/.test(value)) return "私立";
  return null;
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-exact-school-info", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    schools: path.join(dir, "target-schools-before.json"),
    sources: path.join(dir, "source-records.json"),
    report: path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"),
  };
}

function sourceDate(sourceTitle: string) {
  const match = sourceTitle.match(/20\d{2}/);
  return match?.[0] ? `${match[0]}-01-01` : null;
}

function uniqueSourceRows(rows: SourceRecord[]) {
  return [...new Map(rows.map((row) => [`${row.sourceUrl}|${row.name}|${row.address}`, row])).values()];
}

function normalizedNatureSet(rows: SourceRecord[]) {
  return new Set(rows.map((row) => natureEnum(row.nature)).filter((value): value is "公立" | "私立" => Boolean(value)));
}

async function main() {
  if (!existsSync(sourcePath)) throw new Error(`Source JSON not found: ${sourcePath}`);
  const parsed = JSON.parse(readFileSync(sourcePath, "utf8")) as { records: SourceRecord[] };
  const sources = parsed.records.filter((row) => row.sourceUrl?.trim() && row.name?.trim());
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const paths = outputPaths();

  try {
    const params: string[] = [];
    const where = ["true"];
    if (district) {
      params.push(district);
      where.push(`district = $${params.length}`);
    }
    const result = await client.query<SchoolRow>(
      `SELECT id,name,district,type,address,school_nature,enrollment_note,attrs FROM public.schools WHERE ${where.join(" AND ")} ORDER BY district,id`,
      params,
    );
    writeFileSync(paths.schools, JSON.stringify(result.rows, null, 2), "utf8");
    writeFileSync(paths.sources, JSON.stringify(sources, null, 2), "utf8");

    const byKey = new Map<string, SourceRecord[]>();
    for (const source of sources) {
      for (const nameKey of [compactName(source.name), normalizedName(source.name)]) {
        const key = `${source.district}|${source.stage}|${nameKey}`;
        const current = byKey.get(key) ?? [];
        current.push(source);
        byKey.set(key, current);
      }
    }

    const actions: Action[] = [];
    let updates = 0;
    let sourcesUpserted = 0;
    await client.query("BEGIN");
    for (const school of result.rows) {
      const stage = sourceStageForSchool(school.type);
      if (school.type === "nine_year" && stage === "unknown") {
        const candidates = uniqueSourceRows([
          ...(byKey.get(`${school.district}|unknown|${compactName(school.name)}`) ?? []),
          ...(byKey.get(`${school.district}|unknown|${normalizedName(school.name)}`) ?? []),
        ]);
        const natureValues = normalizedNatureSet(candidates);
        const validNature = natureValues.size === 1 ? [...natureValues][0] : null;
        const explicitCandidates = candidates.filter((candidate) => Boolean(natureEnum(candidate.nature)));
        const uniqueAddresses = [...new Set(explicitCandidates.map((candidate) => candidate.address?.trim()).filter(Boolean))];
        if (!candidates.length || !explicitCandidates.length) {
          actions.push({ schoolId: school.id, schoolName: school.name, district: school.district, sourceName: "", sourceTitle: "", sourceUrl: "", sourceNature: "", action: "skip-no-source", filled: { address: false, schoolNature: false, provenance: false }, reason: "九年一贯制学校没有明确性质的 unknown-stage 官方记录" });
          continue;
        }
        if (!validNature) {
          actions.push({ schoolId: school.id, schoolName: school.name, district: school.district, sourceName: explicitCandidates[0]?.name ?? "", sourceTitle: explicitCandidates[0]?.sourceTitle ?? "", sourceUrl: explicitCandidates[0]?.sourceUrl ?? "", sourceNature: explicitCandidates.map((candidate) => candidate.nature).join(" | "), action: "skip-ambiguous", filled: { address: false, schoolNature: false, provenance: false }, reason: "九年一贯制官方记录的性质标签不一致" });
          continue;
        }
        const source = explicitCandidates[0]!;
        const fillNature = !school.school_nature && Boolean(validNature);
        const fillAddress = !school.address?.trim() && uniqueAddresses.length === 1;
        const filled = { address: fillAddress, schoolNature: fillNature, provenance: true };
        const evidence = `官方学校信息：${source.sourceTitle}；公开名称：${source.name}；办学性质：${source.nature}${fillAddress ? `；地址：${uniqueAddresses[0]}` : "；多校区地址仅登记来源"}`;
        for (const sourceRow of explicitCandidates) {
          const sourceRaw = JSON.stringify({ district: school.district, school: school.name, matched_name: sourceRow.name, source_title: sourceRow.sourceTitle, source_url: sourceRow.sourceUrl, nature: sourceRow.nature, address: sourceRow.address, stage: sourceRow.stage, multi_campus: uniqueAddresses.length > 1 });
          if (apply) {
            await client.query(
              `INSERT INTO public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at) VALUES($1,'official_school_info','上海市各区教育局/政府公开信息',$2,$3,$4,$5,'high',$6::jsonb,now(),now()) ON CONFLICT (school_id, source_url, source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=excluded.fetched_at,updated_at=now()` ,
              [school.id, sourceRow.sourceUrl, sourceRow.sourceTitle, sourceDate(sourceRow.sourceTitle), evidence, sourceRaw],
            );
            sourcesUpserted += 1;
          }
        }
        if (apply) {
          const sourceRaw = JSON.stringify({ district: school.district, school: school.name, matched_name: source.name, source_title: source.sourceTitle, source_url: source.sourceUrl, nature: source.nature, address: fillAddress ? uniqueAddresses[0] : "", stage: source.stage, multi_campus: uniqueAddresses.length > 1 });
          const update = await client.query(
            `UPDATE public.schools SET address=CASE WHEN (address IS NULL OR btrim(address)='') THEN NULLIF($1,'') ELSE address END, school_nature=CASE WHEN school_nature IS NULL THEN $2::school_nature ELSE school_nature END, attrs=CASE WHEN attrs ? 'official_school_info_source' THEN attrs ELSE jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_school_info_source}',$3::jsonb,true) END, updated_at=now() WHERE id=$4 AND district=$5 AND name=$6 AND school_nature IS NULL`,
            [fillAddress ? uniqueAddresses[0] : "", fillNature ? validNature : null, sourceRaw, school.id, school.district, school.name],
          );
          updates += update.rowCount ?? 0;
        }
        actions.push({ schoolId: school.id, schoolName: school.name, district: school.district, sourceName: source.name, sourceTitle: source.sourceTitle, sourceUrl: source.sourceUrl, sourceNature: source.nature, action: apply ? "update" : "dry-run", filled });
        continue;
      }
      const candidates = [
        ...(byKey.get(`${school.district}|${stage}|${compactName(school.name)}`) ?? []),
        ...(byKey.get(`${school.district}|${stage}|${normalizedName(school.name)}`) ?? []),
      ];
      const unique = [...new Map(candidates.map((candidate) => [candidate.sourceUrl + "|" + candidate.name, candidate])).values()];
      if (unique.length !== 1) {
        actions.push({ schoolId: school.id, schoolName: school.name, district: school.district, sourceName: "", sourceTitle: "", sourceUrl: "", sourceNature: "", action: unique.length ? "skip-ambiguous" : "skip-no-source", filled: { address: false, schoolNature: false, provenance: false }, reason: unique.length ? `官方同名记录 ${unique.length} 条，需人工确认校区/实体` : "无严格同名官方记录" });
        continue;
      }
      const source = unique[0];
      const normalizedNature = natureEnum(source.nature);
      const fillAddress = !school.address?.trim() && Boolean(source.address?.trim());
      const fillNature = !school.school_nature && Boolean(normalizedNature);
      const filled = { address: fillAddress, schoolNature: fillNature, provenance: true };
      const base = { schoolId: school.id, schoolName: school.name, district: school.district, sourceName: source.name, sourceTitle: source.sourceTitle, sourceUrl: source.sourceUrl, sourceNature: source.nature, filled };
      const evidence = `官方学校信息：${source.sourceTitle}；公开名称：${source.name}${source.nature ? `；办学性质：${source.nature}` : ""}${source.address ? `；地址：${source.address}` : ""}`;
      const sourceRaw = JSON.stringify({ district: school.district, school: school.name, matched_name: source.name, source_title: source.sourceTitle, source_url: source.sourceUrl, nature: source.nature, address: source.address, stage: source.stage });
      if (apply) {
        const update = await client.query(
          `UPDATE public.schools SET address=CASE WHEN (address IS NULL OR btrim(address)='') THEN NULLIF($1,'') ELSE address END, school_nature=CASE WHEN school_nature IS NULL THEN $2::school_nature ELSE school_nature END, attrs=CASE WHEN attrs ? 'official_school_info_source' THEN attrs ELSE jsonb_set(coalesce(attrs,'{}'::jsonb),'{official_school_info_source}',$3::jsonb,true) END, updated_at=now() WHERE id=$4 AND district=$5 AND name=$6`,
          [fillAddress ? source.address : "", fillNature ? normalizedNature : null, sourceRaw, school.id, school.district, school.name],
        );
        updates += update.rowCount ?? 0;
        const sourceResult = await client.query(
          `INSERT INTO public.web_data_source(school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,updated_at) VALUES($1,'official_school_info','上海市各区教育局/政府公开信息',$2,$3,$4,$5,'high',$6::jsonb,now(),now()) ON CONFLICT (school_id, source_url, source_type) DO UPDATE SET source_title=excluded.source_title,source_date=excluded.source_date,evidence=excluded.evidence,confidence=excluded.confidence,raw=excluded.raw,fetched_at=excluded.fetched_at,updated_at=now() RETURNING id`,
          [school.id, source.sourceUrl, source.sourceTitle, sourceDate(source.sourceTitle), evidence, sourceRaw],
        );
        sourcesUpserted += sourceResult.rowCount ?? 0;
      }
      actions.push({ ...base, action: apply ? "update" : "dry-run" });
    }
    writeFileSync(paths.report, JSON.stringify(actions, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", targets: result.rows.length, eligible: actions.filter((a) => a.action === "update" || a.action === "dry-run").length, updates, sourcesUpserted, report: paths.report }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
