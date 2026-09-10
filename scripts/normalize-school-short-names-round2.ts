/**
 * Second pass for obvious abbreviated school names left after the first cleanup.
 *
 * This script is intentionally narrow:
 * - only handles rows with high-confidence full-name targets
 * - moves short names into aliases / attrs.aliases
 * - merges source rows into existing target rows and deletes the sources
 * - preserves source row data in attrs.school_data_merged_sources
 * - creates backup tables before applying
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
const detectedAt = now.toISOString();
const reportDir = path.join(process.cwd(), ".tmp", "normalize-school-short-names-round2", stamp);

type SchoolType = "primary" | "middle" | "nine_year";
type SchoolNature = "公立" | "私立" | null;
type PitRiskLevel = "low" | "medium" | "high" | "unknown" | null;

type SchoolRow = {
  id: number;
  name: string;
  aliases: string[] | null;
  district: string;
  tier: string | null;
  type: SchoolType;
  school_nature: SchoolNature;
  address: string | null;
  lat: number | null;
  lng: number | null;
  enrollment_note: string | null;
  recent_score_line: string | null;
  pit_risk_level: PitRiskLevel;
  attrs: Record<string, unknown> | null;
  website: string | null;
  student_count: number | null;
  school_scale: string | null;
  faculty: string | null;
  school_communities: number;
  policies: number;
  district_boundaries: number;
  school_info: number;
};

type MergeAction = {
  sourceId: number;
  targetId: number;
  targetName?: string;
  fieldOverrides?: Partial<Pick<SchoolRow, (typeof SCHOOL_FIELDS)[number]>>;
  source: string;
  reason: string;
};

const SCHOOL_FIELDS = [
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
] as const;

const PLACEHOLDER_VALUES = new Set(["", "未入榜/待补充", "unknown"]);

const mergeActions: MergeAction[] = [
  {
    sourceId: 4662,
    targetId: 4008,
    source: "上海市政府/嘉定区义务教育阶段公办学校基本情况官方匹配名",
    reason: "曹二附属江桥是上海市曹杨二中附属江桥实验中学简称",
  },
  {
    sourceId: 5658,
    targetId: 4008,
    source: "上海市政府/嘉定区义务教育阶段公办学校基本情况官方匹配名",
    reason: "曹二附属江桥实验是上海市曹杨二中附属江桥实验中学简称",
  },
  {
    sourceId: 5538,
    targetId: 4298,
    targetName: "上海市崇明中学附属东门中学（江山校区/城东校区）",
    source: "上海市崇明区人民政府2024年初中学校基本情况",
    reason: "东门中学补足为上海市崇明中学附属东门中学并保留两校区",
  },
  {
    sourceId: 5644,
    targetId: 3467,
    source: "上海市黄浦区人民政府/官方匹配名",
    reason: "卢湾二中心是上海市黄浦区卢湾二中心小学简称",
  },
  {
    sourceId: 4676,
    targetId: 4573,
    source: "上海市教委黄浦区公办初中招生学校一览/既有全称行",
    reason: "格致初级是上海市格致初级中学简称",
  },
  {
    sourceId: 5684,
    targetId: 3502,
    source: "长宁区政务公开/义务教育学校办学规模公开页",
    reason: "愚园路第一小学补足上海市长宁区前缀",
  },
  {
    sourceId: 4646,
    targetId: 3585,
    source: "静安区校园开放日汇总表/官方匹配名",
    reason: "风华初级是上海市风华初级中学教育集团简称",
  },
  {
    sourceId: 4650,
    targetId: 3586,
    targetName: "上海市新中初级中学",
    source: "静安区政府学校页/官方匹配名",
    reason: "新中初级补足为上海市新中初级中学，去除目标行里非校名的教育集团后缀",
  },
  {
    sourceId: 4640,
    targetId: 4406,
    source: "上海市政府/宝山区义务教育阶段学校校区范围与招生计划",
    reason: "吴淞初级为现上海市吴淞中学附属宝山实验学校（原上海市吴淞初级中学）的简称/旧称",
  },
  {
    sourceId: 4590,
    targetId: 4567,
    source: "徐汇区义务教育阶段学校办学规模公开页/学校官网",
    reason: "华育中学是上海市民办华育中学简称",
  },
  {
    sourceId: 4591,
    targetId: 4579,
    targetName: "上海市世外中学",
    fieldOverrides: {
      school_nature: "私立",
      address: "虹漕南路602号；百花街400号",
    },
    source: "徐汇区义务教育阶段学校办学规模公开页/学校官网",
    reason: "世界外国语是上海市世外中学/上海市世界外国语中学简称",
  },
  {
    sourceId: 4695,
    targetId: 4579,
    source: "学校官网/上海市教育考试院信息",
    reason: "世外中学是上海市世外中学简称，目标行已保留原名上海市世界外国语中学为别名",
  },
  {
    sourceId: 4596,
    targetId: 4580,
    source: "徐汇区义务教育阶段学校办学规模公开页",
    reason: "位育初级是上海市位育初级中学简称",
  },
  {
    sourceId: 4593,
    targetId: 4700,
    targetName: "上海市西南位育中学",
    source: "徐汇区义务教育阶段学校办学规模公开页/学校招聘公告",
    reason: "西南位育补足为上海市西南位育中学",
  },
  {
    sourceId: 4595,
    targetId: 4581,
    source: "上海市教委徐汇区公办初中招生学校一览/南洋模范中学官网",
    reason: "南模初级、南模初级中学补足为上海市南洋模范初级中学",
  },
  {
    sourceId: 4698,
    targetId: 4581,
    source: "上海市教委徐汇区公办初中招生学校一览/南洋模范中学官网",
    reason: "南模初级中学补足为上海市南洋模范初级中学",
  },
  {
    sourceId: 5697,
    targetId: 4486,
    source: "普陀区义务教育阶段学校公开页/校园开放日信息表",
    reason: "新普陀小学按梅川路838号补足为上海市普陀区新普陀小学及东校",
  },
  {
    sourceId: 4605,
    targetId: 4533,
    source: "上海华东师范大学附属进华中学官网/普陀区招生简章",
    reason: "进华中学是上海华东师范大学附属进华中学简称",
  },
  {
    sourceId: 5737,
    targetId: 4555,
    source: "杨浦区义务教育阶段公办小学办学规模公开页",
    reason: "五角场小学补足上海市杨浦区前缀，邯郸路为东部地址",
  },
  {
    sourceId: 5640,
    targetId: 3901,
    source: "上海市政府/闵行区公办初中招生划片范围",
    reason: "颛桥中学是上海市闵行区颛桥中学简称",
  },
  {
    sourceId: 4677,
    targetId: 4574,
    source: "上海市教委黄浦区公办初中招生学校一览",
    reason: "大同初级是上海市大同初级中学简称",
  },
  {
    sourceId: 4679,
    targetId: 4583,
    source: "上海市教委黄浦区公办初中招生学校一览",
    reason: "向明初级是上海市向明初级中学简称",
  },
];

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function nonEmpty(value: unknown) {
  if (value == null) return false;
  if (typeof value === "string") return !PLACEHOLDER_VALUES.has(value.trim());
  return true;
}

function refs(row: SchoolRow) {
  return {
    schoolCommunities: row.school_communities,
    policies: row.policies,
    districtBoundaries: row.district_boundaries,
    schoolInfo: row.school_info,
  };
}

function rowSummary(row: SchoolRow) {
  return {
    id: row.id,
    name: row.name,
    district: row.district,
    type: row.type,
    address: row.address,
    aliases: row.aliases ?? [],
    refs: refs(row),
    tier: row.tier,
    schoolNature: row.school_nature,
    dataSource: row.attrs?.data_source,
    officialMatch: (row.attrs?.official_school_info_source as Record<string, unknown> | undefined)?.matched_name,
  };
}

function attrsAliases(attrs: Record<string, unknown> | null) {
  return Array.isArray(attrs?.aliases) ? attrs.aliases.map(String) : [];
}

function mergeAttrs(targetAttrs: Record<string, unknown> | null, source: SchoolRow, action: MergeAction, target: SchoolRow, targetName: string) {
  const next = { ...(targetAttrs ?? {}) };
  next.aliases = unique([...attrsAliases(targetAttrs), source.name, ...(source.aliases ?? []), target.name === targetName ? null : target.name]);
  next.school_data_cleanup = [
    ...(Array.isArray(next.school_data_cleanup) ? next.school_data_cleanup : []),
    {
      kind: "merge_short_name_row_round2",
      merged_source_id: source.id,
      merged_source_name: source.name,
      target_id: target.id,
      previous_target_name: target.name,
      new_target_name: targetName,
      source: action.source,
      reason: action.reason,
      detected_at: detectedAt,
    },
  ];
  next.school_data_merged_sources = [
    ...(Array.isArray(next.school_data_merged_sources) ? next.school_data_merged_sources : []),
    {
      merged_at: detectedAt,
      source_id: source.id,
      source_name: source.name,
      source_district: source.district,
      source_type: source.type,
      source_refs: refs(source),
      source_fields: Object.fromEntries(
        SCHOOL_FIELDS.map((field) => [field, source[field]]).filter(([, value]) => nonEmpty(value)),
      ),
      source_attrs: source.attrs,
    },
  ];
  return next;
}

function buildMergedTarget(target: SchoolRow, source: SchoolRow, action: MergeAction) {
  const targetName = action.targetName ?? target.name;
  const merged: Record<string, unknown> = {};
  const conflicts: Array<Record<string, unknown>> = [];
  const overrides: Array<Record<string, unknown>> = [];

  for (const field of SCHOOL_FIELDS) {
    let value: unknown = target[field];
    const sourceValue = source[field];
    if (!nonEmpty(value) && nonEmpty(sourceValue)) {
      value = sourceValue;
    } else if (
      nonEmpty(value) &&
      nonEmpty(sourceValue) &&
      JSON.stringify(value) !== JSON.stringify(sourceValue)
    ) {
      conflicts.push({ field, target: value, sourceId: source.id, source: sourceValue });
    }
    merged[field] = value;
  }

  for (const [field, overrideValue] of Object.entries(action.fieldOverrides ?? {})) {
    if (!SCHOOL_FIELDS.includes(field as (typeof SCHOOL_FIELDS)[number])) continue;
    const previousValue = merged[field];
    if (JSON.stringify(previousValue) !== JSON.stringify(overrideValue)) {
      overrides.push({ field, previous: previousValue, override: overrideValue });
    }
    merged[field] = overrideValue;
  }

  const aliases = unique([...(target.aliases ?? []), target.name === targetName ? null : target.name, source.name, ...(source.aliases ?? [])])
    .filter((alias) => alias !== targetName);
  const attrs = {
    ...mergeAttrs(target.attrs, source, action, target, targetName),
    aliases,
    school_data_merge_conflicts: [
      ...(Array.isArray(target.attrs?.school_data_merge_conflicts) ? target.attrs.school_data_merge_conflicts : []),
      ...conflicts.map((conflict) => ({ ...conflict, detected_at: detectedAt })),
    ],
    school_data_field_overrides: [
      ...(Array.isArray(target.attrs?.school_data_field_overrides) ? target.attrs.school_data_field_overrides : []),
      ...overrides.map((override) => ({
        ...override,
        sourceId: source.id,
        reason: action.reason,
        detected_at: detectedAt,
      })),
    ],
  };

  return { targetName, merged, aliases, attrs, conflicts, overrides };
}

async function loadRows(client: pg.Client, ids: number[]) {
  const result = await client.query<SchoolRow>(
    `SELECT
       s.id,
       s.name,
       s.aliases,
       s.district,
       s.tier,
       s.type::text,
       s.school_nature::text,
       s.address,
       s.lat,
       s.lng,
       s.enrollment_note,
       s.recent_score_line,
       s.pit_risk_level::text,
       s.attrs,
       s.website,
       s.student_count,
       s.school_scale,
       s.faculty,
       COALESCE(sc.c, 0)::int AS school_communities,
       COALESCE(p.c, 0)::int AS policies,
       COALESCE(db.c, 0)::int AS district_boundaries,
       COALESCE(si.c, 0)::int AS school_info
     FROM schools s
     LEFT JOIN (SELECT school_id, count(*) c FROM school_communities GROUP BY school_id) sc ON sc.school_id = s.id
     LEFT JOIN (SELECT school_id, count(*) c FROM policies GROUP BY school_id) p ON p.school_id = s.id
     LEFT JOIN (SELECT school_id, count(*) c FROM district_boundaries GROUP BY school_id) db ON db.school_id = s.id
     LEFT JOIN (SELECT school_id, count(*) c FROM school_info GROUP BY school_id) si ON si.school_id = s.id
     WHERE s.id = ANY($1::int[])
     ORDER BY s.id`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function assertNoNameConflict(client: pg.Client, target: SchoolRow, targetName: string) {
  if (target.name === targetName) return;
  const conflict = await client.query(
    `SELECT id, name, district, type::text
     FROM schools
     WHERE id <> $1 AND name = $2 AND district = $3 AND type = $4::school_type`,
    [target.id, targetName, target.district, target.type],
  );
  if ((conflict.rowCount ?? 0) > 0) {
    throw new Error(`Target name conflict for ${target.id} -> ${targetName}: ${JSON.stringify(conflict.rows)}`);
  }
}

async function moveSchoolCommunities(client: pg.Client, sourceId: number, targetId: number) {
  const conflicting = await client.query(
    `DELETE FROM school_communities sc
     WHERE sc.school_id = $1
       AND EXISTS (
         SELECT 1
         FROM school_communities kept
         WHERE kept.school_id = $2
           AND kept.community_id = sc.community_id
           AND kept.year = sc.year
       )
     RETURNING id`,
    [sourceId, targetId],
  );
  const moved = await client.query(
    `UPDATE school_communities
     SET school_id = $1
     WHERE school_id = $2
     RETURNING id`,
    [targetId, sourceId],
  );
  return { moved: moved.rowCount ?? 0, deletedConflicts: conflicting.rowCount ?? 0 };
}

async function moveSimpleRef(client: pg.Client, table: string, sourceId: number, targetId: number) {
  const result = await client.query(
    `UPDATE ${table}
     SET school_id = $1
     WHERE school_id = $2
     RETURNING id`,
    [targetId, sourceId],
  );
  return result.rowCount ?? 0;
}

async function main() {
  mkdirSync(reportDir, { recursive: true });

  const ids = unique(mergeActions.flatMap((action) => [String(action.sourceId), String(action.targetId)])).map(Number);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const rowMap = await loadRows(client, ids);
    const skippedMissingSources: MergeAction[] = [];

    const plan = [];
    for (const action of mergeActions) {
      const source = rowMap.get(action.sourceId);
      const target = rowMap.get(action.targetId);
      if (!source) {
        skippedMissingSources.push(action);
        continue;
      }
      if (!target) throw new Error(`Missing target row for ${action.sourceId} -> ${action.targetId}`);
      if (source.type !== target.type) throw new Error(`Refusing cross-type merge ${source.id} -> ${target.id}`);
      if (source.district !== target.district) throw new Error(`Refusing cross-district merge ${source.id} -> ${target.id}`);

      const targetName = action.targetName ?? target.name;
      await assertNoNameConflict(client, target, targetName);
      plan.push({
        ...action,
        targetName,
        sourceRow: rowSummary(source),
        targetRow: rowSummary(target),
        mergedPreview: buildMergedTarget(target, source, action),
      });
    }

    writeFileSync(path.join(reportDir, "plan.json"), JSON.stringify({ apply, actions: plan, skippedMissingSources }, null, 2));
    console.log(
      `Plan: merge=${plan.length}, deleteAfterMerge=${plan.length}, skippedMissingSources=${skippedMissingSources.length}. Report: ${reportDir}`,
    );
    if (!apply) return;

    const backupSchools = `schools_short_names_round2_backup_${stamp}`;
    const backupSchoolCommunities = `school_communities_short_names_round2_backup_${stamp}`;
    const backupPolicies = `policies_short_names_round2_backup_${stamp}`;
    const backupDistrictBoundaries = `district_boundaries_short_names_round2_backup_${stamp}`;
    const backupSchoolInfo = `school_info_short_names_round2_backup_${stamp}`;

    await client.query("BEGIN");
    await client.query(`CREATE TABLE ${backupSchools} AS TABLE schools`);
    await client.query(`CREATE TABLE ${backupSchoolCommunities} AS TABLE school_communities`);
    await client.query(`CREATE TABLE ${backupPolicies} AS TABLE policies`);
    await client.query(`CREATE TABLE ${backupDistrictBoundaries} AS TABLE district_boundaries`);
    await client.query(`CREATE TABLE ${backupSchoolInfo} AS TABLE school_info`);

    const applied: Array<Record<string, unknown>> = [];

    for (const action of mergeActions) {
      const source = rowMap.get(action.sourceId);
      const target = rowMap.get(action.targetId);
      if (!source) continue;
      if (!target) throw new Error(`Missing target row for ${action.sourceId} -> ${action.targetId}`);

      const merged = buildMergedTarget(target, source, action);
      await client.query(
        `UPDATE schools
         SET name = $1,
             tier = $2,
             school_nature = $3::school_nature,
             address = $4,
             lat = $5,
             lng = $6,
             enrollment_note = $7,
             recent_score_line = $8,
             pit_risk_level = $9::pit_risk_level,
             website = $10,
             student_count = $11,
             school_scale = $12,
             faculty = $13,
             aliases = $14::text[],
             attrs = $15::jsonb,
             updated_at = now()
         WHERE id = $16`,
        [
          merged.targetName,
          merged.merged.tier,
          merged.merged.school_nature,
          merged.merged.address,
          merged.merged.lat,
          merged.merged.lng,
          merged.merged.enrollment_note,
          merged.merged.recent_score_line,
          merged.merged.pit_risk_level,
          merged.merged.website,
          merged.merged.student_count,
          merged.merged.school_scale,
          merged.merged.faculty,
          merged.aliases,
          JSON.stringify(merged.attrs),
          action.targetId,
        ],
      );

      const refMoves = {
        schoolCommunities: await moveSchoolCommunities(client, action.sourceId, action.targetId),
        policies: await moveSimpleRef(client, "policies", action.sourceId, action.targetId),
        districtBoundaries: await moveSimpleRef(client, "district_boundaries", action.sourceId, action.targetId),
        schoolInfo: await moveSimpleRef(client, "school_info", action.sourceId, action.targetId),
      };

      const deleted = await client.query("DELETE FROM schools WHERE id = $1 RETURNING id", [action.sourceId]);
      if ((deleted.rowCount ?? 0) !== 1) throw new Error(`Expected to delete source row ${action.sourceId}`);

      target.name = merged.targetName;
      target.aliases = merged.aliases;
      target.attrs = merged.attrs;
      for (const field of SCHOOL_FIELDS) {
        (target as unknown as Record<string, unknown>)[field] = merged.merged[field];
      }
      applied.push({ ...action, targetName: merged.targetName, deletedSourceName: source.name, refMoves, conflicts: merged.conflicts });
    }

    await client.query("COMMIT");
    writeFileSync(
      path.join(reportDir, "applied.json"),
      JSON.stringify(
        {
          backups: {
            schools: backupSchools,
            schoolCommunities: backupSchoolCommunities,
            policies: backupPolicies,
            districtBoundaries: backupDistrictBoundaries,
            schoolInfo: backupSchoolInfo,
          },
          applied,
        },
        null,
        2,
      ),
    );
    console.log(`Applied ${applied.length} actions. Report: ${reportDir}`);
  } catch (error) {
    if (apply) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
