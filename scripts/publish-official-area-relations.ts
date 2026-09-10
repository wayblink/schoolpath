/**
 * Publish strict official enrollment-area evidence into the catalog relation
 * explorer without pretending that an administrative area is a residential
 * POI or a verified school-community assignment.
 *
 * Dry-run is the default; pass --apply to commit. The stable negative source
 * ID prevents collision with ingest.extracted_records IDs used by other feeds.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const year = Number(valueArg("--year") ?? "2026");
const districtArg = valueArg("--district");
const limit = Number(valueArg("--limit") ?? "0");
const statuses = listArg("--status", ["pending"]);
const confidences = listArg("--confidence", ["high", "medium"]);

if (!Number.isInteger(year) || year < 2000) throw new Error("--year must be a valid year.");
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer.");

type Candidate = {
  id: number;
  school_id: number | null;
  school_name_raw: string;
  district: string;
  year: number;
  community_name_raw: string;
  committee_name_raw: string | null;
  source_url: string | null;
  source_title: string;
  source_date: string | null;
  source_quote: string;
  confidence: string;
  status: string;
  raw: Record<string, unknown> | null;
};

type School = { id: number; name: string; type: string; district: string };

type Action = {
  candidateId: number;
  schoolId: number | null;
  district: string;
  schoolName: string;
  areaName: string;
  sourceUrl: string | null;
  action: "dry-run" | "upsert" | "skip";
  reason?: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function listArg(name: string, fallback: string[]) {
  const value = valueArg(name);
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : fallback;
}

function normalizeDistrict(value: string) {
  return value.replace(/上海市/g, "").replace(/浦东新区/g, "浦东").replace(/区$/, "").trim();
}

function isGovernmentUrl(value: string | null) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "gov.cn" || hostname.endsWith(".gov.cn");
  } catch {
    return false;
  }
}

/** Pure names only: no embedded road/address/range syntax. */
export function isPureOfficialAreaName(value: string) {
  const name = value.replace(/[\s\u00a0]/g, "").trim();
  if (name.length < 2 || name.length > 60) return false;
  if (/[：:]/.test(name)) return false;
  if (/[0-9０-９]/.test(name)) return false;
  if (/(路|弄|号|街|公路|大道|范围|以东|以西|以南|以北|号段|门牌|道路)/.test(name)) return false;
  if (/^(统筹|待定|其他|无|合计|总计)$/.test(name)) return false;
  return true;
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-");
  const suffix = (districtArg ?? "citywide").replace(/[^\p{L}\p{N}_-]/gu, "_");
  const dir = path.join(process.cwd(), ".tmp", "official-area-relations", `${stamp}-${suffix}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const dir = outputDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Action[] = [];
  let upserted = 0;
  try {
    const candidates = (
      await client.query<Candidate>(
        `SELECT id,school_id,school_name_raw,district,year,community_name_raw,committee_name_raw,
                source_url,source_title,source_date,source_quote,confidence,status,raw
           FROM public.school_community_candidates
          WHERE year=$3 AND status=ANY($1::text[]) AND confidence=ANY($2::text[])
            AND ($4::text IS NULL OR district=$4)
            AND COALESCE((raw->>'boundaryOnly')::boolean,false)=false
          ORDER BY id
          ${limit > 0 ? `LIMIT ${limit}` : ""}`,
        [statuses, confidences, year, districtArg ?? null],
      )
    ).rows;
    writeFileSync(path.join(dir, "candidates-source.json"), JSON.stringify(candidates, null, 2), "utf8");

    const schoolIds = candidates.map((candidate) => candidate.school_id).filter((id): id is number => id !== null);
    const schools = schoolIds.length
      ? (await client.query<School>("SELECT id,name,type,district FROM public.schools WHERE id=ANY($1::int[])", [schoolIds])).rows
      : [];
    const schoolById = new Map(schools.map((school) => [school.id, school]));

    await client.query("BEGIN");
    for (const candidate of candidates) {
      const school = candidate.school_id ? schoolById.get(candidate.school_id) : undefined;
      const areaName = candidate.committee_name_raw?.trim() || candidate.community_name_raw.trim();
      const reason = !school
        ? "school_id is missing or school no longer exists"
        : !isGovernmentUrl(candidate.source_url)
          ? "source URL is not a government domain"
          : normalizeDistrict(school.district) !== normalizeDistrict(candidate.district)
            ? "school and candidate districts differ"
            : !isPureOfficialAreaName(areaName)
              ? "area name contains road, address, range, or scoped punctuation"
              : null;
      if (reason) {
        actions.push({ candidateId: candidate.id, schoolId: candidate.school_id, district: candidate.district, schoolName: candidate.school_name_raw, areaName, sourceUrl: candidate.source_url, action: "skip", reason });
        continue;
      }

      const attrs = {
        official_area_level: "administrative_or_enrollment_area",
        candidate_id: candidate.id,
        source_title: candidate.source_title,
        source_date: candidate.source_date,
        source_quote: candidate.source_quote,
        extraction: candidate.raw?.extraction ?? null,
        residential_poi: false,
        verified: false,
      };
      if (apply) {
        await client.query(
          `INSERT INTO catalog.school_district_relations(
             source_record_id,source_name,source_url,source_year,district,school_name,school_type,
             committee_name,area,street,school_id,catalog_school_id,catalog_community_id,
             school_match_score,community_match_score,match_status,review_status,verified,attrs
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,NULL,$9::int,$9::bigint,NULL,1,0,'school_matched','provisional',false,$10::jsonb)
           ON CONFLICT(source_record_id) DO UPDATE SET
             source_name=excluded.source_name,source_url=excluded.source_url,source_year=excluded.source_year,
             district=excluded.district,school_name=excluded.school_name,school_type=excluded.school_type,
             committee_name=excluded.committee_name,area=excluded.area,school_id=excluded.school_id,
             catalog_school_id=excluded.catalog_school_id,match_status=excluded.match_status,
             review_status='provisional',verified=false,attrs=excluded.attrs,updated_at=now()`,
          [-(candidate.id), "official_school_community_candidates:official_area_level", candidate.source_url, candidate.year, candidate.district, candidate.school_name_raw, school!.type, areaName, candidate.school_id, JSON.stringify(attrs)],
        );
        upserted += 1;
      }
      actions.push({ candidateId: candidate.id, schoolId: candidate.school_id, district: candidate.district, schoolName: candidate.school_name_raw, areaName, sourceUrl: candidate.source_url, action: apply ? "upsert" : "dry-run" });
    }

    const report = path.join(dir, apply ? "official-area-relations-applied.json" : "official-area-relations-dry-run.json");
    writeFileSync(report, JSON.stringify({ mode: apply ? "apply" : "dry-run", year, district: districtArg ?? null, candidates: candidates.length, planned: actions.filter((action) => action.action !== "skip").length, upserted, actions }, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", year, district: districtArg ?? null, candidates: candidates.length, planned: actions.filter((action) => action.action !== "skip").length, upserted, report }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("publish-official-area-relations.ts")) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
