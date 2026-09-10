/**
 * Third narrow pass for obvious abbreviated school names.
 *
 * Scope:
 * - hand-reviewed high-confidence rows only
 * - rename short names to full names, moving the old name to aliases / attrs.aliases
 * - merge only same-district/same-type duplicate rows when an existing full-name row is clearly the target
 * - record source/provenance in attrs.school_data_cleanup
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
const reportDir = path.join(process.cwd(), ".tmp", "normalize-school-short-names-round3", stamp);

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
    kind: "rename",
    id: 5662,
    to: "上海市世界外国语小学",
    source: "徐汇区义务教育阶段招生/学校官网",
    reason: "世界外国语小学补足上海市前缀",
  },
  {
    kind: "rename",
    id: 5664,
    to: "上海市徐汇区逸夫小学",
    source: "徐汇区义务教育阶段招生/学校官网",
    reason: "逸夫小学补足上海市徐汇区前缀",
  },
  {
    kind: "rename",
    id: 5665,
    to: "上海市民办盛大花园小学",
    source: "徐汇区义务教育阶段招生/学校官网",
    reason: "盛大花园小学补足上海市民办前缀",
  },
  {
    kind: "rename",
    id: 5666,
    to: "上海市徐汇区高安路第一小学",
    source: "徐汇区义务教育阶段招生/学校官网",
    reason: "高安路一小补足为高安路第一小学全称",
  },
  {
    kind: "rename",
    id: 5667,
    to: "上海市徐汇区向阳小学",
    source: "上海市教委徐汇区公办小学招生学校一览",
    reason: "向阳小学补足上海市徐汇区前缀",
  },
  {
    kind: "rename",
    id: 5668,
    to: "上海市徐汇区汇师小学",
    source: "徐汇区义务教育阶段招生/学校官网",
    reason: "汇师小学补足上海市徐汇区前缀",
  },
  {
    kind: "rename",
    id: 5779,
    to: "上海市徐汇区田林第三小学",
    source: "学校官网/徐汇教育公开页",
    reason: "田林第三小学补足上海市徐汇区前缀",
  },
  {
    kind: "rename",
    id: 5780,
    to: "上海市徐汇区第一中心小学",
    source: "学校官网/徐汇教育公开页",
    reason: "徐汇一中心补足正式校名",
  },
  {
    kind: "merge",
    sourceId: 5781,
    targetId: 3479,
    source: "同地址既有全称行/上海市教委徐汇区公办小学招生学校一览",
    reason: "上海小学按上中路200号合并到上海市徐汇区上海小学（本部校区）",
  },
  {
    kind: "rename",
    id: 5782,
    to: "上海市徐汇区田林第四小学",
    source: "徐汇区义务教育阶段招生/学校公开信息",
    reason: "田林四小补足为田林第四小学全称",
  },
  {
    kind: "rename",
    id: 5783,
    to: "上海市徐汇区东二小学",
    source: "上海市教委徐汇区公办小学招生学校一览/学校官网",
    reason: "东二小学补足上海市徐汇区前缀",
  },
  {
    kind: "rename",
    id: 4598,
    to: "上海市田林第三中学",
    source: "徐汇区义务教育阶段招生/学校公开信息",
    reason: "田林三中补足正式校名",
  },
  {
    kind: "rename",
    id: 4602,
    to: "上海市第四中学",
    source: "上海市教委徐汇区公办初中招生学校一览",
    reason: "市四中学补足上海市与数字全称",
  },
  {
    kind: "rename",
    id: 4603,
    to: "上海市第二中学",
    source: "徐汇区义务教育阶段招生/学校公开信息",
    reason: "市二中学补足上海市与数字全称",
  },
  {
    kind: "merge",
    sourceId: 5701,
    targetId: 4489,
    source: "同地址既有全称行/2025年普陀区校园开放日信息表",
    reason: "真如文英小学按北石路110号合并到上海市普陀区真如文英中心小学",
  },
  {
    kind: "merge",
    sourceId: 5703,
    targetId: 4490,
    source: "同区既有全称行/2025年普陀区校园开放日信息表",
    reason: "中山北路一小是上海市普陀区中山北路第一小学简称",
  },
  {
    kind: "rename",
    id: 5707,
    to: "上海市曹杨中学附属学校（小学部）",
    source: "2025年普陀区义务教育阶段学校教育教学设施和师资配置公示表",
    reason: "曹杨中学附属学校补足上海市前缀并保留小学部学段",
  },
  {
    kind: "rename",
    id: 3597,
    to: "上海市万里城实验学校（小学部）",
    source: "2025年普陀区义务教育阶段学校教育教学设施和师资配置公示表",
    reason: "万里城实验学校 小学部补足上海市前缀并规范括号",
  },
  {
    kind: "rename",
    id: 3598,
    to: "上海市中远实验学校（小学部）",
    source: "2025年普陀区义务教育阶段学校教育教学设施和师资配置公示表",
    reason: "中远实验学校 小学部补足上海市前缀并规范括号",
  },
  {
    kind: "rename",
    id: 3599,
    to: "上海市文达学校（小学部）",
    source: "2025年普陀区义务教育阶段学校教育教学设施和师资配置公示表",
    reason: "文达学校 小学部补足上海市前缀并规范括号",
  },
  {
    kind: "rename",
    id: 4607,
    to: "上海培佳双语学校（初中部）",
    source: "2025年普陀区义务教育阶段学校教育教学设施和师资配置公示表",
    reason: "培佳双语补足正式校名并保留初中部学段",
  },
  {
    kind: "rename",
    id: 4609,
    to: "上海市晋元高级中学附属学校（初中部）",
    source: "2025年普陀区校园开放日信息表/教育教学设施公示表",
    reason: "晋元附校补足正式校名并保留初中部学段",
  },
  {
    kind: "rename",
    id: 4610,
    to: "上海市中远实验学校（初中部）",
    source: "2025年普陀区义务教育阶段学校教育教学设施和师资配置公示表",
    reason: "中远实验补足正式校名并保留初中部学段",
  },
  {
    kind: "rename",
    id: 4611,
    to: "上海市曹杨第二中学附属学校（初中部）",
    source: "2025年普陀区校园开放日信息表/教育教学设施公示表",
    reason: "曹二附属补足正式校名并保留初中部学段",
  },
  {
    kind: "rename",
    id: 4615,
    to: "上海市洛川学校（初中部）",
    source: "2025年普陀区义务教育阶段学校教育教学设施和师资配置公示表",
    reason: "洛川中学按泾惠路123号补足为上海市洛川学校初中部",
  },
  {
    kind: "merge",
    sourceId: 5547,
    targetId: 4519,
    source: "2025年普陀区校园开放日信息表/教育教学设施公示表",
    reason: "普教院补足为普陀区教育学院附属中学全称",
  },
  {
    kind: "merge",
    sourceId: 4665,
    targetId: 4575,
    source: "既有全称行/别名已确认",
    reason: "同济存志是上海市存志中学别名",
  },
  {
    kind: "merge",
    sourceId: 4666,
    targetId: 4571,
    source: "既有全称行/别名已确认",
    reason: "上外双语是上海外国语大学附属双语学校简称",
  },
  {
    kind: "rename",
    id: 5723,
    to: "上海市杨浦区第二师范学校附属小学",
    source: "杨浦区义务教育阶段公办小学办学规模公开页",
    reason: "二师附小补足正式校名",
  },
  {
    kind: "merge",
    sourceId: 5724,
    targetId: 4546,
    source: "杨浦区义务教育阶段公办小学办学规模公开页",
    reason: "控江二小补足正式校名",
  },
  {
    kind: "merge",
    sourceId: 5726,
    targetId: 3643,
    source: "杨浦区义务教育阶段公办小学办学规模公开页",
    reason: "上理工附小补足正式校名",
  },
  {
    kind: "rename",
    id: 5732,
    to: "上海市杨浦区沪东外国语学校（小学部）",
    source: "杨浦区义务教育阶段公办小学办学规模公开页",
    reason: "沪东外国语学校小学行补足上海市杨浦区前缀并保留小学部",
  },
  {
    kind: "rename",
    id: 4671,
    to: "上海市杨浦区沪东外国语学校（初中部）",
    source: "杨浦区义务教育阶段学校公开信息",
    reason: "沪东外国语初中行补足上海市杨浦区前缀并保留初中部",
  },
  {
    kind: "rename",
    id: 4673,
    to: "上海市铁岭中学",
    source: "杨浦区义务教育阶段学校公开信息",
    reason: "铁岭中学补足上海市前缀",
  },
  {
    kind: "rename",
    id: 5163,
    to: "上海市控江初级中学",
    source: "杨浦区义务教育阶段学校公开信息",
    reason: "控江初级补足上海市与中学后缀",
  },
  {
    kind: "rename",
    id: 5164,
    to: "上海市辽阳中学",
    source: "杨浦区义务教育阶段学校公开信息",
    reason: "辽阳中学补足上海市前缀",
  },
  {
    kind: "rename",
    id: 5165,
    to: "上海市三门中学",
    source: "杨浦区义务教育阶段学校公开信息",
    reason: "三门中学补足上海市前缀",
  },
  {
    kind: "rename",
    id: 5166,
    to: "上海市国和中学",
    source: "杨浦区义务教育阶段学校公开信息",
    reason: "国和中学补足上海市前缀",
  },
  {
    kind: "rename",
    id: 5647,
    to: "上海市市东实验学校",
    source: "杨浦区义务教育阶段学校公开信息",
    reason: "市东中学按霍山路520号补足为现用学校名",
  },
  {
    kind: "rename",
    id: 5663,
    to: "上海市民办爱菊小学",
    source: "静安区义务教育阶段学校公开信息/学校官网",
    reason: "爱菊小学补足上海市民办前缀",
  },
  {
    kind: "merge",
    sourceId: 5681,
    targetId: 3530,
    source: "同区既有全称行/静安区义务教育阶段公办学校公开信息",
    reason: "静教附校是上海市静安区教育学院附属学校简称",
  },
  {
    kind: "rename",
    id: 5682,
    to: "上海市第一师范学校附属小学",
    source: "静安区义务教育阶段学校公开信息/学校官网",
    reason: "一师附小补足正式校名",
  },
  {
    kind: "rename",
    id: 4642,
    to: "上海市市西初级中学",
    source: "2025年静安区公办初中入学方式/办学条件公示",
    reason: "市西初级补足上海市与中学后缀",
  },
  {
    kind: "rename",
    id: 4643,
    to: "上海市市北初级中学",
    source: "2025年静安区公办初中入学方式/办学条件公示",
    reason: "市北初级补足上海市与中学后缀",
  },
  {
    kind: "rename",
    id: 4645,
    to: "上海市静安区教育学院附属学校（初中部）",
    source: "静安区义务教育阶段公办学校公开信息",
    reason: "静教院附校补足正式校名并保留初中部学段",
  },
  {
    kind: "merge",
    sourceId: 4648,
    targetId: 3575,
    source: "同区既有全称行",
    reason: "同济附属七一中学是同济大学附属七一中学简称",
  },
  {
    kind: "merge",
    sourceId: 4649,
    targetId: 3580,
    source: "同区既有全称行",
    reason: "上外苏河湾实验中学是上海外国语大学苏河湾实验中学简称",
  },
  {
    kind: "rename",
    id: 4652,
    to: "上海市新和中学",
    source: "静安区义务教育阶段学校公开信息",
    reason: "新和中学补足上海市前缀",
  },
  {
    kind: "rename",
    id: 5030,
    to: "上海市江宁学校（初中部）",
    source: "2025年普陀区义务教育阶段学校教育教学设施和师资配置公示表",
    reason: "江宁学校按西康路1518弄1号补足上海市并保留初中部学段",
  },
  {
    kind: "rename",
    id: 5550,
    to: "上海市田家炳中学",
    source: "静安区义务教育阶段学校公开信息",
    reason: "田家炳补足上海市与中学后缀",
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
    kind: action.kind === "rename" ? "rename_short_school_name_round3" : "merge_short_name_row_round3",
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
  const moved = await client.query(
    `UPDATE school_communities SET school_id = $1 WHERE school_id = $2 RETURNING id`,
    [targetId, sourceId],
  );
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
    }

    writeFileSync(path.join(reportDir, "plan.json"), JSON.stringify({ apply, actions: plan }, null, 2));
    console.log(`Plan: actions=${plan.length}, rename=${actions.filter((a) => a.kind === "rename").length}, merge=${actions.filter((a) => a.kind === "merge").length}. Report: ${reportDir}`);
    if (!apply) return;

    const backupSchools = `schools_short_names_round3_backup_${stamp}`;
    const backupSchoolCommunities = `school_communities_short_names_round3_backup_${stamp}`;
    const backupPolicies = `policies_short_names_round3_backup_${stamp}`;
    const backupDistrictBoundaries = `district_boundaries_short_names_round3_backup_${stamp}`;
    const backupSchoolInfo = `school_info_short_names_round3_backup_${stamp}`;

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
