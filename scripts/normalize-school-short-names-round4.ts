/**
 * Fourth narrow pass for obvious abbreviated school names.
 *
 * Scope:
 * - hand-reviewed high-confidence rows only
 * - rename short names to full names, moving the old name to aliases / attrs.aliases
 * - merge only same-district/same-type duplicate rows when an existing full-name row is clearly the target
 * - record source/provenance in attrs.school_data_cleanup
 *
 * Deliberately skipped in this pass:
 * - rows with polluted addresses
 * - cross-district or cross-type duplicates
 * - rows whose full name was not backed by official public data or an existing confirmed full-name row
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
const reportDir = path.join(process.cwd(), ".tmp", "normalize-school-short-names-round4", stamp);

type SchoolRow = {
  id: number;
  name: string;
  aliases: string[] | null;
  district: string;
  type: string;
  attrs: Record<string, unknown> | null;
};

type RenameAction = {
  kind: "rename";
  id: number;
  to: string;
  source: string;
  reason: string;
};

type MergeAction = {
  kind: "merge";
  sourceId: number;
  targetId: number;
  source: string;
  reason: string;
};

type Action = RenameAction | MergeAction;

const actions: Action[] = [
  {
    kind: "merge",
    sourceId: 4599,
    targetId: 3488,
    source:
      "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表：https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html；同区同类型既有全称行",
    reason: "徐教院附中是上海市徐汇区教育学院附属实验中学简称，合并到既有全称行",
  },
  {
    kind: "rename",
    id: 4600,
    to: "上海市园南中学",
    source:
      "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表：https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
    reason: "园南中学补足上海市前缀为官方学校名",
  },
  {
    kind: "merge",
    sourceId: 4604,
    targetId: 3493,
    source:
      "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表：https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html；同区同类型既有全称行",
    reason: "华理工附中是华东理工大学附属中学简称，合并到既有全称行",
  },
  {
    kind: "rename",
    id: 4702,
    to: "上海市第二初级中学",
    source:
      "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表：https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
    reason: "市二初级中学补足上海市与数字全称",
  },
  {
    kind: "rename",
    id: 4704,
    to: "上海民办南模中学",
    source:
      "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表：https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
    reason: "民办南模中学补足上海前缀为官方学校名",
  },
  {
    kind: "rename",
    id: 4708,
    to: "上海市南洋初级中学",
    source:
      "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表：https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
    reason: "南洋初级中学补足上海市前缀为官方学校名",
  },
  {
    kind: "merge",
    sourceId: 4709,
    targetId: 3493,
    source:
      "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表：https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html；同区同类型既有全称行",
    reason: "华理附中是华东理工大学附属中学简称，合并到既有全称行",
  },
  {
    kind: "merge",
    sourceId: 4710,
    targetId: 3486,
    source:
      "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表：https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html；同区同类型既有全称行",
    reason: "康健外国语学校是上海市康健外国语实验中学简称，合并到既有全称行",
  },
  {
    kind: "rename",
    id: 4736,
    to: "上海民办位育中学",
    source:
      "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表：https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
    reason: "民办位育补足上海与中学后缀为官方学校名",
  },
  {
    kind: "rename",
    id: 4647,
    to: "民办上海上外静安外国语中学",
    source:
      "2025年静安区义务教育阶段民办学校教育教学设施和师资配置公示表：https://www.shanghai.gov.cn/jaqywjy/20250407/3ba46a7afd384d72a690425b8667ddf9.html",
    reason: "上外静中补足为官方民办初中学校名",
  },
  {
    kind: "rename",
    id: 5675,
    to: "民办上海上外静安外国语小学",
    source:
      "2025年静安区义务教育阶段民办学校教育教学设施和师资配置公示表：https://www.shanghai.gov.cn/jaqywjy/20250407/3ba46a7afd384d72a690425b8667ddf9.html",
    reason: "上外静小补足为官方民办小学学校名",
  },
  {
    kind: "merge",
    sourceId: 5730,
    targetId: 4565,
    source:
      "2025年杨浦区义务教育阶段公办小学基本情况公示及招生计划 PDF：https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-xxzs/20250407/477710/d1833493558244b3ad870c206b1b43d0.pdf；同区同类型既有全称行",
    reason: "上音实验学校小学行合并到上海音乐学院实验学校（小学部）",
  },
  {
    kind: "merge",
    sourceId: 5734,
    targetId: 3653,
    source: "同区同类型既有全称行",
    reason: "平凉路三小是上海市杨浦区平凉路第三小学简称，合并到既有全称行",
  },
  {
    kind: "merge",
    sourceId: 5742,
    targetId: 3654,
    source: "同区同类型既有全称行；既有别名含齐齐哈尔路第一小学",
    reason: "齐一小学是上海市杨浦区齐齐哈尔路第一小学简称，合并到既有全称行",
  },
  {
    kind: "merge",
    sourceId: 5743,
    targetId: 4538,
    source:
      "2025年杨浦区义务教育阶段公办小学基本情况公示及招生计划 PDF：https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-xxzs/20250407/477710/d1833493558244b3ad870c206b1b43d0.pdf；同区同类型既有全称行",
    reason: "打一小学是上海市杨浦区打虎山路第一小学简称，合并到既有全称行",
  },
];

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function refs(row: SchoolRow) {
  return {
    id: row.id,
    name: row.name,
    district: row.district,
    type: row.type,
    aliases: row.aliases ?? [],
  };
}

function attrsAliases(attrs: Record<string, unknown> | null) {
  return Array.isArray(attrs?.aliases) ? attrs.aliases.map(String) : [];
}

function cleanupEntry(action: Action, previousName: string, nextName: string) {
  return {
    kind: action.kind === "rename" ? "rename_short_school_name_round4" : "merge_short_name_row_round4",
    previous_name: previousName,
    new_name: nextName,
    source: action.source,
    reason: action.reason,
    detected_at: detectedAt,
  };
}

function withCleanup(row: SchoolRow, aliasesToAdd: string[], nextName: string, action: Action) {
  const attrs = { ...(row.attrs ?? {}) };
  const aliases = unique([...attrsAliases(attrs), ...(row.aliases ?? []), ...aliasesToAdd]).filter((alias) => alias !== nextName);
  attrs.aliases = aliases;
  attrs.school_data_cleanup = [
    ...(Array.isArray(attrs.school_data_cleanup) ? attrs.school_data_cleanup : []),
    cleanupEntry(action, row.name, nextName),
  ];
  return { aliases, attrs };
}

async function loadRows(client: pg.Client, ids: number[]) {
  const result = await client.query<SchoolRow>(
    `SELECT id, name, aliases, district, type::text, attrs
     FROM schools
     WHERE id = ANY($1::int[])
     ORDER BY id`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

async function assertNoConflict(client: pg.Client, row: SchoolRow, nextName: string) {
  if (row.name === nextName) return;
  const conflict = await client.query(
    `SELECT id, name, district, type::text
     FROM schools
     WHERE id <> $1 AND name = $2 AND district = $3 AND type = $4::school_type`,
    [row.id, nextName, row.district, row.type],
  );
  if ((conflict.rowCount ?? 0) > 0) {
    throw new Error(`Name conflict for ${row.id} -> ${nextName}: ${JSON.stringify(conflict.rows)}`);
  }
}

async function moveSchoolCommunities(client: pg.Client, sourceId: number, targetId: number) {
  const deleted = await client.query(
    `DELETE FROM school_communities sc
     WHERE sc.school_id = $1
       AND EXISTS (
         SELECT 1 FROM school_communities kept
         WHERE kept.school_id = $2
           AND kept.community_id = sc.community_id
           AND kept.year = sc.year
       )
     RETURNING id`,
    [sourceId, targetId],
  );
  const moved = await client.query(`UPDATE school_communities SET school_id = $1 WHERE school_id = $2 RETURNING id`, [
    targetId,
    sourceId,
  ]);
  return { moved: moved.rowCount ?? 0, deletedConflicts: deleted.rowCount ?? 0 };
}

async function moveSimpleRef(client: pg.Client, table: string, sourceId: number, targetId: number) {
  const result = await client.query(`UPDATE ${table} SET school_id = $1 WHERE school_id = $2 RETURNING id`, [targetId, sourceId]);
  return result.rowCount ?? 0;
}

async function main() {
  mkdirSync(reportDir, { recursive: true });
  const ids = unique(
    actions.flatMap((action) => (action.kind === "rename" ? [String(action.id)] : [String(action.sourceId), String(action.targetId)])),
  ).map(Number);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const rows = await loadRows(client, ids);
    const plan: Array<Record<string, unknown>> = [];
    for (const action of actions) {
      if (action.kind === "rename") {
        const row = rows.get(action.id);
        if (!row) throw new Error(`Missing rename row ${action.id}`);
        await assertNoConflict(client, row, action.to);
        const next = withCleanup(row, [row.name], action.to, action);
        plan.push({ ...action, row: refs(row), aliases: next.aliases });
        rows.set(action.id, { ...row, name: action.to, aliases: next.aliases, attrs: next.attrs });
        continue;
      }
      const source = rows.get(action.sourceId);
      const target = rows.get(action.targetId);
      if (!source) throw new Error(`Missing merge source row ${action.sourceId}`);
      if (!target) throw new Error(`Missing merge target row ${action.targetId}`);
      if (source.district !== target.district) throw new Error(`Refusing cross-district merge ${source.id} -> ${target.id}`);
      if (source.type !== target.type) throw new Error(`Refusing cross-type merge ${source.id} -> ${target.id}`);
      const next = withCleanup(target, [target.name, source.name, ...(source.aliases ?? [])], target.name, action);
      plan.push({ ...action, sourceRow: refs(source), targetRow: refs(target), aliases: next.aliases });
      rows.set(action.targetId, { ...target, aliases: next.aliases, attrs: next.attrs });
      rows.delete(action.sourceId);
    }

    writeFileSync(path.join(reportDir, "plan.json"), JSON.stringify({ apply, actions: plan }, null, 2));
    console.log(
      `Plan: actions=${plan.length}, rename=${actions.filter((a) => a.kind === "rename").length}, merge=${actions.filter((a) => a.kind === "merge").length}. Report: ${reportDir}`,
    );
    if (!apply) return;

    const backupSchools = `schools_short_names_round4_backup_${stamp}`;
    const backupSchoolCommunities = `school_communities_short_names_round4_backup_${stamp}`;
    const backupPolicies = `policies_short_names_round4_backup_${stamp}`;
    const backupDistrictBoundaries = `district_boundaries_short_names_round4_backup_${stamp}`;
    const backupSchoolInfo = `school_info_short_names_round4_backup_${stamp}`;

    await client.query("BEGIN");
    await client.query(`CREATE TABLE ${backupSchools} AS TABLE schools`);
    await client.query(`CREATE TABLE ${backupSchoolCommunities} AS TABLE school_communities`);
    await client.query(`CREATE TABLE ${backupPolicies} AS TABLE policies`);
    await client.query(`CREATE TABLE ${backupDistrictBoundaries} AS TABLE district_boundaries`);
    await client.query(`CREATE TABLE ${backupSchoolInfo} AS TABLE school_info`);

    const applied: Array<Record<string, unknown>> = [];
    for (const action of actions) {
      if (action.kind === "rename") {
        const row = rows.get(action.id);
        if (!row) throw new Error(`Missing rename row ${action.id}`);
        const next = withCleanup(row, [row.name], action.to, action);
        await client.query(
          `UPDATE schools
           SET name = $1, aliases = $2::text[], attrs = $3::jsonb, updated_at = now()
           WHERE id = $4`,
          [action.to, next.aliases, JSON.stringify(next.attrs), action.id],
        );
        rows.set(action.id, { ...row, name: action.to, aliases: next.aliases, attrs: next.attrs });
        applied.push({ ...action, previousName: row.name, aliases: next.aliases });
        continue;
      }

      const source = rows.get(action.sourceId);
      const target = rows.get(action.targetId);
      if (!source || !target) throw new Error(`Missing merge row ${action.sourceId} -> ${action.targetId}`);
      const next = withCleanup(target, [target.name, source.name, ...(source.aliases ?? [])], target.name, action);
      next.attrs.school_data_merged_sources = [
        ...(Array.isArray(next.attrs.school_data_merged_sources) ? next.attrs.school_data_merged_sources : []),
        {
          merged_at: detectedAt,
          source_row: refs(source),
          source_attrs: source.attrs,
        },
      ];
      await client.query(
        `UPDATE schools
         SET aliases = $1::text[], attrs = $2::jsonb, updated_at = now()
         WHERE id = $3`,
        [next.aliases, JSON.stringify(next.attrs), action.targetId],
      );
      const refMoves = {
        schoolCommunities: await moveSchoolCommunities(client, action.sourceId, action.targetId),
        policies: await moveSimpleRef(client, "policies", action.sourceId, action.targetId),
        districtBoundaries: await moveSimpleRef(client, "district_boundaries", action.sourceId, action.targetId),
        schoolInfo: await moveSimpleRef(client, "school_info", action.sourceId, action.targetId),
      };
      const deleted = await client.query("DELETE FROM schools WHERE id = $1 RETURNING id", [action.sourceId]);
      if ((deleted.rowCount ?? 0) !== 1) throw new Error(`Expected to delete source row ${action.sourceId}`);
      rows.set(action.targetId, { ...target, aliases: next.aliases, attrs: next.attrs });
      rows.delete(action.sourceId);
      applied.push({ ...action, deletedSourceName: source.name, targetName: target.name, aliases: next.aliases, refMoves });
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
