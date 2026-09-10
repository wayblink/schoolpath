/**
 * Fill blank enrollment notes from unmapped 2026 学区助手 relation rows.
 *
 * Matching is deliberately strict: same district, same stage (primary/middle
 * or a nine-year school), and exactly one normalized school name. Relation
 * rows are third-party context only; this script never writes school-community
 * relations or changes review/verification state. Dry-run is the default.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

export type RelationSchool = {
  id: number;
  name: string;
  district: string;
  type: string;
  aliases?: string[] | null;
  enrollmentNote?: string | null;
};

export type RelationRow = {
  id: number;
  schoolName: string;
  district: string;
  schoolType: string | null;
  committeeName: string | null;
  area: string | null;
  street: string | null;
  sourceUrl: string | null;
};

export type RelationGroup = {
  schoolId: number;
  schoolName: string;
  district: string;
  schoolType: string;
  relationIds: number[];
  committeeNames: string[];
  areas: string[];
  streets: string[];
  sourceUrls: string[];
  rows: RelationRow[];
};

export function normalizeRelationSchoolName(value: string) {
  return value
    .replace(/[\s　·•\-—]/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市/, "")
    .replace(/新区|区/g, "")
    .replace(/教育集团|集团校|小学部|初中部|中学部/g, "")
    .trim();
}

function normalizeDistrict(value: string) {
  return value.replace(/新区|区/g, "").trim();
}

function stageMatches(sourceType: string | null, schoolType: string) {
  if (!sourceType) return false;
  if (sourceType === "primary") return schoolType === "primary" || schoolType === "nine_year";
  if (sourceType === "middle") return schoolType === "middle" || schoolType === "nine_year";
  return sourceType === schoolType;
}

/** Return a school only when the constrained exact match is unique. */
export function matchUniqueSchool(
  relation: Pick<RelationRow, "district" | "schoolType" | "schoolName">,
  schools: RelationSchool[],
) {
  const normalizedName = normalizeRelationSchoolName(relation.schoolName);
  const matches = schools.filter((school) => {
    if (normalizeDistrict(school.district) !== normalizeDistrict(relation.district)) return false;
    if (!stageMatches(relation.schoolType, school.type)) return false;
    return [school.name, ...(school.aliases ?? [])].some((name) => normalizeRelationSchoolName(name) === normalizedName);
  });
  return matches.length === 1 ? matches[0] : null;
}

function uniqueValues(values: Array<string | null | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))].sort();
}

export function aggregateRelationRows(rows: Array<RelationRow & { schoolId: number }>): RelationGroup[] {
  const bySchool = new Map<number, RelationGroup>();
  for (const row of rows) {
    const existing = bySchool.get(row.schoolId);
    if (existing) {
      existing.relationIds.push(row.id);
      existing.rows.push(row);
      existing.committeeNames = uniqueValues([...existing.committeeNames, row.committeeName]);
      existing.areas = uniqueValues([...existing.areas, row.area]);
      existing.streets = uniqueValues([...existing.streets, row.street]);
      existing.sourceUrls = uniqueValues([...existing.sourceUrls, row.sourceUrl]);
      continue;
    }
    bySchool.set(row.schoolId, {
      schoolId: row.schoolId,
      schoolName: row.schoolName,
      district: row.district,
      schoolType: row.schoolType ?? "",
      relationIds: [row.id],
      committeeNames: uniqueValues([row.committeeName]),
      areas: uniqueValues([row.area]),
      streets: uniqueValues([row.street]),
      sourceUrls: uniqueValues([row.sourceUrl]),
      rows: [row],
    });
  }
  return [...bySchool.values()].sort((a, b) => a.district.localeCompare(b.district) || a.schoolName.localeCompare(b.schoolName));
}

function buildEnrollmentNote(group: RelationGroup) {
  const fields = [
    group.areas.length ? `片区：${group.areas.join("、")}` : "",
    group.streets.length ? `街道：${group.streets.join("、")}` : "",
    group.committeeNames.length ? `委员会/居委：${group.committeeNames.join("、")}` : "",
  ].filter(Boolean);
  if (!fields.length) return "";
  return `2026学区助手资料（第三方）：${fields.join("；")}。该资料仅作招生信息参考，不代表官方招生范围，也不代表学校与住宅小区的归属关系。`;
}

function reportDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "third-party-relation-admission-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const dir = reportDir();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    const schools = (await client.query<RelationSchool>(`
      SELECT id, name, district, type::text AS type, aliases,
             enrollment_note AS "enrollmentNote"
      FROM public.schools
      ORDER BY district, id
    `)).rows;
    const relations = (await client.query<RelationRow>(`
      SELECT id, school_name AS "schoolName", district,
             school_type AS "schoolType", committee_name AS "committeeName",
             area, street, source_url AS "sourceUrl"
      FROM catalog.school_district_relations
      WHERE source_name = '学区助手'
        AND catalog_school_id IS NULL
        AND nullif(btrim(school_name), '') IS NOT NULL
      ORDER BY district, id
    `)).rows;
    const matched: Array<RelationRow & { schoolId: number }> = [];
    let ambiguous = 0;
    let unmatched = 0;
    for (const relation of relations) {
      const school = matchUniqueSchool(relation, schools);
      if (!school) {
        const normalized = normalizeRelationSchoolName(relation.schoolName);
        const constrained = schools.filter((candidate) => normalizeDistrict(candidate.district) === normalizeDistrict(relation.district) && stageMatches(relation.schoolType, candidate.type) && [candidate.name, ...(candidate.aliases ?? [])].some((name) => normalizeRelationSchoolName(name) === normalized));
        if (constrained.length > 1) ambiguous += 1; else unmatched += 1;
        continue;
      }
      matched.push({ ...relation, schoolId: school.id });
    }
    const groups = aggregateRelationRows(matched);
    const blankSchoolIds = new Set(schools.filter((school) => !school.enrollmentNote?.trim()).map((school) => school.id));
    const candidates = groups.filter((group) => blankSchoolIds.has(group.schoolId) && buildEnrollmentNote(group));
    const actions: Array<Record<string, unknown>> = [];
    let notesFilled = 0;
    let sourcesUpserted = 0;
    for (const group of candidates) {
      const note = buildEnrollmentNote(group);
      const raw = {
        migration: "third_party_relation_enrollment_note",
        source_name: "学区助手",
        source_url: group.sourceUrls[0] ?? "https://xuequzhushou.cn/",
        source_urls: group.sourceUrls,
        source_year: 2026,
        school_name: group.schoolName,
        district: group.district,
        school_type: group.schoolType,
        relation_ids: group.relationIds,
        areas: group.areas,
        streets: group.streets,
        committee_names: group.committeeNames,
        boundary_assertion: false,
        community_relation_assertion: false,
        raw_rows: group.rows,
      };
      const update = await client.query(
        `UPDATE public.schools
         SET enrollment_note = $1,
             attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{third_party_relation_enrollment_note}', $2::jsonb, true),
             updated_at = now()
         WHERE id = $3
           AND (enrollment_note IS NULL OR btrim(enrollment_note) = '')
         RETURNING id`,
        [note, JSON.stringify(raw), group.schoolId],
      );
      if (update.rowCount) {
        const source = await client.query(
          `INSERT INTO public.web_data_source(
             school_id, source_type, source_name, source_url, source_title,
             source_date, evidence, confidence, raw, fetched_at, created_at, updated_at
           ) VALUES ($1, 'third_party_admission', '学区助手', $2, $3, '2026', $4, 'medium', $5::jsonb, now(), now(), now())
           ON CONFLICT (school_id, source_url, source_type)
           DO UPDATE SET source_title = excluded.source_title,
                         source_date = excluded.source_date,
                         evidence = excluded.evidence,
                         confidence = excluded.confidence,
                         raw = excluded.raw,
                         fetched_at = now(), updated_at = now()
           RETURNING id`,
          [group.schoolId, group.sourceUrls[0] ?? "https://xuequzhushou.cn/", `${group.schoolName} 2026招生信息（第三方）`, "学区助手关系表，仅作第三方招生信息参考，不代表官方招生范围或学校-小区归属。", JSON.stringify(raw)],
        );
        sourcesUpserted += source.rowCount ?? 0;
        notesFilled += update.rowCount;
      }
      actions.push({ schoolId: group.schoolId, schoolName: group.schoolName, district: group.district, relationIds: group.relationIds, note, noteAction: update.rowCount ? "filled" : "skipped_nonblank" });
    }
    const summary = { mode: apply ? "apply" : "dry-run", relationRows: relations.length, matchedRows: matched.length, ambiguous, unmatched, matchedSchools: groups.length, candidates: candidates.length, notesFilled, sourcesUpserted, reportDir: dir };
    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ ...summary, actions }, null, 2));
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
