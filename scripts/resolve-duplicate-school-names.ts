/**
 * Resolve duplicate school names without losing linked data.
 *
 * Rules:
 * - same name across primary/middle rows: keep both rows and append （小学部）/（中学部）
 * - same name within the same district + type: merge into the strongest target row
 * - merge references before deleting a duplicate source row
 * - merge useful scalar fields, aliases, and keep source attrs under attrs.school_data_merged_sources
 *
 * Safety:
 * - dry-run by default; pass --apply to commit
 * - creates full backup tables before applying
 * - writes plan/applied reports under .tmp/resolve-duplicate-school-names/
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
const reportDir = path.join(process.cwd(), ".tmp", "resolve-duplicate-school-names", stamp);

type SchoolRow = {
  id: number;
  name: string;
  aliases: string[] | null;
  district: string;
  tier: string | null;
  type: "primary" | "middle" | "nine_year";
  school_nature: "公立" | "私立" | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  enrollment_note: string | null;
  recent_score_line: string | null;
  pit_risk_level: string | null;
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

type RenameAction = {
  kind: "rename_section";
  id: number;
  from: string;
  to: string;
  reason: string;
};

type MergeAction = {
  kind: "merge_duplicate";
  name: string;
  targetId: number;
  sourceIds: number[];
  reason: string;
};

type ManualAction = {
  kind: "manual_review";
  name: string;
  ids: number[];
  reason: string;
};

type Action = RenameAction | MergeAction | ManualAction;

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

function sectionSuffix(type: SchoolRow["type"]) {
  if (type === "primary") return "（小学部）";
  if (type === "middle") return "（中学部）";
  return "（九年一贯制）";
}

function hasSectionSuffix(name: string) {
  return /（(?:小学部|中学部|初中部|九年一贯制)）$/.test(name);
}

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function nonEmpty(value: unknown) {
  if (value == null) return false;
  if (typeof value === "string") return !PLACEHOLDER_VALUES.has(value.trim());
  return true;
}

function refCount(row: SchoolRow) {
  return row.school_communities + row.policies + row.district_boundaries + row.school_info;
}

function scoreMergeTarget(row: SchoolRow) {
  const dataSource = typeof row.attrs?.data_source === "string" ? row.attrs.data_source : "";
  return (
    refCount(row) * 1000 +
    (dataSource === "xhs-flush" ? -500 : 0) +
    (row.school_nature ? 80 : 0) +
    (row.address ? 60 : 0) +
    (row.lat != null && row.lng != null ? 50 : 0) +
    (nonEmpty(row.tier) ? 30 : 0) +
    (row.student_count != null ? 10 : 0) -
    row.id / 100000
  );
}

function rowSummary(row: SchoolRow) {
  return {
    id: row.id,
    name: row.name,
    district: row.district,
    type: row.type,
    refs: {
      schoolCommunities: row.school_communities,
      policies: row.policies,
      districtBoundaries: row.district_boundaries,
      schoolInfo: row.school_info,
    },
    tier: row.tier,
    schoolNature: row.school_nature,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    aliases: row.aliases ?? [],
    dataSource: row.attrs?.data_source,
  };
}

function chooseValue<T>(target: T, source: T): T {
  return nonEmpty(target) ? target : source;
}

function mergeAttrs(target: Record<string, unknown> | null, source: SchoolRow) {
  const next = { ...(target ?? {}) };
  next.school_data_merged_sources = [
    ...(Array.isArray(next.school_data_merged_sources) ? next.school_data_merged_sources : []),
    {
      merged_at: detectedAt,
      source_id: source.id,
      source_name: source.name,
      source_district: source.district,
      source_type: source.type,
      source_refs: {
        schoolCommunities: source.school_communities,
        policies: source.policies,
        districtBoundaries: source.district_boundaries,
        schoolInfo: source.school_info,
      },
      source_fields: Object.fromEntries(
        SCHOOL_FIELDS.map((field) => [field, source[field]]).filter(([, value]) => nonEmpty(value)),
      ),
      source_attrs: source.attrs,
    },
  ];
  return next;
}

function buildMergedTarget(target: SchoolRow, sources: SchoolRow[]) {
  const merged: Record<string, unknown> = {};
  const conflicts: Array<Record<string, unknown>> = [];

  for (const field of SCHOOL_FIELDS) {
    let value: unknown = target[field];
    for (const source of sources) {
      const sourceValue = source[field];
      if (!nonEmpty(value) && nonEmpty(sourceValue)) {
        value = sourceValue;
      } else if (
        nonEmpty(value) &&
        nonEmpty(sourceValue) &&
        JSON.stringify(value) !== JSON.stringify(sourceValue) &&
        !["address", "lat", "lng"].includes(field)
      ) {
        conflicts.push({ field, target: value, sourceId: source.id, source: sourceValue });
      }
    }
    merged[field] = value;
  }

  const aliases = unique([
    ...(target.aliases ?? []),
    ...sources.flatMap((source) => [source.name, ...(source.aliases ?? [])]),
  ]).filter((alias) => alias !== target.name);

  let attrs = target.attrs;
  for (const source of sources) attrs = mergeAttrs(attrs, source);
  attrs = {
    ...(attrs ?? {}),
    aliases,
    school_data_merge_conflicts: conflicts,
  };

  return { merged, aliases, attrs, conflicts };
}

async function loadDuplicateRows(client: pg.Client) {
  const result = await client.query<SchoolRow>(
    `WITH dup AS (
       SELECT name
       FROM schools
       GROUP BY name
       HAVING count(*) > 1
     )
     SELECT
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
     JOIN dup USING (name)
     LEFT JOIN (SELECT school_id, count(*) c FROM school_communities GROUP BY school_id) sc ON sc.school_id = s.id
     LEFT JOIN (SELECT school_id, count(*) c FROM policies GROUP BY school_id) p ON p.school_id = s.id
     LEFT JOIN (SELECT school_id, count(*) c FROM district_boundaries GROUP BY school_id) db ON db.school_id = s.id
     LEFT JOIN (SELECT school_id, count(*) c FROM school_info GROUP BY school_id) si ON si.school_id = s.id
     ORDER BY s.name, s.district, s.type::text, s.id`,
  );
  return result.rows;
}

function buildActions(rows: SchoolRow[]) {
  const byName = new Map<string, SchoolRow[]>();
  for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);

  const actions: Action[] = [];

  for (const [name, group] of byName) {
    const sameDistrict = new Set(group.map((row) => row.district)).size === 1;
    const types = new Set(group.map((row) => row.type));
    const sameTypeGroups = new Map<string, SchoolRow[]>();
    for (const row of group) {
      const key = `${row.district}\t${row.type}`;
      sameTypeGroups.set(key, [...(sameTypeGroups.get(key) ?? []), row]);
    }

    const hasSameTypeDuplicates = Array.from(sameTypeGroups.values()).some((items) => items.length > 1);
    if (types.size > 1 && sameDistrict && !hasSameTypeDuplicates) {
      for (const row of group) {
        const suffix = sectionSuffix(row.type);
        const to = hasSectionSuffix(row.name) ? row.name : `${row.name}${suffix}`;
        if (to !== row.name) {
          actions.push({
            kind: "rename_section",
            id: row.id,
            from: row.name,
            to,
            reason: `同一学校拆成 ${Array.from(types).join("/")} 学段，补充学部后缀避免同名`,
          });
        }
      }
      continue;
    }

    let acted = false;
    for (const [, items] of sameTypeGroups) {
      if (items.length < 2) continue;
      const sorted = [...items].sort((a, b) => scoreMergeTarget(b) - scoreMergeTarget(a));
      const target = sorted[0];
      actions.push({
        kind: "merge_duplicate",
        name,
        targetId: target.id,
        sourceIds: sorted.slice(1).map((row) => row.id),
        reason: "同区同学段同名，按引用数/官方来源/字段完整度选择目标行并合并",
      });
      acted = true;
    }

    if (!acted) {
      actions.push({
        kind: "manual_review",
        name,
        ids: group.map((row) => row.id),
        reason: "重复形态不满足自动改名或自动合并规则",
      });
    }
  }

  return actions;
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

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const rows = await loadDuplicateRows(client);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const actions = buildActions(rows);
    const manual = actions.filter((action): action is ManualAction => action.kind === "manual_review");
    const plan = actions.map((action) => {
      if (action.kind === "rename_section") return { ...action, row: rowSummary(byId.get(action.id)!) };
      if (action.kind === "merge_duplicate") {
        return {
          ...action,
          target: rowSummary(byId.get(action.targetId)!),
          sources: action.sourceIds.map((id) => rowSummary(byId.get(id)!)),
          mergedPreview: buildMergedTarget(
            byId.get(action.targetId)!,
            action.sourceIds.map((id) => byId.get(id)!),
          ),
        };
      }
      return action;
    });

    writeFileSync(path.join(reportDir, "plan.json"), JSON.stringify({ apply, actions: plan }, null, 2));

    const renameCount = actions.filter((action) => action.kind === "rename_section").length;
    const mergeCount = actions.filter((action) => action.kind === "merge_duplicate").length;
    const deleteCount = actions
      .filter((action): action is MergeAction => action.kind === "merge_duplicate")
      .reduce((sum, action) => sum + action.sourceIds.length, 0);

    console.log(
      `Plan: rename=${renameCount}, mergeGroups=${mergeCount}, deleteAfterMerge=${deleteCount}, manual=${manual.length}. Report: ${reportDir}`,
    );
    if (manual.length > 0) {
      console.log(`Manual review required: ${manual.map((item) => item.name).join(", ")}`);
    }

    if (!apply) return;

    const backupSchools = `schools_duplicate_names_backup_${stamp}`;
    const backupSchoolCommunities = `school_communities_duplicate_names_backup_${stamp}`;
    const backupPolicies = `policies_duplicate_names_backup_${stamp}`;
    const backupDistrictBoundaries = `district_boundaries_duplicate_names_backup_${stamp}`;
    const backupSchoolInfo = `school_info_duplicate_names_backup_${stamp}`;

    await client.query("BEGIN");
    await client.query(`CREATE TABLE ${backupSchools} AS TABLE schools`);
    await client.query(`CREATE TABLE ${backupSchoolCommunities} AS TABLE school_communities`);
    await client.query(`CREATE TABLE ${backupPolicies} AS TABLE policies`);
    await client.query(`CREATE TABLE ${backupDistrictBoundaries} AS TABLE district_boundaries`);
    await client.query(`CREATE TABLE ${backupSchoolInfo} AS TABLE school_info`);

    const applied: Array<Record<string, unknown>> = [];

    for (const action of actions) {
      if (action.kind === "manual_review") continue;

      if (action.kind === "rename_section") {
        const row = byId.get(action.id);
        if (!row) throw new Error(`Missing row ${action.id}`);
        const aliases = unique([...(row.aliases ?? []), action.from]);
        const attrs = {
          ...(row.attrs ?? {}),
          aliases,
          school_data_cleanup: [
            ...(Array.isArray(row.attrs?.school_data_cleanup) ? row.attrs.school_data_cleanup : []),
            {
              kind: action.kind,
              previous_name: action.from,
              new_name: action.to,
              reason: action.reason,
              detected_at: detectedAt,
            },
          ],
        };

        await client.query(
          `UPDATE schools
           SET name = $1,
               aliases = $2::text[],
               attrs = $3::jsonb,
               updated_at = now()
           WHERE id = $4 AND name = $5`,
          [action.to, aliases, JSON.stringify(attrs), action.id, action.from],
        );
        applied.push(action);
        continue;
      }

      const target = byId.get(action.targetId);
      if (!target) throw new Error(`Missing target row ${action.targetId}`);
      const sources = action.sourceIds.map((id) => {
        const source = byId.get(id);
        if (!source) throw new Error(`Missing source row ${id}`);
        return source;
      });

      const merged = buildMergedTarget(target, sources);
      await client.query(
        `UPDATE schools
         SET tier = $1,
             school_nature = $2::school_nature,
             address = $3,
             lat = $4,
             lng = $5,
             enrollment_note = $6,
             recent_score_line = $7,
             pit_risk_level = $8::pit_risk_level,
             website = $9,
             student_count = $10,
             school_scale = $11,
             faculty = $12,
             aliases = $13::text[],
             attrs = $14::jsonb,
             updated_at = now()
         WHERE id = $15`,
        [
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

      const refMoves = [];
      for (const source of sources) {
        refMoves.push({
          sourceId: source.id,
          schoolCommunities: await moveSchoolCommunities(client, source.id, action.targetId),
          policies: await moveSimpleRef(client, "policies", source.id, action.targetId),
          districtBoundaries: await moveSimpleRef(client, "district_boundaries", source.id, action.targetId),
          schoolInfo: await moveSimpleRef(client, "school_info", source.id, action.targetId),
        });
      }

      const deleted = await client.query("DELETE FROM schools WHERE id = ANY($1::int[]) RETURNING id", [
        action.sourceIds,
      ]);
      if ((deleted.rowCount ?? 0) !== action.sourceIds.length) {
        throw new Error(`Expected to delete ${action.sourceIds.length} rows for ${action.name}, deleted ${deleted.rowCount}`);
      }
      applied.push({ ...action, refMoves, conflicts: merged.conflicts });
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
          manual,
        },
        null,
        2,
      ),
    );
    console.log(`Applied. Report: ${reportDir}`);
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
