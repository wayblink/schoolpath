/**
 * Clean the remaining category 3/4 school-data issues.
 *
 * Category 3: cross-district artifacts or colloquial aliases imported as rows.
 * Category 4: obvious non-school parser garbage.
 *
 * Safety:
 * - dry-run by default; pass --apply to write
 * - creates a full schools backup table before applying
 * - deletes/merges only rows with zero references
 * - preserves decisions in attrs.school_data_cleanup / attrs.school_data_issue
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
const reportDir = path.join(process.cwd(), ".tmp", "clean-school-data-issues", stamp);

type SchoolRow = {
  id: number;
  name: string;
  aliases: string[] | null;
  district: string;
  type: string;
  address: string | null;
  attrs: Record<string, unknown> | null;
  school_communities: string | number;
  policies: string | number;
  district_boundaries: string | number;
  school_info: string | number;
};

type MergeAction = {
  kind: "merge_alias_row";
  sourceId: number;
  targetId: number;
  aliases: string[];
  reason: string;
};

type DeleteAction = {
  kind: "delete_garbage_row";
  id: number;
  reason: string;
};

type DistrictAction = {
  kind: "correct_district";
  id: number;
  toDistrict: string;
  reason: string;
};

type IssueAction = {
  kind: "mark_issue";
  id: number;
  issueKind: "non_school_name";
  reviewStatus: "needs_manual_policy_relink";
  reason: string;
};

type Action = MergeAction | DeleteAction | DistrictAction | IssueAction;

const mergeActions: MergeAction[] = [
  {
    kind: "merge_alias_row",
    sourceId: 4760,
    targetId: 4566,
    aliases: ["华曜嘉定"],
    reason: "浦东行是嘉定学校简称误入，目标校已有正式行",
  },
  {
    kind: "merge_alias_row",
    sourceId: 4761,
    targetId: 4467,
    aliases: ["华曜宝山"],
    reason: "浦东行是宝山学校简称误入，目标校已有正式行",
  },
  {
    kind: "merge_alias_row",
    sourceId: 4778,
    targetId: 4571,
    aliases: ["杨浦双语"],
    reason: "浦东行是杨浦双语简称误入，目标校已有正式行",
  },
  {
    kind: "merge_alias_row",
    sourceId: 5680,
    targetId: 3453,
    aliases: ["上海实验小学", "黄浦上海实验小学"],
    reason: "静安行是黄浦上海市实验小学别名误入，目标校已有正式行",
  },
];

const deleteActions: DeleteAction[] = [
  { kind: "delete_garbage_row", id: 4692, reason: "name 是问句片段，不是学校名，且无引用" },
  { kind: "delete_garbage_row", id: 5083, reason: "name 是列表残片，不是单个学校名，且无引用" },
  { kind: "delete_garbage_row", id: 5084, reason: "name 是列表残片，不是单个学校名，且无引用" },
  { kind: "delete_garbage_row", id: 5493, reason: "name 是评论/意图片段，不是学校名，且无引用" },
  { kind: "delete_garbage_row", id: 5569, reason: "name 只有外区名，不是学校名，且无引用" },
];

const districtActions: DistrictAction[] = [
  { kind: "correct_district", id: 4781, toDistrict: "松江", reason: "九峰实验属于松江语境，原浦东为跨区误入" },
  { kind: "correct_district", id: 4785, toDistrict: "青浦", reason: "名称自带青浦兰生，原浦东为跨区误入" },
  { kind: "correct_district", id: 4786, toDistrict: "青浦", reason: "名称自带青浦世外，原浦东为跨区误入" },
  { kind: "correct_district", id: 5779, toDistrict: "徐汇", reason: "田林第三小学属于徐汇语境，原闵行为跨区误入" },
  { kind: "correct_district", id: 5780, toDistrict: "徐汇", reason: "徐汇一中心名称自带徐汇，原闵行为跨区误入" },
  { kind: "correct_district", id: 5781, toDistrict: "徐汇", reason: "上海小学属于徐汇语境，原闵行为跨区误入" },
  { kind: "correct_district", id: 5782, toDistrict: "徐汇", reason: "田林四小属于徐汇语境，原闵行为跨区误入" },
  { kind: "correct_district", id: 5783, toDistrict: "徐汇", reason: "东二小学属于徐汇语境，原闵行为跨区误入" },
];

const issueActions: IssueAction[] = [
  {
    kind: "mark_issue",
    id: 3944,
    issueKind: "non_school_name",
    reviewStatus: "needs_manual_policy_relink",
    reason: "学校名字段是表头文本，但行有 policy 引用，不能直接删除",
  },
  {
    kind: "mark_issue",
    id: 4227,
    issueKind: "non_school_name",
    reviewStatus: "needs_manual_policy_relink",
    reason: "学校名字段是完整学区边界文本，但行有 policy 引用，不能直接删除",
  },
  {
    kind: "mark_issue",
    id: 4233,
    issueKind: "non_school_name",
    reviewStatus: "needs_manual_policy_relink",
    reason: "学校名字段是完整学区边界文本，但行有 policy 引用，不能直接删除",
  },
  {
    kind: "mark_issue",
    id: 4303,
    issueKind: "non_school_name",
    reviewStatus: "needs_manual_policy_relink",
    reason: "学校名字段是办学性质/学段标签，但行有 policy 引用，不能直接删除",
  },
];

const actions: Action[] = [...mergeActions, ...deleteActions, ...districtActions, ...issueActions];

function refCount(row: SchoolRow) {
  return (
    Number(row.school_communities) +
    Number(row.policies) +
    Number(row.district_boundaries) +
    Number(row.school_info)
  );
}

function refs(row: SchoolRow) {
  return {
    schoolCommunities: Number(row.school_communities),
    policies: Number(row.policies),
    districtBoundaries: Number(row.district_boundaries),
    schoolInfo: Number(row.school_info),
  };
}

function unique(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function attrsWithAliasAndCleanup(
  attrs: Record<string, unknown> | null,
  aliases: string[],
  cleanup: Record<string, unknown>,
) {
  const next = { ...(attrs ?? {}) };
  next.aliases = unique([...(Array.isArray(next.aliases) ? next.aliases.map(String) : []), ...aliases]);
  next.school_data_cleanup = [
    ...(Array.isArray(next.school_data_cleanup) ? next.school_data_cleanup : []),
    cleanup,
  ];
  return next;
}

function attrsWithCleanup(attrs: Record<string, unknown> | null, cleanup: Record<string, unknown>) {
  const next = { ...(attrs ?? {}) };
  next.school_data_cleanup = [
    ...(Array.isArray(next.school_data_cleanup) ? next.school_data_cleanup : []),
    cleanup,
  ];
  return next;
}

function attrsWithIssue(attrs: Record<string, unknown> | null, issue: Record<string, unknown>) {
  return {
    ...(attrs ?? {}),
    school_data_issue: issue,
  };
}

async function loadRows(client: pg.Client, ids: number[]) {
  const result = await client.query<SchoolRow>(
    `SELECT
       s.id,
       s.name,
       s.aliases,
       s.district,
       s.type::text,
       s.address,
       s.attrs,
       COALESCE(sc.c, 0) AS school_communities,
       COALESCE(p.c, 0) AS policies,
       COALESCE(db.c, 0) AS district_boundaries,
       COALESCE(si.c, 0) AS school_info
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

async function updateTargetAliases(client: pg.Client, target: SchoolRow, action: MergeAction, source: SchoolRow) {
  const aliases = unique([...(target.aliases ?? []), ...action.aliases, source.name]);
  const attrs = attrsWithAliasAndCleanup(target.attrs, action.aliases, {
    kind: action.kind,
    merged_source_id: action.sourceId,
    merged_source_name: source.name,
    reason: action.reason,
    detected_at: detectedAt,
  });

  await client.query(
    `UPDATE schools
     SET aliases = $1::text[],
         attrs = $2::jsonb,
         updated_at = now()
     WHERE id = $3`,
    [aliases, JSON.stringify(attrs), action.targetId],
  );
}

async function main() {
  mkdirSync(reportDir, { recursive: true });

  const ids = unique(
    actions.flatMap((action) => {
      if (action.kind === "merge_alias_row") return [String(action.sourceId), String(action.targetId)];
      return [String(action.id)];
    }),
  ).map(Number);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const rowMap = await loadRows(client, ids);
    const missingIds = ids.filter((id) => !rowMap.has(id));
    if (missingIds.length > 0) throw new Error(`Missing expected school rows: ${missingIds.join(", ")}`);

    const before = actions.map((action) => {
      if (action.kind === "merge_alias_row") {
        const source = rowMap.get(action.sourceId);
        const target = rowMap.get(action.targetId);
        return {
          ...action,
          source,
          target,
          sourceRefs: source ? refs(source) : null,
          targetRefs: target ? refs(target) : null,
          safeToDeleteSource: Boolean(source && refCount(source) === 0),
        };
      }

      const row = rowMap.get(action.id);
      return {
        ...action,
        row,
        refs: row ? refs(row) : null,
        safeToDelete: Boolean(row && refCount(row) === 0),
      };
    });

    writeFileSync(path.join(reportDir, "plan.json"), JSON.stringify({ apply, actions: before }, null, 2));

    if (!apply) {
      console.log(`Dry run only. Report: ${reportDir}`);
      return;
    }

    const backupTable = `schools_cleanup_backup_${stamp}`;
    await client.query("BEGIN");
    await client.query(`CREATE TABLE ${backupTable} AS TABLE schools`);

    const applied: Array<Record<string, unknown>> = [];

    for (const action of mergeActions) {
      const source = rowMap.get(action.sourceId);
      const target = rowMap.get(action.targetId);
      if (!source || !target) throw new Error(`Missing merge rows for ${action.sourceId} -> ${action.targetId}`);
      if (refCount(source) !== 0) throw new Error(`Refusing to delete referenced source row ${source.id}`);

      await updateTargetAliases(client, target, action, source);
      await client.query("DELETE FROM schools WHERE id = $1", [action.sourceId]);
      applied.push({ ...action, deletedSourceName: source.name, backupTable });
    }

    for (const action of deleteActions) {
      const row = rowMap.get(action.id);
      if (!row) throw new Error(`Missing delete row ${action.id}`);
      if (refCount(row) !== 0) throw new Error(`Refusing to delete referenced garbage row ${row.id}`);

      await client.query("DELETE FROM schools WHERE id = $1", [action.id]);
      applied.push({ ...action, deletedName: row.name, backupTable });
    }

    for (const action of districtActions) {
      const row = rowMap.get(action.id);
      if (!row) throw new Error(`Missing district row ${action.id}`);
      const attrs = attrsWithCleanup(row.attrs, {
        kind: action.kind,
        previous_district: row.district,
        new_district: action.toDistrict,
        reason: action.reason,
        detected_at: detectedAt,
      });

      await client.query(
        `UPDATE schools
         SET district = $1,
             attrs = $2::jsonb,
             updated_at = now()
         WHERE id = $3`,
        [action.toDistrict, JSON.stringify(attrs), action.id],
      );
      applied.push({ ...action, fromDistrict: row.district, name: row.name });
    }

    for (const action of issueActions) {
      const row = rowMap.get(action.id);
      if (!row) throw new Error(`Missing issue row ${action.id}`);
      const attrs = attrsWithIssue(row.attrs, {
        kind: action.issueKind,
        review_status: action.reviewStatus,
        reason: action.reason,
        detected_at: detectedAt,
        refs: refs(row),
      });

      await client.query(
        `UPDATE schools
         SET attrs = $1::jsonb,
             updated_at = now()
         WHERE id = $2`,
        [JSON.stringify(attrs), action.id],
      );
      applied.push({ ...action, name: row.name });
    }

    await client.query("COMMIT");
    writeFileSync(path.join(reportDir, "applied.json"), JSON.stringify({ backupTable, applied }, null, 2));
    console.log(`Applied ${applied.length} actions. Backup: ${backupTable}. Report: ${reportDir}`);
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
