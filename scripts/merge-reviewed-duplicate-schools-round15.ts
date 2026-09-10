/**
 * Merge a narrowly reviewed set of duplicate school rows.
 *
 * Safety properties:
 * - dry-run by default; --apply is required to write
 * - exact source/target identity guards
 * - target non-empty values always win
 * - all live public-school foreign keys and catalog/audit projections move
 * - unique-key collisions are deduplicated deterministically
 * - source rows and field conflicts remain auditable in target attrs/reports
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

type SchoolType = "primary" | "middle" | "nine_year";
type JsonRecord = Record<string, unknown>;

export type ReviewedMerge = {
  sourceId: number;
  targetId: number;
  sourceName: string;
  sourceDistrict: string;
  targetName: string;
  targetDistrict: string;
  type: SchoolType;
  evidence: string;
};

export type SchoolRow = JsonRecord & {
  id: number;
  name: string;
  aliases?: string[] | null;
  district: string;
  type: SchoolType;
  attrs?: JsonRecord | null;
};

type MergeConflict = {
  field: string;
  target: unknown;
  source: unknown;
  sourceId: number;
};

export const REVIEWED_MERGES: ReviewedMerge[] = [
  {
    sourceId: 5022, targetId: 3770,
    sourceName: "上海市上南中学北校", sourceDistrict: "浦东",
    targetName: "上海市上南中学北校", targetDistrict: "浦东", type: "middle",
    evidence: "同区同学段同全称、同官方地址南码头路1347号；目标行已有2026官方招生关系和政策引用，来源行无关系数据，仅保留其别名和来源审计。",
  },
  {
    sourceId: 4627, targetId: 3674,
    sourceName: "上海市南汇第三中学", sourceDistrict: "浦东",
    targetName: "上海市南汇第三中学", targetDistrict: "浦东", type: "middle",
    evidence: "同区同学段同全称、同官方地址惠南镇梅花路185号；目标行已有2026官方招生关系和政策引用，来源行无关系数据。",
  },
  {
    sourceId: 4619, targetId: 3696,
    sourceName: "上海市建平中学西校（华城校区）", sourceDistrict: "浦东",
    targetName: "上海市建平中学西校（华城校区）", targetDistrict: "浦东", type: "middle",
    evidence: "同区同学段同全称、同官方地址源深路383号；目标行已有2026官方招生关系和政策引用，来源行无关系数据。",
  },
  {
    sourceId: 4775, targetId: 3793,
    sourceName: "上海市建平实验地杰中学（御桥路校区）", sourceDistrict: "浦东",
    targetName: "上海市建平实验地杰中学（御桥路校区）", targetDistrict: "浦东", type: "middle",
    evidence: "同区同学段同全称、同官方地址御桥路1977号；目标行已有2026官方招生关系和政策引用，来源行无关系数据。",
  },
  {
    sourceId: 4629, targetId: 3705,
    sourceName: "上海市陆行中学南校", sourceDistrict: "浦东",
    targetName: "上海市陆行中学南校", targetDistrict: "浦东", type: "middle",
    evidence: "同区同学段同全称、同官方地址金台路96号；目标行已有2026官方招生关系和政策引用，来源行无关系数据。",
  },
  {
    sourceId: 4630, targetId: 3738,
    sourceName: "华东师范大学附属东昌中学南校（潍坊校区）", sourceDistrict: "浦东",
    targetName: "华东师范大学附属东昌中学南校（潍坊校区）", targetDistrict: "浦东", type: "middle",
    evidence: "同区同学段同全称、同官方地址南泉北路1020号；目标行已有官方政策引用，来源行无招生关系数据。",
  },
  {
    sourceId: 4667, targetId: 3988,
    sourceName: "同济实验学校",
    sourceDistrict: "嘉定",
    targetName: "同济大学附属嘉定实验中学",
    targetDistrict: "嘉定",
    type: "middle",
    evidence: "同区同学段的简称/全称重复行；官方嘉定区公办学校基本情况表明确列出目标全称、米夏路99号和公办性质，目标行已有招生边界和官方来源；简称行仅有第三方梯队及本轮补录的别名来源。保留目标行，迁移来源和别名并记录地址/梯队冲突。",
  },
  {
    sourceId: 5657, targetId: 3986,
    sourceName: "上外嘉定外国语学校（初中部）",
    sourceDistrict: "嘉定",
    targetName: "上海外国语大学嘉定外国语学校",
    targetDistrict: "嘉定",
    type: "middle",
    evidence: "同区同学段、同一官方学校及同一地址的部名称重复行；目标已有上海市政府/嘉定区教育局官方地址和坐标来源，源行仅有第三方梯队和来源记录。",
  },
  {
    sourceId: 5792, targetId: 4420,
    sourceName: "上师大附属经纬实验学校",
    sourceDistrict: "宝山",
    targetName: "上海师范大学附属宝山经纬实验中学",
    targetDistrict: "宝山",
    type: "middle",
    evidence: "同区同学段的简称/全称重复行；目标已有宝山区教育局官方校区范围、地址、坐标和招生范围，源行仅有第三方梯队记录。",
  },
  {
    sourceId: 5775, targetId: 3869,
    sourceName: "上师大附属康城实验学校",
    sourceDistrict: "闵行",
    targetName: "上海师范大学康城实验学校",
    targetDistrict: "闵行",
    type: "primary",
    evidence: "同区同学段的简称/全称重复行；目标已有上海市/闵行区官方学校地址、坐标和对口范围，源行仅有第三方梯队记录。",
  },
  {
    sourceId: 5549, targetId: 4762,
    sourceName: "浦华二",
    sourceDistrict: "浦东",
    targetName: "上海民办华曜浦东实验学校",
    targetDistrict: "浦东",
    type: "middle",
    evidence: "浦东初中梯队资料中的简称行；目标是同区同学段且已有上海市/浦东新区官方全称、地址、性质和坐标，源行没有独立地址或关系数据。",
  },
]; 

const MERGE_FIELDS = [
  "tier",
  "school_nature",
  "address",
  "lat",
  "lng",
  "enrollment_note",
  "recent_score_line",
  "pit_risk_level",
  "website",
  "student_count",
  "school_scale",
  "faculty",
  "area",
  "street",
  "feeder_middle_school",
  "middle_school_tier",
  "evaluation",
  "admission_mode",
  "class_count",
] as const;

const SIMPLE_PUBLIC_REFERENCES = [
  ["public", "district_boundaries", "school_id"],
  ["public", "policies", "school_id"],
  ["public", "school_info", "school_id"],
  ["public", "school_community_candidates", "school_id"],
] as const;

const PROJECTED_PUBLIC_REFERENCES = [
  ["audit", "entity_match_candidates", "public_school_id"],
  ["audit", "school_community_relation_candidates", "public_school_id"],
  ["catalog", "policy_documents", "public_school_id"],
  ["catalog", "school_aliases", "public_school_id"],
  ["catalog", "school_community_assignments", "public_school_id"],
  ["catalog", "school_district_relations", "school_id"],
  ["catalog", "school_feeder_relations", "from_public_school_id"],
  ["catalog", "school_feeder_relations", "to_public_school_id"],
  ["catalog", "school_ratings", "public_school_id"],
  ["catalog", "source_schools", "public_school_id"],
] as const;

const EXPECTED_FOREIGN_KEYS = new Set([
  "public.district_boundaries.school_id",
  "public.policies.school_id",
  "public.school_communities.school_id",
  "public.school_community_candidates.school_id",
  "public.school_info.school_id",
  "public.web_data_source.school_id",
  "audit.entity_match_candidates.public_school_id",
  "audit.school_community_relation_candidates.public_school_id",
  "catalog.policy_documents.public_school_id",
  "catalog.school_aliases.public_school_id",
  "catalog.school_community_assignments.public_school_id",
  "catalog.school_district_relations.school_id",
  "catalog.school_feeder_relations.from_public_school_id",
  "catalog.school_feeder_relations.to_public_school_id",
  "catalog.school_ratings.public_school_id",
  "catalog.source_schools.public_school_id",
]);

function uniqueStrings(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
}

function meaningful(field: string, value: unknown) {
  if (value == null) return false;
  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return false;
    if (field === "pit_risk_level" && normalized === "unknown") return false;
  }
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function chooseValue(
  field: string,
  targetValue: unknown,
  sourceValue: unknown,
  sourceId: number,
  conflicts: MergeConflict[],
) {
  if (!meaningful(field, targetValue) && meaningful(field, sourceValue)) return sourceValue;
  if (meaningful(field, targetValue) && meaningful(field, sourceValue) && !sameValue(targetValue, sourceValue)) {
    conflicts.push({ field, target: targetValue, source: sourceValue, sourceId });
  }
  return targetValue;
}

export function mergeSchoolRows(
  target: SchoolRow,
  source: SchoolRow,
  action: ReviewedMerge,
  mergedAt: string,
) {
  const conflicts: MergeConflict[] = [];
  const values: JsonRecord = {};
  for (const field of MERGE_FIELDS) {
    values[field] = chooseValue(field, target[field], source[field], source.id, conflicts);
  }
  values.tags = uniqueStrings([target.tags ?? [], source.tags ?? []]);

  const aliases = uniqueStrings([
    target.aliases ?? [],
    source.name,
    source.aliases ?? [],
  ]).filter((alias) => alias !== target.name);
  const targetAttrs = target.attrs ?? {};
  const attrs = {
    ...targetAttrs,
    aliases,
    school_data_merged_sources_round15: [
      ...(Array.isArray(targetAttrs.school_data_merged_sources_round15)
        ? targetAttrs.school_data_merged_sources_round15
        : []),
      {
        source_id: source.id,
        source_name: source.name,
        source_district: source.district,
        source_type: source.type,
        source_aliases: source.aliases ?? [],
        source_fields: Object.fromEntries(
          [...MERGE_FIELDS, "tags"].map((field) => [field, source[field]]),
        ),
        source_row_snapshot: source,
        source_attrs: source.attrs ?? null,
        evidence: action.evidence,
        merged_at: mergedAt,
      },
    ],
    school_data_merge_conflicts: [
      ...(Array.isArray(targetAttrs.school_data_merge_conflicts)
        ? targetAttrs.school_data_merge_conflicts
        : []),
      ...conflicts.map((conflict) => ({ ...conflict, detected_at: mergedAt, round: 15 })),
    ],
  };

  return { values, aliases, attrs, conflicts };
}

function assertIdentity(row: SchoolRow, action: ReviewedMerge, role: "source" | "target") {
  const expected = role === "source"
    ? { id: action.sourceId, name: action.sourceName, district: action.sourceDistrict }
    : { id: action.targetId, name: action.targetName, district: action.targetDistrict };
  if (
    row.id !== expected.id
    || row.name !== expected.name
    || row.district !== expected.district
    || row.type !== action.type
  ) {
    throw new Error(
      `${role} identity changed for ${expected.id}: expected ${expected.district}/${expected.name}/${action.type}, `
      + `actual ${row.district}/${row.name}/${row.type}`,
    );
  }
}

async function assertLiveForeignKeys(client: pg.Client) {
  const result = await client.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
  }>(
    `SELECT child_ns.nspname AS table_schema,
            child.relname AS table_name,
            child_col.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class child ON child.oid = con.conrelid
       JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
       JOIN pg_class parent ON parent.oid = con.confrelid
       JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY child_key(attnum, ord) ON true
       JOIN unnest(con.confkey) WITH ORDINALITY parent_key(attnum, ord)
         ON parent_key.ord = child_key.ord
       JOIN pg_attribute child_col
         ON child_col.attrelid = child.oid AND child_col.attnum = child_key.attnum
       JOIN pg_attribute parent_col
         ON parent_col.attrelid = parent.oid AND parent_col.attnum = parent_key.attnum
      WHERE con.contype = 'f'
        AND parent_ns.nspname = 'public'
        AND parent.relname = 'schools'
        AND parent_col.attname = 'id'`,
  );
  const actual = new Set(result.rows.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`));
  const unexpected = [...actual].filter((item) => !EXPECTED_FOREIGN_KEYS.has(item));
  const missing = [...EXPECTED_FOREIGN_KEYS].filter((item) => !actual.has(item));
  if (unexpected.length || missing.length) {
    throw new Error(`school FK set changed; unexpected=${unexpected.join(",")}; missing=${missing.join(",")}`);
  }
}

async function loadRows(client: pg.Client, ids: number[], lock = false) {
  const result = await client.query<SchoolRow>(
    `SELECT * FROM public.schools
     WHERE id = ANY($1::int[])
     ORDER BY id
     ${lock ? "FOR UPDATE" : ""}`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function referenceCounts(client: pg.Client, ids: number[]) {
  const counts: Record<string, Record<string, number>> = {};
  const refs = [
    ...SIMPLE_PUBLIC_REFERENCES,
    ["public", "school_communities", "school_id"] as const,
    ["public", "web_data_source", "school_id"] as const,
    ...PROJECTED_PUBLIC_REFERENCES,
  ];
  for (const [schema, table, column] of refs) {
    const key = `${schema}.${table}.${column}`;
    const result = await client.query<{ school_id: number; count: number }>(
      `SELECT ${column}::int AS school_id, count(*)::int AS count
       FROM ${schema}.${table}
       WHERE ${column} = ANY($1::int[])
       GROUP BY ${column}`,
      [ids],
    );
    counts[key] = Object.fromEntries(result.rows.map((row) => [String(row.school_id), Number(row.count)]));
  }
  return counts;
}

function simulatePlan(rowMap: Map<number, SchoolRow>, mergedAt: string) {
  const actions: Array<Record<string, unknown>> = [];
  const skippedMissingSources: ReviewedMerge[] = [];
  for (const action of [...REVIEWED_MERGES].sort((left, right) => left.sourceId - right.sourceId)) {
    const source = rowMap.get(action.sourceId);
    const target = rowMap.get(action.targetId);
    if (!target) throw new Error(`missing target school ${action.targetId}`);
    assertIdentity(target, action, "target");
    if (!source) {
      skippedMissingSources.push(action);
      continue;
    }
    assertIdentity(source, action, "source");
    const merged = mergeSchoolRows(target, source, action, mergedAt);
    const nextTarget = {
      ...target,
      ...merged.values,
      aliases: merged.aliases,
      attrs: merged.attrs,
    } as SchoolRow;
    rowMap.set(target.id, nextTarget);
    actions.push({
      ...action,
      sourceBefore: source,
      targetBefore: target,
      targetAfter: nextTarget,
      conflicts: merged.conflicts,
    });
  }
  return { actions, skippedMissingSources };
}

async function updateTarget(client: pg.Client, targetId: number, merged: ReturnType<typeof mergeSchoolRows>) {
  const value = merged.values;
  await client.query(
    `UPDATE public.schools SET
       tier=$1,
       school_nature=$2::school_nature,
       address=$3,
       lat=$4,
       lng=$5,
       enrollment_note=$6,
       recent_score_line=$7,
       pit_risk_level=$8::pit_risk_level,
       website=$9,
       student_count=$10,
       school_scale=$11,
       faculty=$12,
       area=$13,
       street=$14,
       feeder_middle_school=$15,
       middle_school_tier=$16,
       evaluation=$17,
       admission_mode=$18,
       class_count=$19,
       tags=$20::jsonb,
       aliases=$21::text[],
       attrs=$22::jsonb,
       updated_at=now()
     WHERE id=$23`,
    [
      value.tier,
      value.school_nature,
      value.address,
      value.lat,
      value.lng,
      value.enrollment_note,
      value.recent_score_line,
      value.pit_risk_level,
      value.website,
      value.student_count,
      value.school_scale,
      value.faculty,
      value.area,
      value.street,
      value.feeder_middle_school,
      value.middle_school_tier,
      value.evaluation,
      value.admission_mode,
      value.class_count,
      JSON.stringify(value.tags ?? []),
      merged.aliases,
      JSON.stringify(merged.attrs),
      targetId,
    ],
  );
}

async function moveSchoolCommunities(client: pg.Client, sourceId: number, targetId: number) {
  const conflicts = await client.query(
    `DELETE FROM public.school_communities source
     WHERE source.school_id=$1
       AND EXISTS (
         SELECT 1 FROM public.school_communities target
         WHERE target.school_id=$2
           AND target.community_id=source.community_id
           AND target.year=source.year
       )
     RETURNING source.id`,
    [sourceId, targetId],
  );
  const moved = await client.query(
    "UPDATE public.school_communities SET school_id=$1 WHERE school_id=$2 RETURNING id",
    [targetId, sourceId],
  );
  return { moved: moved.rowCount ?? 0, deletedConflicts: conflicts.rowCount ?? 0 };
}

async function moveWebDataSources(client: pg.Client, sourceId: number, targetId: number) {
  const sourceCountResult = await client.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM public.web_data_source WHERE school_id=$1",
    [sourceId],
  );
  const inserted = await client.query(
    `INSERT INTO public.web_data_source
       (school_id,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at)
     SELECT $2,source_type,source_name,source_url,source_title,source_date,evidence,confidence,raw,fetched_at,created_at,updated_at
     FROM public.web_data_source source
     WHERE source.school_id=$1
       AND NOT EXISTS (
         SELECT 1 FROM public.web_data_source target
         WHERE target.school_id=$2
           AND target.source_url IS NOT DISTINCT FROM source.source_url
           AND target.source_type=source.source_type
       )
     ON CONFLICT (school_id, source_url, source_type) DO NOTHING
     RETURNING id`,
    [sourceId, targetId],
  );
  const removed = await client.query(
    "DELETE FROM public.web_data_source WHERE school_id=$1 RETURNING id",
    [sourceId],
  );
  const sourceCount = Number(sourceCountResult.rows[0]?.count ?? 0);
  return {
    moved: inserted.rowCount ?? 0,
    deletedConflicts: sourceCount - (inserted.rowCount ?? 0),
    removedSourceRows: removed.rowCount ?? 0,
  };
}

async function moveSimpleReference(
  client: pg.Client,
  schema: string,
  table: string,
  column: string,
  sourceId: number,
  targetId: number,
) {
  const result = await client.query(
    `UPDATE ${schema}.${table} SET ${column}=$1 WHERE ${column}=$2 RETURNING id`,
    [targetId, sourceId],
  );
  return result.rowCount ?? 0;
}

async function moveAllReferences(client: pg.Client, sourceId: number, targetId: number) {
  const result: Record<string, unknown> = {
    "public.school_communities.school_id": await moveSchoolCommunities(client, sourceId, targetId),
    "public.web_data_source.school_id": await moveWebDataSources(client, sourceId, targetId),
  };
  for (const [schema, table, column] of [...SIMPLE_PUBLIC_REFERENCES, ...PROJECTED_PUBLIC_REFERENCES]) {
    result[`${schema}.${table}.${column}`] = await moveSimpleReference(
      client,
      schema,
      table,
      column,
      sourceId,
      targetId,
    );
  }
  return result;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const apply = process.argv.includes("--apply");
  const mergedAt = new Date().toISOString();
  const stamp = mergedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const reportDir = path.join(process.cwd(), ".tmp", "merge-reviewed-duplicate-schools-round15", stamp);
  mkdirSync(reportDir, { recursive: true });

  const ids = Array.from(new Set(REVIEWED_MERGES.flatMap((action) => [action.sourceId, action.targetId]))).sort(
    (left, right) => left - right,
  );
  const sourceIds = REVIEWED_MERGES.map((action) => action.sourceId);
  const targetIds = Array.from(new Set(REVIEWED_MERGES.map((action) => action.targetId)));
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await assertLiveForeignKeys(client);
    const beforeRows = await loadRows(client, ids);
    const beforeReferences = await referenceCounts(client, ids);
    const plan = simulatePlan(new Map(beforeRows), mergedAt);
    const dryRunReport = {
      generatedAt: mergedAt,
      mode: "dry-run",
      reviewedMergeCount: REVIEWED_MERGES.length,
      ...plan,
      beforeReferences,
    };
    writeFileSync(path.join(reportDir, "dry-run.json"), JSON.stringify(dryRunReport, null, 2));
    if (!apply) {
      console.log(JSON.stringify({
        mode: "dry-run",
        mergeCount: plan.actions.length,
        skippedMissingSources: plan.skippedMissingSources.length,
        report: path.join(reportDir, "dry-run.json"),
      }, null, 2));
      return;
    }

    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const lockedRows = await loadRows(client, ids, true);
    const applied: Array<Record<string, unknown>> = [];
    const skippedMissingSources: ReviewedMerge[] = [];

    for (const action of [...REVIEWED_MERGES].sort((left, right) => left.sourceId - right.sourceId)) {
      const source = lockedRows.get(action.sourceId);
      const target = lockedRows.get(action.targetId);
      if (!target) throw new Error(`missing target school ${action.targetId}`);
      assertIdentity(target, action, "target");
      if (!source) {
        skippedMissingSources.push(action);
        continue;
      }
      assertIdentity(source, action, "source");

      const merged = mergeSchoolRows(target, source, action, mergedAt);
      await updateTarget(client, target.id, merged);
      const referenceMoves = await moveAllReferences(client, source.id, target.id);
      const deleted = await client.query("DELETE FROM public.schools WHERE id=$1 RETURNING id", [source.id]);
      if ((deleted.rowCount ?? 0) !== 1) throw new Error(`expected to delete source school ${source.id}`);

      const nextTarget = {
        ...target,
        ...merged.values,
        aliases: merged.aliases,
        attrs: merged.attrs,
      } as SchoolRow;
      lockedRows.set(target.id, nextTarget);
      lockedRows.delete(source.id);
      applied.push({ ...action, conflicts: merged.conflicts, referenceMoves });
    }

    const remainingSources = await client.query<{ id: number }>(
      "SELECT id FROM public.schools WHERE id=ANY($1::int[]) ORDER BY id",
      [sourceIds],
    );
    if (remainingSources.rows.length) {
      throw new Error(`source schools remain after merge: ${remainingSources.rows.map((row) => row.id).join(",")}`);
    }
    const remainingSourceReferences = await referenceCounts(client, sourceIds);
    const nonzeroReferences = Object.entries(remainingSourceReferences).flatMap(([key, counts]) =>
      Object.entries(counts).map(([id, count]) => ({ key, id, count })),
    );
    if (nonzeroReferences.length) {
      throw new Error(`source references remain after merge: ${JSON.stringify(nonzeroReferences)}`);
    }

    await client.query("COMMIT");
    const targetRows = await loadRows(client, targetIds);
    const postMerge = {
      remainingSourceIds: remainingSources.rows.map((row) => row.id),
      sourceReferences: remainingSourceReferences,
      targets: Array.from(targetRows.values()),
      targetReferences: await referenceCounts(client, targetIds),
    };
    const appliedReport = {
      generatedAt: new Date().toISOString(),
      mode: "apply",
      reviewedMergeCount: REVIEWED_MERGES.length,
      applied,
      skippedMissingSources,
      beforeRows: Array.from(beforeRows.values()),
      beforeReferences,
      postMerge,
    };
    writeFileSync(path.join(reportDir, "applied.json"), JSON.stringify(appliedReport, null, 2));
    console.log(JSON.stringify({
      mode: "apply",
      applied: applied.length,
      skippedMissingSources: skippedMissingSources.length,
      postMerge,
      report: path.join(reportDir, "applied.json"),
    }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("merge-reviewed-duplicate-schools-round15.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
