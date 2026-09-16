// Phase B：数据库收敛迁移。
// 步骤顺序见 design.md D2。每步独立事务，失败即停；--from/--to 可分段执行；
// 干跑（默认）只打印将执行的 SQL，--apply 才真正执行；每步执行后立即写入 rollback.sql。
// 用法：DATABASE_URL=... npx tsx scripts/migration/converge.ts [--apply] [--from=B1] [--to=B10]
import pg from "pg";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROLLBACK = path.resolve("data/migrations/2026-09-14-converge/rollback.sql");
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fromStep = (args.find((a) => a.startsWith("--from="))?.slice(7) ?? "B1").toUpperCase();
const toStep = (args.find((a) => a.startsWith("--to="))?.slice(5) ?? "B11").toUpperCase();

type Step = {
  id: string;
  name: string;
  run: (c: pg.Client) => Promise<string[]>; // 返回 rollback SQL 语句数组
};

const steps: Step[] = [
  {
    id: "B1",
    name: "加 release_batch_id 列（relations + school_communities）",
    run: async (c) => {
      await c.query(`ALTER TABLE catalog.school_district_relations ADD COLUMN IF NOT EXISTS release_batch_id bigint`);
      await c.query(`ALTER TABLE public.school_communities ADD COLUMN IF NOT EXISTS release_batch_id bigint`);
      return [
        `ALTER TABLE catalog.school_district_relations DROP COLUMN IF EXISTS release_batch_id;`,
        `ALTER TABLE public.school_communities DROP COLUMN IF EXISTS release_batch_id;`,
      ];
    },
  },
  {
    id: "B2",
    name: "school_communities 去重（官方/学区助手优先、年份降序）",
    run: async (c) => {
      // 去重前导出将被删除的行到 CSV 快照（数据已在 Phase A 全量快照，这里再做一次精确快照兜底）
      const doomed = await c.query(`
        select sc.* from public.school_communities sc
        where sc.id not in (
          select distinct on (school_id, community_id) id
          from public.school_communities
          order by school_id, community_id,
            case when source_name like 'official%' or source_name like 'xuequzhushou%' then 0 else 1 end,
            year desc nulls last, id
        )
        order by sc.id
      `);
      const before = Number((await c.query(`select count(*) c from public.school_communities`)).rows[0].c);
      const del = await c.query(`
        delete from public.school_communities sc
        using (
          select id, row_number() over (partition by school_id, community_id order by
            case when source_name like 'official%' or source_name like 'xuequzhushou%' then 0 else 1 end,
            year desc nulls last, id) rn
          from public.school_communities
        ) d
        where sc.id = d.id and d.rn > 1
      `);
      const after = Number((await c.query(`select count(*) c from public.school_communities`)).rows[0].c);
      console.log(`  B2: ${before} → ${after}（删除 ${before - after} 行，预期 3,479）`);
      if (before - after !== del.rowCount) throw new Error("B2 delete count mismatch");
      // 精确快照兜底（被删行可恢复）
      const esc = (v: unknown) => {
        if (v === null || v === undefined) return "";
        const s = typeof v === "object" ? JSON.stringify(v) : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = [
        doomed.fields.map((f) => f.name).join(","),
        ...doomed.rows.map((r) => doomed.fields.map((f) => esc(r[f.name])).join(",")),
      ].join("\n");
      writeFileSync("data/migrations/2026-09-14-converge/deleted-school_communities-dedup.csv", csv);
      return [
        `-- B2 回滚：从 data/migrations/2026-09-14-converge/deleted-school_communities-dedup.csv 恢复被删行`,
        `-- psql: \\copy public.school_communities FROM 'deleted-school_communities-dedup.csv' CSV HEADER`,
      ];
    },
  },
  {
    id: "B3",
    name: "school_communities 补 (school_id, community_id) 唯一索引",
    run: async (c) => {
      const dup = Number(
        (await c.query(`select count(*) c from (select school_id,community_id from public.school_communities group by 1,2 having count(*)>1) t`)).rows[0].c,
      );
      if (dup > 0 && APPLY) throw new Error(`B3 前置失败：仍有 ${dup} 个重复对（B2 未生效？）`);
      if (dup > 0) {
        console.log(`  B3: dry-run 下 B2 已回滚，仍有 ${dup} 重复对，跳过建索引`);
        return [`DROP INDEX IF EXISTS public.uq_school_communities_pair;`];
      }
      await c.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_school_communities_pair ON public.school_communities(school_id, community_id)`);
      return [`DROP INDEX IF EXISTS public.uq_school_communities_pair;`];
    },
  },
  {
    id: "B4",
    name: "relations 改名 + 兼容视图",
    run: async (c) => {
      const hasTable = (await c.query(`select to_regclass('catalog.relations') t`)).rows[0].t;
      const hasOld = (await c.query(`select to_regclass('catalog.school_district_relations') t`)).rows[0].t;
      if (hasTable && hasOld) throw new Error("B4 异常：relations 与 school_district_relations 同时存在");
      if (!hasTable && hasOld) {
        await c.query(`ALTER TABLE catalog.school_district_relations RENAME TO relations`);
      }
      await c.query(`CREATE OR REPLACE VIEW catalog.school_district_relations AS SELECT * FROM catalog.relations`);
      return [
        `DROP VIEW IF EXISTS catalog.school_district_relations;`,
        `-- 若需还原表名：ALTER TABLE catalog.relations RENAME TO school_district_relations;`,
      ];
    },
  },
  {
    id: "B5",
    name: "audit → catalog 迁表（entity_match_candidates / field_conflicts / release_batches）",
    run: async (c) => {
      for (const t of ["entity_match_candidates", "field_conflicts", "release_batches"]) {
        const inAudit = (await c.query(`select to_regclass('audit.${t}') r`)).rows[0].r;
        const inCatalog = (await c.query(`select to_regclass('catalog.${t}') r`)).rows[0].r;
        if (inAudit && !inCatalog) await c.query(`ALTER TABLE audit.${t} SET SCHEMA catalog`);
        else if (!inAudit && inCatalog) console.log(`  B5: ${t} 已在 catalog`);
        else if (inAudit && inCatalog) throw new Error(`B5 异常：${t} 两处都存在`);
        else console.log(`  B5: ${t} 不存在（跳过）`);
      }
      return [
        `ALTER TABLE catalog.entity_match_candidates SET SCHEMA audit;`,
        `ALTER TABLE catalog.field_conflicts SET SCHEMA audit;`,
        `ALTER TABLE catalog.release_batches SET SCHEMA audit;`,
      ];
    },
  },
  {
    id: "B6",
    name: "官方候选池迁入 catalog.candidates",
    run: async (c) => {
      const inPublic = (await c.query(`select to_regclass('public.school_community_candidates') r`)).rows[0].r;
      const inCatalog = (await c.query(`select to_regclass('catalog.candidates') r`)).rows[0].r;
      if (inPublic && !inCatalog) {
        await c.query(`ALTER TABLE public.school_community_candidates SET SCHEMA catalog`);
        await c.query(`ALTER TABLE catalog.school_community_candidates RENAME TO candidates`);
      } else if (!inPublic && inCatalog) console.log("  B6: 已在 catalog.candidates");
      else throw new Error("B6 异常状态");
      return [
        `ALTER TABLE catalog.candidates SET SCHEMA public;`,
        `ALTER TABLE public.candidates RENAME TO school_community_candidates;`,
      ];
    },
  },
  {
    id: "B7",
    name: "policies 收敛（回填 reviewedAt 后 DROP public.policies）",
    run: async (c) => {
      // 前置：relations.attrs 补 reviewedAt（来自 audit 表，必须在 B9 删表前做）
      // 动态解析表名：apply 模式下 B4 已提交（catalog.relations）；dry-run 下 B4 回滚（原名 school_district_relations）
      const relTable = (await c.query(`select to_regclass('catalog.relations') r`)).rows[0].r
        ? "catalog.relations"
        : "catalog.school_district_relations";
      await c.query(`
        UPDATE ${relTable} r
        SET attrs = r.attrs || jsonb_build_object('reviewedAt', a.reviewed_at)
        FROM audit.school_community_relation_candidates a
        WHERE r.source_record_id = a.source_record_id
          AND a.reviewed_at IS NOT NULL
          AND r.attrs->>'reviewedAt' IS NULL
      `);
      const cnt = Number((await c.query(`select count(*) c from ${relTable} where attrs ? 'reviewedAt'`)).rows[0].c);
      console.log(`  B7: relations.attrs.reviewedAt 回填至 ${cnt} 行（表 ${relTable}）`);
      await c.query(`DROP TABLE IF EXISTS public.policies`);
      return [`-- B7 回滚：public.policies 已从快照 data-public_policies.csv 恢复（\\copy public.policies FROM ... CSV HEADER，需先建表见 schema-before.txt）`];
    },
  },
  {
    id: "B8",
    name: "DROP catalog.school_community_assignments（diff 已确认，留档 CSV）",
    run: async (c) => {
      const exists = (await c.query(`select to_regclass('catalog.school_community_assignments') r`)).rows[0].r;
      if (!exists) {
        console.log("  B8: 表已不存在（跳过）");
        return [`-- B8 表已删；如需恢复从快照 data-catalog_school_community_assignments.csv 重建（DDL 见 schema-before.txt）`];
      }
      const cnt = Number((await c.query(`select count(*) c from catalog.school_community_assignments`)).rows[0].c);
      if (cnt !== 36996) throw new Error(`B8 前置失败：assignments 行数 ${cnt} ≠ 基线 36,996`);
      await c.query(`DROP TABLE catalog.school_community_assignments`);
      console.log(`  B8: 已删除 assignments（${cnt} 行，CSV 留档）`);
      return [`-- B8 回滚：从快照 data-catalog_school_community_assignments.csv 恢复（DDL 见 schema-before.txt）`];
    },
  },
  {
    id: "B9",
    name: "audit 收尾：删 relation_candidates + 兼容视图 + DROP SCHEMA audit",
    run: async (c) => {
      const relCand = (await c.query(`select to_regclass('audit.school_community_relation_candidates') r`)).rows[0].r;
      if (relCand) {
        const cnt = Number((await c.query(`select count(*) c from audit.school_community_relation_candidates`)).rows[0].c);
        if (cnt !== 2764) throw new Error(`B9 前置失败：relation_candidates ${cnt} ≠ 2,764`);
        await c.query(`DROP TABLE audit.school_community_relation_candidates`);
      }
      // 兼容视图删除：dry-run 下 B4 已回滚（视图不存在），用 DO 块容错
      await c.query(`
        DO $$ BEGIN
          IF EXISTS (select 1 from pg_views where schemaname='catalog' and viewname='school_district_relations') THEN
            EXECUTE 'DROP VIEW catalog.school_district_relations';
          END IF;
        END $$
      `);
      const remaining = await c.query(`select tablename from pg_tables where schemaname='audit'`);
      if (remaining.rowCount === 0) {
        await c.query(`DROP SCHEMA IF EXISTS audit`);
        console.log("  B9: audit schema 已删除");
      } else {
        console.log(`  B9: audit schema 仍有表：${remaining.rows.map((r) => r.tablename).join(", ")}（保留）`);
      }
      return [
        `-- B9 回滚：从快照 data-audit_school_community_relation_candidates.csv 恢复（DDL 见 schema-before.txt），并 CREATE SCHEMA audit;`,
        `-- 兼容视图：CREATE VIEW catalog.school_district_relations AS SELECT * FROM catalog.relations;`,
      ];
    },
  },
  {
    id: "B10",
    name: "删垃圾：44 张 backup 表 + school_ratings",
    run: async (c) => {
      const backups = await c.query(
        `select tablename from pg_tables where schemaname='public' and tablename like '%\\_backup\\_%' escape '\\'`,
      );
      for (const { tablename } of backups.rows) {
        await c.query(`DROP TABLE public.${JSON.stringify(tablename)}`);
      }
      const ratings = (await c.query(`select to_regclass('catalog.school_ratings') r`)).rows[0].r;
      if (ratings) {
        const cnt = Number((await c.query(`select count(*) c from catalog.school_ratings`)).rows[0].c);
        if (cnt !== 0) throw new Error(`B10 前置失败：school_ratings 有 ${cnt} 行，非空不能删`);
        await c.query(`DROP TABLE catalog.school_ratings`);
      }
      console.log(`  B10: 删除 ${backups.rowCount} 张 backup 表${ratings ? " + school_ratings" : ""}`);
      return [`-- B10 回滚：backup 表与 school_ratings 均为 0 行，DDL 见 schema-before.txt（无需数据恢复）`];
    },
  },
  {
    id: "B11",
    name: "迁移后对账",
    run: async (c) => {
      const expected: Record<string, number> = {
        "catalog.relations": 3446,
        "public.school_communities": 39402,
        "catalog.source_schools": 455,
        "catalog.schools": 2044,
        "catalog.communities": 30638,
        "catalog.policy_documents": 832,
        "catalog.official_enrollment_areas": 23070, // 原 catalog.candidates，2026-09-14 改名
        "catalog.entity_match_candidates": 455,
        "catalog.field_conflicts": 130,
        "catalog.release_batches": 0,
        "public.schools": 2028,
        "public.communities": 31399,
        "public.web_data_source": 3961,
        "public.district_boundaries": 211,
        "public.community_price_snapshots": 31,
        "public.community_price_sources": 37,
        "ingest.sources": 2,
        "ingest.crawl_runs": 810,
        "ingest.extracted_records": 38438,
      };
      const results: string[] = [];
      for (const [table, want] of Object.entries(expected)) {
        const [schema, name] = table.split(".");
        const exists = (await c.query(`select to_regclass($1) r`, [table])).rows[0].r;
        if (!exists) {
          results.push(`✗ ${table} 不存在`);
          continue;
        }
        const got = Number((await c.query(`select count(*) c from ${schema}.${JSON.stringify(name)}`)).rows[0].c);
        results.push(`${got === want ? "✓" : "✗"} ${table}: ${got}${got === want ? "" : ` (预期 ${want})`}`);
      }
      console.log(results.map((r) => `  ${r}`).join("\n"));
      if (results.some((r) => r.startsWith("✗"))) throw new Error("B11 对账失败");
      return [];
    },
  },
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const c = new pg.Client(url);
  await c.connect();
  const stepNum = (id: string) => Number(id.slice(1));
const selected = steps.filter((s) => stepNum(s.id) >= stepNum(fromStep) && stepNum(s.id) <= stepNum(toStep));
  console.log(`模式: ${APPLY ? "APPLY" : "DRY-RUN"} · 步骤: ${selected.map((s) => s.id).join(" ")}`);
  if (APPLY) writeFileSync(ROLLBACK, "-- 回滚脚本（迁移失败时按序执行）\n-- 生成于 " + new Date().toISOString() + "\n");
  for (const step of selected) {
    console.log(`\n[${step.id}] ${step.name}`);
    try {
      await c.query("BEGIN");
      const rollbackSql = await step.run(c);
      if (APPLY) {
        await c.query("COMMIT");
        appendFileSync(ROLLBACK, `\n-- === ${step.id}: ${step.name} ===\n${rollbackSql.join("\n")}\n`);
        console.log(`  ✓ 已提交`);
      } else {
        await c.query("ROLLBACK");
        console.log(`  (dry-run 已回滚)`);
      }
    } catch (err) {
      await c.query("ROLLBACK").catch(() => {});
      console.error(`  ✗ 失败: ${(err as Error).message}`);
      process.exitCode = 1;
      break;
    }
  }
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
