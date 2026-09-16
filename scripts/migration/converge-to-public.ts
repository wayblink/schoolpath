// catalog → public 全量归位迁移：业务需要的表全部迁入 public，catalog schema 仅保留归档（随后也迁 public 并 DROP SCHEMA）。
// 设计依据：用户指令"业务需要的 catalog 表全部迁 public"（2026-09-15），在 09-14-catalog-school-communities-converge 收敛基础上的终局收尾。
// 模式同 converge-school-communities.ts：逐步事务 + --apply/--from/--to + rollback.sql + 前置行数校验。
// 用法：DATABASE_URL=... npx tsx scripts/migration/converge-to-public.ts [--apply] [--from=P1] [--to=P10]
import pg from "pg";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RUN_DIR = path.resolve("data/migrations/2026-09-15-converge-to-public");
const ROLLBACK = path.join(RUN_DIR, "rollback.sql");
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fromStep = (args.find((a) => a.startsWith("--from="))?.slice(7) ?? "P1").toUpperCase();
const toStep = (args.find((a) => a.startsWith("--to="))?.slice(5) ?? "P10").toUpperCase();

type Step = {
  id: string;
  name: string;
  run: (c: pg.Client) => Promise<string[]>;
};

const esc = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (res: pg.QueryResult) =>
  [res.fields.map((f) => f.name).join(","), ...res.rows.map((r) => res.fields.map((f) => esc(r[f.name])).join(","))].join("\n");

const steps: Step[] = [
  {
    id: "P1",
    name: "删死表 school_aliases + school_feeder_relations（无生产者无消费者，FK→catalog.schools 解除）",
    run: async (c) => {
      const dead: Array<[string, string]> = [["catalog.school_aliases", "school-aliases"], ["catalog.school_feeder_relations", "school-feeder-relations"]];
      for (const [table, slug] of dead) {
        const [schema, name] = table.split(".");
        const exists = (await c.query(`select to_regclass($1) t`, [table])).rows[0].t;
        if (!exists) { console.log(`  P1: ${table} 已不存在（跳过）`); continue; }
        const cnt = Number((await c.query(`select count(*) c from ${schema}.${JSON.stringify(name)}`)).rows[0].c);
        const rows = await c.query(`select * from ${schema}.${JSON.stringify(name)} order by id`);
        if (APPLY) writeFileSync(path.join(RUN_DIR, `${slug}-before.csv`), toCsv(rows));
        await c.query(`DROP TABLE ${schema}.${JSON.stringify(name)}`);
        console.log(`  P1: ${table} ${cnt} 行已删（快照 ${slug}-before.csv）`);
      }
      return [`-- P1 回滚：从 school-aliases-before.csv / school-feeder-relations-before.csv 恢复（DDL 见 schema.ts 历史或 pg_dump 风格重建）`];
    },
  },
  {
    id: "P2",
    name: "无冲突 SET SCHEMA（districts/source_schools/entity_match_candidates/field_conflicts/release_batches → public）",
    run: async (c) => {
      for (const t of ["districts", "source_schools", "entity_match_candidates", "field_conflicts", "release_batches"]) {
        const inCatalog = (await c.query(`select to_regclass($1) r`, [`catalog.${t}`])).rows[0].r;
        const inPublic = (await c.query(`select to_regclass($1) r`, [`public.${t}`])).rows[0].r;
        if (inCatalog && !inPublic) {
          await c.query(`ALTER TABLE catalog.${JSON.stringify(t)} SET SCHEMA public`);
          console.log(`  P2: catalog.${t} → public.${t}`);
        } else if (!inCatalog && inPublic) console.log(`  P2: ${t} 已在 public`);
        else throw new Error(`P2 异常：${t} 两处都存在或都不存在`);
      }
      return [
        ...["districts", "source_schools", "entity_match_candidates", "field_conflicts", "release_batches"].map(
          (t) => `ALTER TABLE public.${t} SET SCHEMA catalog;`,
        ),
      ];
    },
  },
  {
    id: "P3",
    name: "待审池迁 public：school_communities → rename pending_school_communities → SET SCHEMA public",
    run: async (c) => {
      const exists = (await c.query(`select to_regclass('catalog.school_communities') t`)).rows[0].t;
      if (!exists) throw new Error("P3 前置失败：catalog.school_communities 不存在");
      const inPublic = (await c.query(`select to_regclass('public.pending_school_communities') t`)).rows[0].t;
      if (inPublic) throw new Error("P3 前置失败：public.pending_school_communities 已存在");
      const n = Number((await c.query(`select count(*) c from catalog.school_communities`)).rows[0].c);
      if (n !== 16807) throw new Error(`P3 前置失败：行数 ${n} ≠ 16,807（accepted 2,764 + published 14,043）`);
      // 约束/索引先加前缀避免与 public.school_communities 同名（SET SCHEMA 不自动重命名约束）
      for (const [oldName, newName] of [
        ["school_communities_pkey", "pending_school_communities_pkey"],
        ["school_communities_school_id_fkey", "pending_school_communities_school_id_fkey"],
        ["school_communities_community_id_fkey", "pending_school_communities_community_id_fkey"],
        ["uq_catalog_school_communities_pair", "uq_pending_school_communities_pair"],
      ]) {
        const isConstraint = (await c.query(`select conname from pg_constraint where conrelid='catalog.school_communities'::regclass and conname=$1`, [oldName])).rowCount !== 0 && (await c.query(`select conname from pg_constraint where conrelid='catalog.school_communities'::regclass and conname=$1`, [oldName])).rowCount !== null;
        await c.query(
          isConstraint
            ? `ALTER TABLE catalog.school_communities RENAME CONSTRAINT ${JSON.stringify(oldName)} TO ${JSON.stringify(newName)}`
            : `ALTER INDEX catalog.${JSON.stringify(oldName)} RENAME TO ${JSON.stringify(newName)}`,
        );
      }
      await c.query(`ALTER TABLE catalog.school_communities RENAME TO pending_school_communities`);
      // serial 序列名随表迁移需手动 rename（school_communities_id_seq 与 public 同名序列撞名）
      const seq = (await c.query(`select to_regclass('catalog.school_communities_id_seq') r`)).rows[0].r;
      if (seq) await c.query(`ALTER SEQUENCE catalog.school_communities_id_seq RENAME TO pending_school_communities_id_seq`);
      await c.query(`ALTER TABLE catalog.pending_school_communities SET SCHEMA public`);
      console.log(`  P3: ${n} 行 → public.pending_school_communities（约束与序列已加前缀）`);
      return [
        `ALTER TABLE public.pending_school_communities SET SCHEMA catalog;`,
        `ALTER TABLE catalog.pending_school_communities RENAME TO school_communities;`,
        `ALTER TABLE catalog.school_communities RENAME CONSTRAINT pending_school_communities_pkey TO school_communities_pkey;`,
        `ALTER TABLE catalog.school_communities RENAME CONSTRAINT pending_school_communities_school_id_fkey TO school_communities_school_id_fkey;`,
        `ALTER TABLE catalog.school_communities RENAME CONSTRAINT pending_school_communities_community_id_fkey TO school_communities_community_id_fkey;`,
        `ALTER INDEX catalog.uq_pending_school_communities_pair RENAME TO uq_catalog_school_communities_pair;`,
        `ALTER SEQUENCE catalog.pending_school_communities_id_seq RENAME TO school_communities_id_seq;`,
      ];
    },
  },
  {
    id: "P4",
    name: "产品补全：catalog.schools 未映射 16 行插入 public.schools（canonical_name/district_id 列映射）",
    run: async (c) => {
      const unmapped = Number(
        (await c.query(`select count(*) c from catalog.schools cs left join public.schools ps on ps.id=cs.legacy_id where ps.id is null`)).rows[0].c,
      );
      if (unmapped !== 16) throw new Error(`P4 前置失败：未映射 ${unmapped} ≠ 16`);
      const rows = await c.query(`
        select cs.id, cs.legacy_id, cs.canonical_name, d.canonical_name district, cs.school_type::text,
          cs.school_nature::text, cs.tier::text, cs.address, cs.lat, cs.lng, cs.enrollment_note, cs.pit_risk_level::text, cs.attrs
        from catalog.schools cs
        join public.districts d on d.id = cs.district_id
        left join public.schools ps on ps.id=cs.legacy_id
        where ps.id is null order by cs.id`);
      if (APPLY) writeFileSync(path.join(RUN_DIR, "schools-unmapped-inserted.csv"), toCsv(rows));
      const ins = await c.query(`
        INSERT INTO public.schools(name, district, type, school_nature, tier, address, lat, lng, enrollment_note, pit_risk_level, attrs, source_name)
        SELECT cs.canonical_name, d.canonical_name, cs.school_type::public.school_type, cs.school_nature::public.school_nature, cs.tier::text,
          cs.address, cs.lat, cs.lng, cs.enrollment_note, cs.pit_risk_level::public.pit_risk_level, cs.attrs, 'catalog_migration'
        FROM catalog.schools cs
        join public.districts d on d.id = cs.district_id
        LEFT JOIN public.schools ps ON ps.id = cs.legacy_id
        WHERE ps.id IS NULL`);
      console.log(`  P4: 插入 ${ins.rowCount} 所学校（预期 16）`);
      if (ins.rowCount !== 16) throw new Error("P4 行数不符");
      return [`-- P4 回滚：删除 source_name='catalog_migration' 的产品学校行（DELETE FROM public.schools WHERE source_name='catalog_migration'；插入明细见 schools-unmapped-inserted.csv）`];
    },
  },
  {
    id: "P5",
    name: "产品补全：catalog.communities 未映射 127 行插入 public.communities",
    run: async (c) => {
      const unmapped = Number(
        (await c.query(`select count(*) c from catalog.communities cc left join public.communities pc on pc.id=cc.legacy_id where pc.id is null`)).rows[0].c,
      );
      if (unmapped !== 127) throw new Error(`P5 前置失败：未映射 ${unmapped} ≠ 127`);
      const rows = await c.query(`
        select cc.id, cc.name, d.canonical_name district, cc.lng, cc.lat, cc.address, cc.committee_name, cc.attrs
        from catalog.communities cc
        join public.districts d on d.id = cc.district_id
        left join public.communities pc on pc.id=cc.legacy_id
        where pc.id is null order by cc.id`);
      if (APPLY) writeFileSync(path.join(RUN_DIR, "communities-unmapped-inserted.csv"), toCsv(rows));
      const ins = await c.query(`
        INSERT INTO public.communities(name, district, lng, lat, source_committee, attrs, source_name, source_date, verified)
        SELECT cc.name, d.canonical_name, cc.lng, cc.lat, cc.committee_name, cc.attrs, 'catalog_migration', '2026-09-15', false
        FROM catalog.communities cc
        join public.districts d on d.id = cc.district_id
        LEFT JOIN public.communities pc ON pc.id = cc.legacy_id
        WHERE pc.id IS NULL`);
      console.log(`  P5: 插入 ${ins.rowCount} 个小区（预期 127）`);
      if (ins.rowCount !== 127) throw new Error("P5 行数不符");
      return [`-- P5 回滚：DELETE FROM public.communities WHERE source_name='catalog_migration'（明细见 communities-unmapped-inserted.csv）`];
    },
  },
  {
    id: "P6",
    name: "来源空间归档：catalog.schools/communities → rename _archived → SET SCHEMA public（FK 自动跟随）",
    run: async (c) => {
      for (const t of ["schools", "communities"]) {
        const inCatalog = (await c.query(`select to_regclass($1) r`, [`catalog.${t}`])).rows[0].r;
        if (!inCatalog) throw new Error(`P6 前置失败：catalog.${t} 不存在`);
        const inPublic = (await c.query(`select to_regclass($1) r`, [`public.${t}_archived`])).rows[0].r;
        if (inPublic) throw new Error(`P6 前置失败：public.${t}_archived 已存在`);
        // 所有约束/索引先加 _archived 后缀（SET SCHEMA 不自动重命名，会与 public 同名约束撞名）
        const constraints = (await c.query(
          `select conname from pg_constraint where conrelid = $1::regclass order by conname`,
          [`catalog.${t}`],
        )).rows.map((r) => String(r.conname));
        for (const con of constraints) {
          await c.query(`ALTER TABLE catalog.${JSON.stringify(t)} RENAME CONSTRAINT ${JSON.stringify(con)} TO ${JSON.stringify(con + "_archived")}`);
        }
        const indexes = (await c.query(
          `select indexname from pg_indexes where schemaname='catalog' and tablename=$1`,
          [t],
        )).rows.map((r) => String(r.indexname));
        for (const idx of indexes) {
          await c.query(`ALTER INDEX catalog.${JSON.stringify(idx)} RENAME TO ${JSON.stringify(idx + "_archived")}`);
        }
        // serial 序列先 rename 避免与 public 同名序列撞名
        const seq = (await c.query(`select to_regclass($1) r`, [`catalog.${t}_id_seq`])).rows[0].r;
        if (seq) await c.query(`ALTER SEQUENCE catalog.${JSON.stringify(t + "_id_seq")} RENAME TO ${JSON.stringify(t + "_archived_id_seq")}`);
        await c.query(`ALTER TABLE catalog.${JSON.stringify(t)} RENAME TO ${JSON.stringify(t + "_archived")}`);
        await c.query(`ALTER TABLE catalog.${JSON.stringify(t + "_archived")} SET SCHEMA public`);
        console.log(`  P6: catalog.${t} → public.${t}_archived（约束/索引/序列已加后缀）`);
      }
      return [
        `ALTER SEQUENCE public.schools_archived_id_seq RENAME TO schools_id_seq;`,
        `ALTER TABLE public.schools_archived SET SCHEMA catalog; ALTER TABLE catalog.schools_archived RENAME TO schools;`,
        `ALTER SEQUENCE public.communities_archived_id_seq RENAME TO communities_id_seq;`,
        `ALTER TABLE public.communities_archived SET SCHEMA catalog; ALTER TABLE catalog.communities_archived RENAME TO communities;`,
        `-- 约束/索引回滚：_archived 后缀按 P6 清单逐一反向 rename（约束名见 migration 日志）`,
      ];
    },
  },
  {
    id: "P7",
    name: "policy FK 重指：school_id 值经 legacy_id 转换到 public.schools，drop+add FK",
    run: async (c) => {
      const stats = (await c.query(`
        select count(*)::int total,
          count(*) filter (where pd.school_id is not null and ps.id is not null)::int convertible,
          count(*) filter (where pd.school_id is null)::int null_school
        from public.policy_documents pd
        left join public.schools_archived cs on cs.id=pd.school_id
        left join public.schools ps on ps.id=cs.legacy_id`)).rows[0];
      console.log(`  P7: policy school_id ${stats.total} 行（可转换 ${stats.convertible} · null ${stats.null_school}）`);
      if (stats.total !== stats.convertible + stats.null_school) throw new Error("P7 前置失败：存在不可转换 school_id");
      // 转换前全量快照（policy_documents 832 行小表，school_id 值回退依据）
      const rows = await c.query(`select id, school_id, district_id from public.policy_documents order by id`);
      if (APPLY) writeFileSync(path.join(RUN_DIR, "policy-documents-school-ids-before.csv"), toCsv(rows));
      await c.query(`ALTER TABLE public.policy_documents DROP CONSTRAINT IF EXISTS policy_documents_school_id_fkey`);
      const upd = await c.query(`
        UPDATE public.policy_documents pd
        SET school_id = ps.id
        FROM public.schools_archived cs
        JOIN public.schools ps ON ps.id = cs.legacy_id
        WHERE pd.school_id = cs.id`);
      await c.query(`ALTER TABLE public.policy_documents
        ADD CONSTRAINT policy_documents_school_id_fkey FOREIGN KEY (school_id) REFERENCES public.schools(id)`);
      console.log(`  P7: school_id 转换 ${upd.rowCount} 行，FK 已重指 public.schools`);
      return [
        `-- P7 回滚：school_id 值回转为归档表 id 空间（需从 schools-unmapped 之前的快照推算；district_id FK 已自动跟随 P2，无需处理）`,
      ];
    },
  },
  {
    id: "P8",
    name: "归档×2 迁 public + DROP SCHEMA catalog（应为空 schema）",
    run: async (c) => {
      for (const t of ["official_enrollment_areas_archived", "relations_archived"]) {
        const inCatalog = (await c.query(`select to_regclass($1) r`, [`catalog.${t}`])).rows[0].r;
        if (!inCatalog) { console.log(`  P8: catalog.${t} 已不在（跳过）`); continue; }
        await c.query(`ALTER TABLE catalog.${JSON.stringify(t)} SET SCHEMA public`);
        console.log(`  P8: catalog.${t} → public.${t}`);
      }
      const remaining = (await c.query(`select tablename from pg_tables where schemaname='catalog'`)).rows.map((r) => r.tablename);
      if (remaining.length > 0) throw new Error(`P8 前置失败：catalog 仍有表 ${remaining.join(", ")}`);
      await c.query(`DROP SCHEMA IF EXISTS catalog`);
      console.log("  P8: DROP SCHEMA catalog 完成");
      return [`CREATE SCHEMA catalog;`, `ALTER TABLE public.official_enrollment_areas_archived SET SCHEMA catalog;`, `ALTER TABLE public.relations_archived SET SCHEMA catalog;`];
    },
  },
  {
    id: "P9",
    name: "迁移后对账（public 表清单 + FK 完整性 + 行数基线）",
    run: async (c) => {
      const expected: Record<string, number> = {
        "public.pending_school_communities": 16807,
        "public.schools": 2044, // 2,028 + 16 补全
        "public.communities": 31399, // 31,272 + 127 补全
        "public.districts": 16,
        "public.source_schools": 455,
        "public.entity_match_candidates": 455,
        "public.field_conflicts": 130,
        "public.release_batches": 0,
        "public.policy_documents": 832,
        "public.school_communities": 39384,
      };
      const results: string[] = [];
      for (const [table, want] of Object.entries(expected)) {
        const [schema, name] = table.split(".");
        const exists = (await c.query(`select to_regclass($1) r`, [table])).rows[0].r;
        if (!exists) { results.push(`✗ ${table} 不存在`); continue; }
        const got = Number((await c.query(`select count(*) c from ${schema}.${JSON.stringify(name)}`)).rows[0].c);
        results.push(`${got === want ? "✓" : "✗"} ${table}: ${got}${got === want ? "" : ` (预期 ${want})`}`);
      }
      const badFk = Number(
        (await c.query(`
          select count(*) c from (
            select sc.id from public.pending_school_communities sc left join public.communities p on p.id=sc.community_id where sc.community_id is not null and p.id is null
            union all
            select pd.id from public.policy_documents pd left join public.schools s on s.id=pd.school_id where pd.school_id is not null and s.id is null
            union all
            select pd.id from public.policy_documents pd left join public.districts d on d.id=pd.district_id where pd.district_id is not null and d.id is null
          ) t`,
        )).rows[0].c,
      );
      results.push(`· FK 失效 ${badFk} 行（预期 0）`);
      console.log(results.map((r) => `  ${r}`).join("\n"));
      if (results.some((r) => r.startsWith("✗")) || badFk !== 0) throw new Error("P9 对账失败");
      return [];
    },
  },
  {
    id: "P10",
    name: "终对账：catalog schema 已消失 + 归档在 public",
    run: async (c) => {
      const catalogTables = (await c.query(`select tablename from pg_tables where schemaname='catalog'`)).rowCount;
      const archives = (await c.query(`select to_regclass('public.official_enrollment_areas_archived') a, to_regclass('public.relations_archived') b`)).rows[0];
      console.log(`  P10: catalog schema 表数 ${catalogTables}（预期 0）· 归档 ${archives.a && archives.b ? "✓ 在 public" : "✗ 缺失"}`);
      if (catalogTables !== 0 || !archives.a || !archives.b) throw new Error("P10 终对账失败");
      return [];
    },
  },
];

const stepNum = (id: string) => Number(id.slice(1));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const c = new pg.Client(url);
  await c.connect();
  const selected = steps.filter((s) => stepNum(s.id) >= stepNum(fromStep) && stepNum(s.id) <= stepNum(toStep));
  console.log(`模式: ${APPLY ? "APPLY" : "DRY-RUN"} · 步骤: ${selected.map((s) => s.id).join(" ")}`);
  if (APPLY) {
    mkdirSync(RUN_DIR, { recursive: true });
    if (fromStep === "P1") writeFileSync(ROLLBACK, "-- 回滚脚本（按序执行）\n-- 生成于 " + new Date().toISOString() + "\n");
  }
  for (const step of selected) {
    console.log(`\n[${step.id}] ${step.name}`);
    try {
      await c.query("BEGIN");
      const rollbackSql = await step.run(c);
      if (APPLY) {
        await c.query("COMMIT");
        appendFileSync(ROLLBACK, `\n-- === ${step.id}: ${step.name} ===\n${rollbackSql.join("\n")}\n`);
        console.log("  ✓ 已提交");
      } else {
        await c.query("ROLLBACK");
        console.log("  (dry-run 已回滚)");
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
