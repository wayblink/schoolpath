/**
 * Normalize obviously broken school names in PostgreSQL.
 *
 * Safety:
 * - dry-run by default; pass --apply to commit
 * - writes before/plan/manual/applied reports under .tmp/normalize-school-names/
 * - creates a backup table before applying changes
 * - deletes only zero-reference rows that are known parser garbage
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
const reportDir = path.join(process.cwd(), ".tmp", "normalize-school-names", stamp);

type Row = {
  id: number;
  name: string;
  district: string;
  type: string;
  address: string | null;
  attrs: Record<string, unknown> | null;
  data_source: string | null;
  matched_name: string | null;
  school_communities: string | number;
  district_boundaries: string | number;
  policies: string | number;
  school_info: string | number;
};

type RenameAction = {
  kind: "rename";
  id: number;
  district: string;
  type: string;
  from: string;
  to: string;
  reason: string;
  source: string | null;
};

type DeleteAction = {
  kind: "delete";
  id: number;
  district: string;
  type: string;
  name: string;
  reason: string;
  duplicateOf?: number;
};

type ManualReview = {
  id: number;
  district: string;
  type: string;
  name: string;
  matchedName?: string | null;
  reason: string;
  refs: {
    schoolCommunities: number;
    districtBoundaries: number;
    policies: number;
    schoolInfo: number;
  };
  source: string | null;
};

type Action = RenameAction | DeleteAction;

const TRUSTED_MATCHED_NAME_IDS = new Set([
  3507, 3512, 3524, 3591, 3809, 3874, 3882, 3921,
  3951, 3958, 3985, 3986, 3996, 3999, 4001, 4004, 4010, 4011, 4018, 4019, 4021,
  4093, 4099, 4110, 4114, 4123, 4124, 4127, 4129, 4131,
  4144, 4149, 4150, 4153, 4155, 4156, 4159,
  4275, 4284, 4285, 4292, 4298, 4299,
]);

const MANUAL_ONLY_IDS = new Set([4195, 4227, 4233, 4303, 5357, 5387, 5540]);

function refCount(row: Row): number {
  return (
    Number(row.school_communities) +
    Number(row.district_boundaries) +
    Number(row.policies) +
    Number(row.school_info)
  );
}

function refs(row: Row): ManualReview["refs"] {
  return {
    schoolCommunities: Number(row.school_communities),
    districtBoundaries: Number(row.district_boundaries),
    policies: Number(row.policies),
    schoolInfo: Number(row.school_info),
  };
}

function compactName(name: string): string {
  return name
    .replace(/[ \t\r\n　]+/g, "")
    .replace(/\(/g, "（")
    .replace(/\)/g, "）")
    .replace(/：/g, ":")
    .trim();
}

function looksLikeNonSchoolName(name: string): boolean {
  return (
    /^初中学区[:：]/.test(name) ||
    /^小学学区[:：]/.test(name) ||
    /^公办[（(]/.test(name) ||
    /^民办[（(]/.test(name) ||
    /^第二梯队[:：]/.test(name)
  );
}

function hasUnbalancedParentheses(name: string): boolean {
  const left = (name.match(/（/g) ?? []).length;
  const right = (name.match(/）/g) ?? []).length;
  return left !== right;
}

function hasBareDepartmentSuffix(name: string): boolean {
  return /[ \t\r\n　]+(?:小学部|初中部)$/.test(name);
}

function shouldUseMatchedName(row: Row): boolean {
  if (!row.matched_name) return false;
  if (!TRUSTED_MATCHED_NAME_IDS.has(row.id)) return false;
  const current = compactName(row.name);
  const matched = compactName(row.matched_name);
  if (!matched || matched === current) return false;
  if (looksLikeNonSchoolName(matched)) return false;
  return true;
}

function manualReason(row: Row): string | null {
  if (MANUAL_ONLY_IDS.has(row.id)) {
    if (row.id === 4195) return "一行合并了两所学校，不能自动改成简称或单校名";
    if (row.id === 4227 || row.id === 4233) return "学校名字段是完整学区边界文本，且仍有 policy 引用";
    if (row.id === 4303) return "学校名字段是办学性质/学段标签，且仍有 policy 引用";
    return "xhs-flush 截断或简称，需要人工确认正式校名";
  }
  if (!shouldUseMatchedName(row) && hasBareDepartmentSuffix(row.name)) {
    return "校名末尾是未加括号的学段词，可能是学段/类型错位，跳过自动拼接";
  }
  if (!shouldUseMatchedName(row) && hasUnbalancedParentheses(compactName(row.name))) {
    return "校名括号不闭合，疑似截断的 xhs-flush 片段";
  }
  if (row.matched_name && compactName(row.name) !== compactName(row.matched_name) && !shouldUseMatchedName(row)) {
    return "official matched_name 与当前名不同，但看起来可能是简称或非同一层级，跳过自动覆盖";
  }
  if (looksLikeNonSchoolName(row.name)) return "疑似非学校名文本";
  return null;
}

async function main() {
  mkdirSync(reportDir, { recursive: true });

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const rows = (
      await client.query<Row>(
        `SELECT
           s.id,
           s.name,
           s.district,
           s.type::text,
           s.address,
           s.attrs,
           s.attrs->>'data_source' AS data_source,
           s.attrs#>>'{official_school_address_source,matched_name}' AS matched_name,
           COALESCE(sc.c, 0) AS school_communities,
           COALESCE(db.c, 0) AS district_boundaries,
           COALESCE(p.c, 0) AS policies,
           COALESCE(si.c, 0) AS school_info
         FROM schools s
         LEFT JOIN (SELECT school_id, count(*) c FROM school_communities GROUP BY school_id) sc ON sc.school_id = s.id
         LEFT JOIN (SELECT school_id, count(*) c FROM district_boundaries GROUP BY school_id) db ON db.school_id = s.id
         LEFT JOIN (SELECT school_id, count(*) c FROM policies GROUP BY school_id) p ON p.school_id = s.id
         LEFT JOIN (SELECT school_id, count(*) c FROM school_info GROUP BY school_id) si ON si.school_id = s.id
         ORDER BY s.id`,
      )
    ).rows;

    const byId = new Map(rows.map((row) => [row.id, row]));
    const byDistrictTypeCompact = new Map<string, Row[]>();
    for (const row of rows) {
      const key = `${row.district}\t${row.type}\t${compactName(row.name)}`;
      byDistrictTypeCompact.set(key, [...(byDistrictTypeCompact.get(key) ?? []), row]);
    }

    const actions: Action[] = [];
    const manualReview: ManualReview[] = [];

    for (const row of rows) {
      const reason = manualReason(row);
      if (reason) {
        manualReview.push({
          id: row.id,
          district: row.district,
          type: row.type,
          name: row.name,
          matchedName: row.matched_name,
          reason,
          refs: refs(row),
          source: row.data_source,
        });
        continue;
      }

      let to: string | null = null;
      let renameReason = "";
      if (shouldUseMatchedName(row)) {
        to = compactName(row.matched_name ?? "");
        renameReason = "official_school_address_source.matched_name 修正断字/简称/学段后缀";
      } else {
        const compact = compactName(row.name);
        if (compact !== row.name && !looksLikeNonSchoolName(compact)) {
          to = compact;
          renameReason = "清理导入/OCR 造成的校名空格与半角括号";
        }
      }

      if (to && to !== row.name) {
        actions.push({
          kind: "rename",
          id: row.id,
          district: row.district,
          type: row.type,
          from: row.name,
          to,
          reason: renameReason,
          source: row.data_source,
        });
      }
    }

    const noisyWuning = byId.get(5696);
    const properWuning = byDistrictTypeCompact
      .get(`普陀\tprimary\t武宁路小学`)
      ?.find((row) => row.id !== 5696);
    if (noisyWuning && properWuning && refCount(noisyWuning) === 0) {
      for (let i = actions.length - 1; i >= 0; i -= 1) {
        if (actions[i].kind === "rename" && actions[i].id === 5696) actions.splice(i, 1);
      }
      actions.push({
        kind: "delete",
        id: 5696,
        district: noisyWuning.district,
        type: noisyWuning.type,
        name: noisyWuning.name,
        reason: "xhs-flush 把梯队标签导入成学校名；同区同学段已有武宁路小学",
        duplicateOf: properWuning.id,
      });
    }

    for (const row of rows) {
      if (row.data_source !== "xhs-flush") continue;
      if (refCount(row) !== 0) continue;
      if (!hasUnbalancedParentheses(compactName(row.name))) continue;
      if (actions.some((action) => action.id === row.id)) continue;
      actions.push({
        kind: "delete",
        id: row.id,
        district: row.district,
        type: row.type,
        name: row.name,
        reason: "xhs-flush 导入的截断片段，括号不闭合且没有任何引用",
      });
    }

    const deletedIds = new Set(actions.filter((action) => action.kind === "delete").map((action) => action.id));
    for (let i = manualReview.length - 1; i >= 0; i -= 1) {
      if (deletedIds.has(manualReview[i].id)) manualReview.splice(i, 1);
    }

    const renames = actions.filter((action): action is RenameAction => action.kind === "rename");
    const deletes = actions.filter((action): action is DeleteAction => action.kind === "delete");
    const beforeRows = actions
      .map((action) => byId.get(action.id))
      .filter((row): row is Row => Boolean(row));

    writeFileSync(path.join(reportDir, "schools-before.json"), JSON.stringify(beforeRows, null, 2), "utf8");
    writeFileSync(path.join(reportDir, "plan.json"), JSON.stringify({ actions }, null, 2), "utf8");
    writeFileSync(path.join(reportDir, "manual-review.json"), JSON.stringify({ rows: manualReview }, null, 2), "utf8");

    console.log(`Mode: ${apply ? "APPLY (COMMIT)" : "dry-run (ROLLBACK)"}`);
    console.log(`Report dir: ${path.relative(process.cwd(), reportDir)}`);
    console.log(`Planned renames: ${renames.length}`);
    console.log(`Planned deletes: ${deletes.length}`);
    console.log(`Manual review rows: ${manualReview.length}`);
    console.log("\nSample renames:");
    for (const action of renames.slice(0, 16)) {
      console.log(`  [${action.id}] ${action.from} -> ${action.to}`);
    }
    if (deletes.length) {
      console.log("\nDeletes:");
      for (const action of deletes) {
        console.log(`  [${action.id}] ${action.name} (${action.reason})`);
      }
    }

    await client.query("BEGIN");
    const backupTableName = `schools_name_backup_${stamp}`;
    if (apply) {
      await client.query(
        `CREATE TABLE ${backupTableName} AS
         SELECT id, name, district, type, attrs, updated_at
         FROM schools`,
      );
    }

    const applied: Action[] = [];
    for (const action of actions) {
      if (action.kind === "rename") {
        await client.query("UPDATE schools SET name = $1, updated_at = now() WHERE id = $2", [
          action.to,
          action.id,
        ]);
      } else {
        const current = byId.get(action.id);
        if (!current || refCount(current) > 0) {
          throw new Error(`Refusing to delete school id=${action.id}; row has references.`);
        }
        await client.query("DELETE FROM schools WHERE id = $1", [action.id]);
      }
      applied.push(action);
    }

    if (apply) {
      await client.query("COMMIT");
      writeFileSync(
        path.join(reportDir, "applied.json"),
        JSON.stringify({ backupTableName, actions: applied }, null, 2),
        "utf8",
      );
      console.log(`\nCOMMITTED. Backup table: ${backupTableName}`);
    } else {
      await client.query("ROLLBACK");
      console.log("\nROLLED BACK. Re-run with --apply to commit.");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
