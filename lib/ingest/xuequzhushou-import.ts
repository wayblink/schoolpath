import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parseXuequzhushouHtml, type ParsedXuequzhushou, type SourceSchool } from "./xuequzhushou";

const PREFIX = "full:v1:";
const SOURCE_NAME = "学区助手";
type RawSchool = SourceSchool & Record<string, unknown>;
type Stage = "primary" | "middle";
export type RawImportRecord = { recordType: string; sourceKey: string; district: string | null; raw: unknown };
export type SchoolOccurrence = {
  recordKey: string; catalogKey: string; legacyKey: string; district: string;
  stage: Stage; school: RawSchool; duplicateName: boolean;
};
export type CommitteeOccurrence = {
  recordKey: string; school: SchoolOccurrence; committee: string;
};
export type XuequzhushouImportPlan = {
  parsed: ParsedXuequzhushou; sourceYear: number | null;
  records: RawImportRecord[]; schools: SchoolOccurrence[]; relations: CommitteeOccurrence[];
};
export type ImportClient = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};
export type PublicSchool = { id: number; name: string; aliases: string[] | null; district: string; type: string };
type Counts = { added: number; unchanged: number; changed: number; conflict: number; unmatched: number };
export type ImportReport = {
  mode: "apply" | "dry-run"; runId: string | null; sourceYear: number | null;
  contentHash: string; records: Counts; schools: Counts; relations: Counts;
  recordCounts: Record<string, number>; canonicalBefore: string; canonicalAfter: string;
  reconciled: boolean; conflicts: { sourceKey: string; reason: string }[];
};

function normalizeDistrict(name: string) {
  return name === "浦东新区" ? "浦东" : name.replace(/区$/, "");
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceYear(title: string): number | null {
  const years = [...new Set([...title.matchAll(/\b(20\d{2})\s*年/g)].map(match => Number(match[1])))];
  return years.length === 1 ? years[0] : null;
}

export function buildXuequzhushouImport(html: string, sourceUrl = "https://xuequzhushou.cn/"): XuequzhushouImportPlan {
  // The parser retains arbitrary fields; cloning also removes VM realm prototypes.
  const parsed = jsonClone(parseXuequzhushouHtml(html, sourceUrl));
  const records: RawImportRecord[] = [];
  const schools: SchoolOccurrence[] = [];
  const relations: CommitteeOccurrence[] = [];
  const add = (recordType: string, sourceKey: string, district: string | null, raw: unknown) => {
    records.push({ recordType, sourceKey: PREFIX + sourceKey, district, raw });
  };
  add("source_document", "document", null, { sourceUrl, sha256: parsed.contentHash, content: html, contentType: "text/html" });
  add("parsed_payload", "payload", null, parsed);
  add("district_order", "DISTRICTS", null, parsed.districtOrder);
  for (const [district, data] of Object.entries(parsed.districts)) {
    const districtKey = `ALL_DATA:${encodeURIComponent(district)}`;
    add("district", districtKey, district, data);
    (data.街道 ?? []).forEach((street, index) => add("street", `${districtKey}:street:${index}`, district, street));
    for (const [stage, items] of [["primary", data.小学 ?? []], ["middle", data.初中 ?? []]] as const) {
      const nameCounts = new Map<string, number>();
      items.forEach(school => nameCounts.set(school.名称, (nameCounts.get(school.名称) ?? 0) + 1));
      items.forEach((item, index) => {
        if (typeof item.名称 !== "string" || !item.名称) throw new Error(`Missing school name at ${districtKey}:${stage}:${index}`);
        const school = item as RawSchool;
        const key = `${districtKey}:${stage}:${index}`;
        const legacyKey = `${district}:${stage}:${school.名称}`;
        const duplicateName = nameCounts.get(school.名称)! > 1;
        const occurrence: SchoolOccurrence = {
          recordKey: PREFIX + key, catalogKey: duplicateName ? PREFIX + key : legacyKey,
          legacyKey, district, stage, school, duplicateName,
        };
        schools.push(occurrence);
        add("school", key, district, school);
        const committees = Array.isArray(school.对口居委) ? school.对口居委 : school.对口居委 == null ? [] : [school.对口居委];
        committees.forEach((committee, committeeIndex) => {
          const relationKey = `${key}:committee:${committeeIndex}`;
          add("committee_link", relationKey, district, { schoolSourceKey: occurrence.recordKey, committeeIndex, committee });
          if (typeof committee !== "string") throw new Error(`Invalid committee at ${relationKey}`);
          relations.push({ recordKey: PREFIX + relationKey, school: occurrence, committee });
        });
        if (Object.hasOwn(school, "对口初中")) {
          add("feeder_link", `${key}:feeder`, district, { schoolSourceKey: occurrence.recordKey, feeder: school.对口初中 });
        }
      });
    }
  }
  for (const [recordType, name, overlap] of [
    ["committee_overlap", "JUWOVERLAP", parsed.committeeOverlap],
    ["middle_school_overlap", "JUWOVERLAP_MS", parsed.middleSchoolOverlap],
  ] as const) {
    add("overlap_payload", name, null, overlap);
    for (const [district, entries] of Object.entries(overlap)) {
      if (entries && typeof entries === "object") {
        for (const [key, value] of Object.entries(entries)) {
          add(recordType, `${name}:${encodeURIComponent(district)}:${encodeURIComponent(key)}`, district, value);
        }
      } else {
        add(recordType, `${name}:${encodeURIComponent(district)}`, district, entries);
      }
    }
  }
  return { parsed, sourceYear: sourceYear(parsed.pageTitle), records, schools, relations };
}

export function matchPublicSchool(schools: PublicSchool[], district: string, stage: Stage, name: string) {
  const matches = schools.filter(school => normalizeDistrict(school.district) === normalizeDistrict(district)
    && school.type === stage && (school.name === name || school.aliases?.includes(name)));
  return { id: matches.length === 1 ? matches[0].id : null,
    status: matches.length === 1 ? "matched" : matches.length ? "conflict" : "unmatched" } as const;
}

function recordIdentity(record: RawImportRecord) {
  return JSON.stringify([record.recordType, record.sourceKey]);
}

export function reconcileRawRecords(expected: RawImportRecord[], actual: RawImportRecord[]) {
  const stored = new Map(actual.map(record => [recordIdentity(record), record]));
  if (expected.length !== actual.length || stored.size !== actual.length) throw new Error("Raw reconciliation count mismatch");
  for (const record of expected) {
    if (!isDeepStrictEqual(record, stored.get(recordIdentity(record)))) {
      throw new Error(`Raw reconciliation mismatch: ${record.sourceKey}`);
    }
  }
}

function counts(): Counts { return { added: 0, unchanged: 0, changed: 0, conflict: 0, unmatched: 0 }; }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringValue(value: unknown) { return typeof value === "string" ? value : null; }
function numberValue(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function integerValue(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) ? value : null; }

function schoolFields(plan: XuequzhushouImportPlan, occurrence: SchoolOccurrence) {
  const school = occurrence.school;
  return {
    source_key: occurrence.catalogKey, source_name: SOURCE_NAME, source_url: plan.parsed.sourceUrl,
    source_year: plan.sourceYear, district: occurrence.district, school_name: school.名称, school_type: occurrence.stage,
    tier: integerValue(school.梯队), area: stringValue(school.片区), street: stringValue(school.街道),
    feeder_middle_school: stringValue(school.对口初中), middle_school_tier: integerValue(school.初中梯队),
    evaluation: stringValue(school.评价), admission_mode: stringValue(school.入学方式), class_count: integerValue(school.招生班级),
    tags: Array.isArray(school.标签) ? school.标签 : [], lng: numberValue(school.lng), lat: numberValue(school.lat),
  };
}

function relationIdentity(row: Record<string, unknown>) {
  // 新表无 school_type/school_name 列（school_name_raw + notes.school_type），构造对象仍传原字段名——双源兼容
  const stage = row.school_type ?? String(row.notes ?? "").match(/school_type=([^;]*)/)?.[1] ?? "primary";
  const schoolName = row.school_name_raw ?? row.school_name;
  return JSON.stringify([normalizeDistrict(String(row.district)), stage, schoolName, row.committee_name]);
}

async function canonicalDigest(client: ImportClient) {
  const { rows } = await client.query("select to_jsonb(s)::text as document from public.schools s order by id");
  const hash = createHash("sha256");
  for (const row of rows) hash.update(String(row.document)).update("\n");
  return hash.digest("hex");
}

async function loadRecords(client: ImportClient, runId: string | null): Promise<RawImportRecord[]> {
  if (!runId) return [];
  const result = await client.query(`select record_type as "recordType",source_key as "sourceKey",district,raw
    from ingest.extracted_records where crawl_run_id=$1 and source_key like $2`, [runId, PREFIX + "%"]);
  return result.rows as RawImportRecord[];
}

export async function importXuequzhushou(
  client: ImportClient, plan: XuequzhushouImportPlan,
  options: { apply?: boolean; snapshotPath?: string; fetchedAt?: string } = {},
): Promise<ImportReport> {
  const apply = options.apply === true;
  const report: ImportReport = {
    mode: apply ? "apply" : "dry-run", runId: null, sourceYear: plan.sourceYear, contentHash: plan.parsed.contentHash,
    records: counts(), schools: counts(), relations: counts(), recordCounts: {},
    canonicalBefore: "", canonicalAfter: "", reconciled: false, conflicts: [],
  };
  for (const record of plan.records) report.recordCounts[record.recordType] = (report.recordCounts[record.recordType] ?? 0) + 1;
  await client.query(apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    if (apply) {
      await client.query("select pg_advisory_xact_lock(hashtext('xuequzhushou-full-import'))");
      // Prevent concurrent editors from making the canonical digest inconclusive.
      await client.query("LOCK TABLE public.schools IN SHARE MODE");
      await client.query("LOCK TABLE catalog.source_schools,catalog.school_communities IN SHARE ROW EXCLUSIVE MODE");
    }
    report.canonicalBefore = await canonicalDigest(client);
    const publicSchools = (await client.query("select id,name,district,type,aliases from public.schools")).rows as PublicSchool[];
    const sourceSchools = (await client.query("select * from catalog.source_schools")).rows;
    const existingSchools = new Map(sourceSchools.map(row => [String(row.source_key), row]));
    const existingRelations = (await client.query("select * from catalog.school_communities where source_name=$1", [SOURCE_NAME])).rows;
    const relationKeys = new Map(existingRelations.map(row => [relationIdentity(row), row]));
    const runResult = await client.query(`select r.id from ingest.crawl_runs r join ingest.sources s on s.id=r.source_id
      where s.source_key='xuequzhushou' and r.content_hash=$1`, [plan.parsed.contentHash]);
    report.runId = runResult.rows[0] ? String(runResult.rows[0].id) : null;
    const priorRaw = await loadRecords(client, report.runId);
    const rawByKey = new Map(priorRaw.map(row => [recordIdentity(row), row]));
    for (const record of plan.records) {
      const prior = rawByKey.get(recordIdentity(record));
      if (!prior) report.records.added++;
      else if (isDeepStrictEqual(record, prior)) report.records.unchanged++;
      else {
        report.records.conflict++;
        report.conflicts.push({ sourceKey: record.sourceKey, reason: "Immutable raw record differs" });
      }
    }
    const expectedKeys = new Set(plan.records.map(recordIdentity));
    if (priorRaw.some(row => !expectedKeys.has(recordIdentity(row)))) throw new Error("Raw reconciliation found unexpected records");
    if (report.records.conflict) throw new Error(`Raw reconciliation found ${report.records.conflict} immutable conflicts`);

    if (apply) {
      await client.query(`insert into ingest.sources(source_key,name,base_url,source_kind)
        values('xuequzhushou',$1,$2,'third_party') on conflict(source_key) do nothing`, [SOURCE_NAME, plan.parsed.sourceUrl]);
      if (!report.runId) {
        const run = await client.query(`insert into ingest.crawl_runs(source_id,source_url,fetched_at,http_status,
          content_hash,parser_version,page_title,stats,raw_path)
          select id,$1,coalesce($2::timestamptz,now()),0,$3,2,$4,$5::jsonb,$6 from ingest.sources
          where source_key='xuequzhushou' returning id`, [plan.parsed.sourceUrl, options.fetchedAt ?? null,
          plan.parsed.contentHash, plan.parsed.pageTitle, JSON.stringify({ ...plan.parsed.stats,
            recordCounts: report.recordCounts, fetchedAtEvidence: options.fetchedAt ? "provided" : "import_time_only", httpStatusEvidence: "unknown_local_snapshot" }),
          options.snapshotPath ?? null]);
        report.runId = String(run.rows[0].id);
      }
      for (let offset = 0; offset < plan.records.length; offset += 200) {
        await client.query(`insert into ingest.extracted_records(crawl_run_id,record_type,source_key,district,raw)
          select $1,r."recordType",r."sourceKey",r.district,r.raw from jsonb_to_recordset($2::jsonb)
          as r("recordType" text,"sourceKey" text,district text,raw jsonb)
          on conflict(crawl_run_id,record_type,source_key) do nothing`,
        [report.runId, JSON.stringify(plan.records.slice(offset, offset + 200))]);
      }
    }

    const schoolIds = new Map<string, number | null>();
    const reconcileSchools: { key: string; raw: unknown; publicSchoolId: unknown }[] = [];
    for (const occurrence of plan.schools) {
      const prior = existingSchools.get(occurrence.catalogKey);
      const matched = matchPublicSchool(publicSchools, occurrence.district, occurrence.stage, occurrence.school.名称);
      const publicSchoolId = prior ? prior.public_school_id as number | null : matched.id;
      schoolIds.set(occurrence.recordKey, publicSchoolId);
      if (publicSchoolId == null) report.schools.unmatched++;
      const fields = schoolFields(plan, occurrence);
      const attrs = {
        rawSchool: occurrence.school, sourceKind: "third_party", sourceRecordKey: occurrence.recordKey,
        sourceContentHash: plan.parsed.contentHash,
        districtAdmissionSystem: plan.parsed.districts[occurrence.district].入学制度,
        districtNote: plan.parsed.districts[occurrence.district].说明,
      };
      if (prior) {
        const priorAttrs = object(prior.attrs);
        const mismatched = Object.entries(fields).filter(([key, value]) => !isDeepStrictEqual(prior[key], value)).map(([key]) => key);
        if (prior.source_name !== SOURCE_NAME || (priorAttrs.rawSchool !== undefined && !isDeepStrictEqual(priorAttrs.rawSchool, occurrence.school)) || mismatched.length) {
          report.schools.conflict++;
          report.conflicts.push({ sourceKey: occurrence.catalogKey, reason: `Existing source facts preserved${mismatched.length ? ": " + mismatched.join(",") : ""}` });
        }
        if (prior.source_name === SOURCE_NAME && priorAttrs.rawSchool === undefined) {
          report.schools.changed++;
          if (apply) await client.query(`update catalog.source_schools set attrs=$2::jsonb,updated_at=now() where source_key=$1`,
            [occurrence.catalogKey, JSON.stringify({ ...attrs, ...priorAttrs, rawSchool: occurrence.school })]);
          reconcileSchools.push({ key: occurrence.catalogKey, raw: occurrence.school, publicSchoolId: prior.public_school_id });
        } else {
          report.schools.unchanged++;
          if (prior.source_name === SOURCE_NAME && isDeepStrictEqual(priorAttrs.rawSchool, occurrence.school)) {
            reconcileSchools.push({ key: occurrence.catalogKey, raw: occurrence.school, publicSchoolId: prior.public_school_id });
          }
        }
      } else {
        if (matched.status === "conflict" || (occurrence.duplicateName && existingSchools.has(occurrence.legacyKey))) {
          report.schools.conflict++;
          report.conflicts.push({ sourceKey: occurrence.catalogKey, reason: "Ambiguous name or legacy duplicate; existing mappings preserved" });
        }
        report.schools.added++;
        if (apply) {
          await client.query(`insert into catalog.source_schools(source_key,source_name,source_url,source_year,district,
            school_name,school_type,tier,area,street,feeder_middle_school,middle_school_tier,evaluation,admission_mode,
            class_count,tags,lng,lat,public_school_id,attrs)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20::jsonb)`,
          [fields.source_key, fields.source_name, fields.source_url, fields.source_year, fields.district,
            fields.school_name, fields.school_type, fields.tier, fields.area, fields.street, fields.feeder_middle_school,
            fields.middle_school_tier, fields.evaluation, fields.admission_mode, fields.class_count, JSON.stringify(fields.tags),
            fields.lng, fields.lat, publicSchoolId, JSON.stringify(attrs)]);
        }
        reconcileSchools.push({ key: occurrence.catalogKey, raw: occurrence.school, publicSchoolId });
      }
    }

    const rawIds = new Map<string, string>();
    if (apply) {
      const result = await client.query(`select id,source_key from ingest.extracted_records
        where crawl_run_id=$1 and record_type='committee_link' and source_key like $2`, [report.runId, PREFIX + "%"]);
      result.rows.forEach(row => rawIds.set(String(row.source_key), String(row.id)));
    }
    const newRelations: CommitteeOccurrence[] = [];
    for (const relation of plan.relations) {
      const occurrence = relation.school;
      const publicSchoolId = schoolIds.get(occurrence.recordKey) ?? null;
      const identity = relationIdentity({ district: occurrence.district, school_type: occurrence.stage,
        school_name: occurrence.school.名称, committee_name: relation.committee });
      const prior = relationKeys.get(identity);
      if (prior) {
        report.relations.unchanged++;
        if (prior.school_id == null) report.relations.unmatched++;
        if (prior.school_id != null && publicSchoolId != null && prior.school_id !== publicSchoolId) {
          report.relations.conflict++;
          report.conflicts.push({ sourceKey: relation.recordKey, reason: "Existing relation mapping preserved" });
        }
        continue;
      }
      report.relations.added++;
      if (publicSchoolId == null) report.relations.unmatched++;
      newRelations.push(relation);
      relationKeys.set(identity, { school_id: publicSchoolId });
      if (apply) {
        const recordId = rawIds.get(relation.recordKey);
        if (!recordId) throw new Error(`Raw reconciliation missing relation: ${relation.recordKey}`);
        await client.query(`insert into catalog.school_communities(source_record_id,source_name,source_url,year,
          district,school_name_raw,committee_name,school_id,review_status,verified,notes)
          values($1,$2,$3,$4,$5,$6,$7,$8,'pending',false,$9)`,
        [recordId, SOURCE_NAME, plan.parsed.sourceUrl, plan.sourceYear, occurrence.district,
          occurrence.school.名称, relation.committee, publicSchoolId,
          [
            `match=${publicSchoolId == null ? "raw" : "school_matched"}`,
            `area=${stringValue(occurrence.school.片区) ?? ""}`,
            `street=${stringValue(occurrence.school.街道) ?? ""}`,
            `school_type=${occurrence.stage}`,
          ].join("; ")]);
      }
    }

    if (apply) {
      reconcileRawRecords(plan.records, await loadRecords(client, report.runId));
      const afterSchools = (await client.query("select * from catalog.source_schools")).rows;
      const afterByKey = new Map(afterSchools.map(row => [String(row.source_key), row]));
      if (afterSchools.length !== sourceSchools.length + report.schools.added) throw new Error("Source school reconciliation count mismatch");
      for (const expected of reconcileSchools) {
        const actual = afterByKey.get(expected.key);
        if (!actual || !isDeepStrictEqual(object(actual.attrs).rawSchool, expected.raw) || actual.public_school_id !== expected.publicSchoolId) {
          throw new Error(`Source school reconciliation mismatch: ${expected.key}`);
        }
      }
      for (const prior of sourceSchools) {
        const actual = afterByKey.get(String(prior.source_key));
        if (!actual) throw new Error("Existing source school missing");
        for (const [key, value] of Object.entries(prior)) {
          if (key !== "attrs" && key !== "updated_at" && !isDeepStrictEqual(actual[key], value)) throw new Error(`Existing source school changed: ${prior.source_key}:${key}`);
        }
        for (const [key, value] of Object.entries(object(prior.attrs))) {
          if (!isDeepStrictEqual(object(actual.attrs)[key], value)) throw new Error(`Existing source school attrs changed: ${prior.source_key}:${key}`);
        }
      }
      const afterRelations = (await client.query("select * from catalog.school_communities where source_name=$1", [SOURCE_NAME])).rows;
      if (afterRelations.length !== existingRelations.length + report.relations.added) throw new Error("Relation reconciliation count mismatch");
      const afterRelationsById = new Map(afterRelations.map(row => [String(row.id), row]));
      for (const prior of existingRelations) {
        if (!isDeepStrictEqual(prior, afterRelationsById.get(String(prior.id)))) throw new Error(`Existing relation changed: ${prior.id}`);
      }
      const afterRelationsByRecord = new Map(afterRelations.map(row => [String(row.source_record_id), row]));
      for (const relation of newRelations) {
        const actual = afterRelationsByRecord.get(rawIds.get(relation.recordKey)!);
        if (!actual || actual.verified !== false || actual.review_status !== "pending"
          || actual.community_id != null || actual.school_id !== schoolIds.get(relation.school.recordKey)
          || actual.committee_name !== relation.committee || actual.year !== plan.sourceYear) {
          throw new Error(`Relation reconciliation mismatch: ${relation.recordKey}`);
        }
      }
      report.reconciled = true;
    } else if (report.records.added === 0) {
      reconcileRawRecords(plan.records, priorRaw);
      report.reconciled = true;
    }
    report.canonicalAfter = await canonicalDigest(client);
    if (report.canonicalAfter !== report.canonicalBefore) throw new Error("Canonical school digest changed; import rolled back");
    await client.query(apply ? "COMMIT" : "ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
