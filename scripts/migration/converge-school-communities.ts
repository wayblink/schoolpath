// catalog.school_communities 收敛迁移：candidates + relations → 一张同构新表，附伪小区分层治理。
// 设计依据：.trellis/tasks/09-14-catalog-school-communities-converge/design.md（D1-D7）。
// 模式照抄 scripts/migration/converge.ts：每步独立事务，失败即停；--from/--to 分段；
// 干跑（默认）只执行不提交并回滚，--apply 才提交并随执行写入 rollback.sql。
// 用法：DATABASE_URL=... npx tsx scripts/migration/converge-school-communities.ts [--apply] [--from=S1] [--to=S8]
import pg from "pg";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const RUN_DIR = path.resolve("data/migrations/2026-09-15-school-communities-converge");
const ROLLBACK = path.join(RUN_DIR, "rollback.sql");
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const fromStep = (args.find((a) => a.startsWith("--from="))?.slice(7) ?? "S0").toUpperCase();
const toStep = (args.find((a) => a.startsWith("--to="))?.slice(5) ?? "S8").toUpperCase();

// 治理前基线快照（S6 回滚依据，仅 APPLY 时落盘）
const SNAPSHOT_OFFICIAL_COMMUNITIES = path.join(RUN_DIR, "communities-official-before.csv");
const SNAPSHOT_SC_AFFECTED = path.join(RUN_DIR, "school_communities-affected-before.csv");

type Step = {
  id: string;
  name: string;
  run: (c: pg.Client) => Promise<string[]>; // 返回 rollback SQL 语句数组
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
    id: "S0",
    name: "治理前快照（官方系 communities + 引用它们的 sc 行）",
    run: async (c) => {
      const comm = await c.query(
        `select c.* from public.communities c where c.source_name like 'official_school_community_candidates%' order by c.id`,
      );
      const sc = await c.query(
        `select sc.* from public.school_communities sc join public.communities c on c.id=sc.community_id
         where c.source_name like 'official_school_community_candidates%' order by sc.id`,
      );
      console.log(`  S0: 官方系 communities ${comm.rowCount} 行 · 引用 sc ${sc.rowCount} 行`);
      if (APPLY) {
        writeFileSync(SNAPSHOT_OFFICIAL_COMMUNITIES, toCsv(comm));
        writeFileSync(SNAPSHOT_SC_AFFECTED, toCsv(sc));
        console.log(`  S0: 快照已写入 ${RUN_DIR}`);
      }
      return [`-- S0 快照为只读，无回滚动作`];
    },
  },
  {
    id: "S1",
    name: "public.communities 加 entity_kind 列（默认 community）",
    run: async (c) => {
      await c.query(`ALTER TABLE public.communities ADD COLUMN IF NOT EXISTS entity_kind text NOT NULL DEFAULT 'community'`);
      const n = Number((await c.query(`select count(*) c from public.communities`)).rows[0].c);
      console.log(`  S1: entity_kind 已就位（communities ${n} 行默认 community）`);
      return [`ALTER TABLE public.communities DROP COLUMN IF EXISTS entity_kind;`];
    },
  },
  {
    id: "S2",
    name: "建 catalog.school_communities（D1 DDL）+ 唯一索引",
    run: async (c) => {
      const exists = (await c.query(`select to_regclass('catalog.school_communities') t`)).rows[0].t;
      if (exists) throw new Error("S2 前置失败：catalog.school_communities 已存在");
      await c.query(`
        CREATE TABLE catalog.school_communities (
          id serial PRIMARY KEY,
          school_id int REFERENCES public.schools(id),
          school_name_raw text,
          district text,
          community_id int REFERENCES public.communities(id),
          committee_name text,
          year int,
          source_name text NOT NULL,
          source_record_id bigint,
          source_url text,
          source_quote text,
          source_date text,
          confidence text,
          review_status text NOT NULL DEFAULT 'pending',
          verified boolean NOT NULL DEFAULT false,
          notes text,
          release_batch_id bigint,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX uq_catalog_school_communities_pair ON catalog.school_communities(school_id, community_id);
      `);
      console.log("  S2: 新表已建");
      return [`DROP TABLE IF EXISTS catalog.school_communities;`];
    },
  },
  {
    id: "S3",
    name: "迁 candidates 全量（source_name='official'，status→review_status 映射）",
    run: async (c) => {
      const before = Number((await c.query(`select count(*) c from catalog.official_enrollment_areas`)).rows[0].c);
      if (before !== 23070) throw new Error(`S3 前置失败：official_enrollment_areas ${before} ≠ 基线 23,070`);
      const orphan = Number(
        (await c.query(
          `select count(*) c from catalog.official_enrollment_areas o left join public.schools s on s.id=o.school_id where o.school_id is not null and s.id is null`,
        )).rows[0].c,
      );
      if (orphan > 0) throw new Error(`S3 前置失败：${orphan} 行 school_id 无法 join public.schools`);
      const statusDist = await c.query(`select status, count(*)::int n from catalog.official_enrollment_areas group by 1 order by 1`);
      console.log(`  S3: 源 status 分布 ${JSON.stringify(statusDist.rows)}`);
      const ins = await c.query(`
        INSERT INTO catalog.school_communities(
          school_id, school_name_raw, district, community_id, committee_name, year,
          source_name, source_url, source_quote, source_date, confidence,
          review_status, verified, notes, created_at, updated_at)
        SELECT
          c.school_id,
          c.school_name_raw,
          c.district,
          c.community_id,
          c.community_name_raw,
          c.year,
          'official',
          c.source_url,
          c.source_quote,
          c.source_date,
          c.confidence,
          CASE WHEN c.status = 'promoted' THEN 'published' ELSE 'pending' END,
          false,
          concat_ws('; ',
            'candidate_id=' || c.id,
            'extraction=' || (c.raw->>'extraction'),
            'title=' || c.source_title,
            CASE WHEN c.committee_name_raw IS NOT NULL AND c.committee_name_raw <> c.community_name_raw
                 THEN 'committee=' || c.committee_name_raw END,
            nullif(c.review_notes, '')),
          c.created_at,
          c.updated_at
        FROM catalog.official_enrollment_areas c
      `);
      const got = Number((await c.query(`select count(*) c from catalog.school_communities where source_name='official'`)).rows[0].c);
      console.log(`  S3: 迁入 ${ins.rowCount} 行，新表官方系 ${got} 行（预期 ${before}）`);
      if (ins.rowCount !== before || got !== before) throw new Error("S3 行数不符");
      return [`DELETE FROM catalog.school_communities WHERE source_name = 'official';`];
    },
  },
  {
    id: "S4",
    name: "迁 relations 学区助手系（排除 source_record_id<0 的 682 行官方镜像；legacy_id→public id 转换）",
    run: async (c) => {
      const total = Number((await c.query(`select count(*) c from catalog.relations`)).rows[0].c);
      const mirrored = Number((await c.query(`select count(*) c from catalog.relations where source_record_id < 0`)).rows[0].c);
      if (total !== 3446 || mirrored !== 682) throw new Error(`S4 前置失败：relations ${total} 行 / 镜像 ${mirrored} ≠ 基线 3,446/682`);
      const statusDist = await c.query(
        `select review_status, count(*)::int n from catalog.relations where source_record_id >= 0 group by 1 order by 1`,
      );
      console.log(`  S4: 学区助手系 review_status 分布 ${JSON.stringify(statusDist.rows)}`);
      const orphanSchool = Number(
        (await c.query(
          `select count(*) c from catalog.relations r left join public.schools ps on ps.id=r.school_id where r.source_record_id >= 0 and ps.id is null`,
        )).rows[0].c,
      );
      if (orphanSchool > 0) throw new Error(`S4 前置失败：${orphanSchool} 行学区助手 school_id 无法 join public.schools`);
      const ins = await c.query(`
        INSERT INTO catalog.school_communities(
          school_id, school_name_raw, district, community_id, committee_name, year,
          source_name, source_record_id, source_url, confidence,
          review_status, verified, notes, release_batch_id, created_at, updated_at)
        SELECT
          r.school_id,
          r.school_name,
          r.district,
          pc.id,
          r.committee_name,
          r.source_year,
          r.source_name,
          r.source_record_id,
          r.source_url,
          NULL,
          CASE WHEN r.review_status = 'accepted' THEN 'accepted' ELSE 'pending' END,
          r.verified,
          concat_ws('; ',
            'relations_id=' || r.id,
            'match=' || r.match_status,
            'area=' || nullif(r.area, ''),
            'street=' || nullif(r.street, ''),
            'school_type=' || nullif(r.school_type, '')),
          r.release_batch_id,
          r.updated_at,
          r.updated_at
        FROM catalog.relations r
        LEFT JOIN catalog.communities cc ON cc.id = r.catalog_community_id
        LEFT JOIN public.communities pc ON pc.id = cc.legacy_id
        WHERE r.source_record_id >= 0
      `);
      const got = Number((await c.query(`select count(*) c from catalog.school_communities where source_name <> 'official'`)).rows[0].c);
      const conv = Number((await c.query(`select count(*) c from catalog.school_communities where source_name <> 'official' and community_id is not null`)).rows[0].c);
      console.log(`  S4: 迁入 ${ins.rowCount} 行，新表学区助手系 ${got} 行，其中 community_id 转换成功 ${conv} 行（基线 263）`);
      if (ins.rowCount !== total - mirrored) throw new Error("S4 行数不符");
      if (conv !== 263) console.log(`  S4 警告：legacy_id 转换 ${conv} ≠ 基线 263，请人工确认`);
      return [`DELETE FROM catalog.school_communities WHERE source_name <> 'official';`];
    },
  },
  {
    id: "S5",
    name: "迁移对账（行数/来源分布/review_status 分布）",
    run: async (c) => {
      const total = Number((await c.query(`select count(*) c from catalog.school_communities`)).rows[0].c);
      const bySource = await c.query(`select source_name, review_status, count(*)::int n from catalog.school_communities group by 1,2 order by 1,2`);
      const orphanFk = Number(
        (await c.query(
          `select count(*) c from catalog.school_communities x left join public.communities p on p.id=x.community_id where x.community_id is not null and p.id is null`,
        )).rows[0].c,
      );
      console.log(`  S5: 总行 ${total}（预期 25,834）`);
      console.log(`  S5: 分布 ${bySource.rows.map((r) => `${r.source_name}/${r.review_status}=${r.n}`).join(" ")}`);
      console.log(`  S5: community_id FK 失效 ${orphanFk} 行（预期 0）`);
      if (total !== 25834) throw new Error("S5 对账失败：总行数不符");
      if (orphanFk !== 0) throw new Error("S5 对账失败：存在 FK 失效行");
      return [];
    },
  },
  {
    id: "S6A",
    name: "治理-a：重名合并（127 个唯一匹配伪实体并入真实小区；48 歧义保留）",
    run: async (c) => {
      await c.query(`
        CREATE TEMP TABLE merge_map AS
        WITH pseudo AS (
          SELECT id, regexp_replace(trim(name), '[（(].*$', '', 'g') AS norm
          FROM public.communities
          WHERE source_name LIKE 'official_school_community_candidates%' AND name IS NOT NULL AND trim(name) <> ''
        ),
        real AS (
          SELECT id, regexp_replace(trim(name), '[（(].*$', '', 'g') AS norm
          FROM public.communities
          WHERE source_name NOT LIKE 'official_school_community_candidates%' AND name IS NOT NULL AND trim(name) <> ''
        ),
        joined AS (
          SELECT p.id AS pseudo_id, r.id AS real_id
          FROM pseudo p JOIN real r ON r.norm = p.norm AND p.norm <> ''
        ),
        counted AS (
          SELECT pseudo_id, real_id, count(*) OVER (PARTITION BY pseudo_id) AS hits FROM joined
        )
        SELECT pseudo_id, real_id FROM counted WHERE hits = 1
      `);
      const pairs = Number((await c.query(`select count(*) c from merge_map`)).rows[0].c);
      const ambiguous = Number((await c.query(`
        WITH pseudo AS (
          SELECT id, regexp_replace(trim(name), '[（(].*$', '', 'g') AS norm
          FROM public.communities
          WHERE source_name LIKE 'official_school_community_candidates%' AND name IS NOT NULL AND trim(name) <> ''
        ),
        real AS (
          SELECT id, regexp_replace(trim(name), '[（(].*$', '', 'g') AS norm
          FROM public.communities
          WHERE source_name NOT LIKE 'official_school_community_candidates%' AND name IS NOT NULL AND trim(name) <> ''
        )
        SELECT count(*)::int c FROM (
          SELECT p.id, count(r.id) AS hits FROM pseudo p JOIN real r ON r.norm = p.norm AND p.norm <> '' GROUP BY p.id
        ) t WHERE hits > 1
      `)).rows[0].c);
      console.log(`  S6a: 唯一匹配对 ${pairs}（预期 127）· 歧义保留 ${ambiguous}（预期 48）`);
      if (pairs !== 127) throw new Error(`S6a 前置失败：唯一匹配对 ${pairs} ≠ 127`);

      // 0) 改指新表全部行的 community_id（S3 迁移复制的官方指向 + S4 legacy_id 转换撞上伪实体的学区助手行；
      //    引用完整性对所有来源一视同仁，不限制 source_name）
      const updNew = await c.query(`
        UPDATE catalog.school_communities x
        SET community_id = m.real_id
        FROM merge_map m
        WHERE x.community_id = m.pseudo_id
      `);
      console.log(`  S6a: 新表 community_id 改指 ${updNew.rowCount} 行（官方系 + legacy_id 撞实体行）`);

      // 1) 冲突行：官方行 (school_id, pseudo_id) 合并后 (school_id, real_id) 已存在 → 快照后删除
      const conflicts = await c.query(`
        SELECT sc.* FROM public.school_communities sc
        JOIN merge_map m ON m.pseudo_id = sc.community_id
        WHERE EXISTS (
          SELECT 1 FROM public.school_communities tgt
          WHERE tgt.school_id = sc.school_id AND tgt.community_id = m.real_id
        ) ORDER BY sc.id
      `);
      console.log(`  S6a: uq 冲突行 ${conflicts.rowCount} 行（删除，真实行已表达同关系）`);
      if (APPLY && (conflicts.rowCount ?? 0) > 0) {
        writeFileSync(path.join(RUN_DIR, "school_communities-merge-conflicts-deleted.csv"), toCsv(conflicts));
      }
      if ((conflicts.rowCount ?? 0) > 0) {
        await c.query(`
          DELETE FROM public.school_communities sc
          USING merge_map m
          WHERE sc.community_id = m.pseudo_id
            AND EXISTS (SELECT 1 FROM public.school_communities tgt WHERE tgt.school_id = sc.school_id AND tgt.community_id = m.real_id)
        `);
      }
      // 2) 改指剩余官方行（快照留档）
      const affected = await c.query(`
        SELECT sc.* FROM public.school_communities sc JOIN merge_map m ON m.pseudo_id = sc.community_id ORDER BY sc.id
      `);
      if (APPLY) writeFileSync(path.join(RUN_DIR, "school_communities-merge-repointed.csv"), toCsv(affected));
      const upd = await c.query(`
        UPDATE public.school_communities sc
        SET community_id = m.real_id
        FROM merge_map m
        WHERE sc.community_id = m.pseudo_id
      `);
      console.log(`  S6a: sc.community_id 改指 ${upd.rowCount} 行`);
      // 3) 删伪实体：老表 official_enrollment_areas 的 FK（school_community_candidates_community_id_fkey）
      //    先于归档步骤 drop（老表即将改名归档，FK 无意义）；price 两张表如引用伪实体会在此报错中断
      await c.query(`ALTER TABLE catalog.official_enrollment_areas DROP CONSTRAINT IF EXISTS school_community_candidates_community_id_fkey`);
      const del = await c.query(`DELETE FROM public.communities WHERE id IN (SELECT pseudo_id FROM merge_map)`);
      console.log(`  S6a: 删除伪实体 ${del.rowCount} 个`);
      return [
        `-- S6a 回滚：伪实体从 communities-official-before.csv 恢复（\\copy）；`,
        `-- 新表/sc 改指行从 school_communities-merge-repointed.csv + school_communities-merge-conflicts-deleted.csv 恢复（\\copy，需先删改指后的行）；`,
        `-- 恢复老表 FK：ALTER TABLE catalog.official_enrollment_areas ADD CONSTRAINT school_community_candidates_community_id_fkey FOREIGN KEY (community_id) REFERENCES public.communities(id);`,
      ];
    },
  },
  {
    id: "S6B",
    name: "治理-b：混合粒度/片段实体标注 entity_kind='official_area'（动态预期，含歧义保留实体的混写形态）",
    run: async (c) => {
      // 预期动态计算：剩余官方实体 − 不标注集合（小区级命名 且 非混写 且 非居委结尾）
      // 说明：前期静态统计的 914 只覆盖"无匹配"实体；歧义保留的 48 个中符合混写正则的也需标注（实测 +24 = 938）
      const remaining = Number(
        (await c.query(
          `select count(*) c from public.communities where source_name like 'official_school_community_candidates%' and entity_kind='community'`,
        )).rows[0].c,
      );
      const notTagged = Number(
        (await c.query(`
          select count(*) c from public.communities
          where source_name like 'official_school_community_candidates%' and entity_kind='community'
            and name !~ '(街道|镇|乡).*(社区|苑|园|里|弄|村|居委|委会)'
            and name !~ '(居委|村委会)$'
            and name ~ '(弄|村|苑|园|里|坊|府|邸|庭|城|湾|花园|新村|公寓|小区)'
        `)).rows[0].c,
      );
      const expected = remaining - notTagged;
      const upd = await c.query(`
        UPDATE public.communities SET entity_kind = 'official_area'
        WHERE source_name LIKE 'official_school_community_candidates%'
          AND entity_kind = 'community'
          AND (
            name ~ '(街道|镇|乡).*(社区|苑|园|里|弄|村|居委|委会)'
            OR name ~ '(居委|村委会)$'
            OR name !~ '(弄|村|苑|园|里|坊|府|邸|庭|城|湾|花园|新村|公寓|小区)'
          )
      `);
      console.log(`  S6b: 标注 official_area ${upd.rowCount} 个（动态预期 ${expected} = 剩余 ${remaining} − 小区级 ${notTagged}）`);
      if (upd.rowCount !== expected) throw new Error(`S6b 对账失败：标注 ${upd.rowCount} ≠ 动态预期 ${expected}`);
      return [`UPDATE public.communities SET entity_kind = 'community' WHERE entity_kind = 'official_area';`];
    },
  },
  {
    id: "S6C",
    name: "治理-c：总量守恒核验（官方系 community + official_area = S6A 删后剩余 9,250）",
    run: async (c) => {
      const community = Number(
        (await c.query(
          `select count(*) c from public.communities where source_name like 'official_school_community_candidates%' and entity_kind='community'`,
        )).rows[0].c,
      );
      const area = Number(
        (await c.query(
          `select count(*) c from public.communities where source_name like 'official_school_community_candidates%' and entity_kind='official_area'`,
        )).rows[0].c,
      );
      console.log(`  S6c: 保留 community ${community} + 标注 official_area ${area} = ${community + area}（守恒预期 9,250 = 9,377 − 127 合并）`);
      if (community + area !== 9250) throw new Error(`S6c 核验失败：${community + area} ≠ 9,250`);
      return [];
    },
  },
  {
    id: "S7",
    name: "归档：老表 rename 带 _archived 后缀",
    run: async (c) => {
      for (const [oldName, newName] of [
        ["catalog.official_enrollment_areas", "catalog.official_enrollment_areas_archived"],
        ["catalog.relations", "catalog.relations_archived"],
      ]) {
        const [schema, table] = oldName.split(".");
        const exists = (await c.query(`select to_regclass($1) t`, [oldName])).rows[0].t;
        if (!exists) throw new Error(`S7 前置失败：${oldName} 不存在`);
        await c.query(`ALTER TABLE ${schema}.${JSON.stringify(table)} RENAME TO ${JSON.stringify(newName.split(".")[1])}`);
        console.log(`  S7: ${oldName} → ${newName}`);
      }
      return [
        `ALTER TABLE catalog.official_enrollment_areas_archived RENAME TO official_enrollment_areas;`,
        `ALTER TABLE catalog.relations_archived RENAME TO relations;`,
      ];
    },
  },
  {
    id: "S8",
    name: "终对账 + 治理报告",
    run: async (c) => {
      const checks: Array<[string, number, number]> = [
        ["catalog.school_communities 总行", 25834, Number((await c.query(`select count(*) c from catalog.school_communities`)).rows[0].c)],
        ["public.communities 总行（31,399 − 127 合并）", 31272, Number((await c.query(`select count(*) c from public.communities`)).rows[0].c)],
        ["entity_kind=official_area 标注数（含歧义保留实体的混写形态）", 925, Number((await c.query(`select count(*) c from public.communities where entity_kind='official_area'`)).rows[0].c)],
      ];
      const results = checks.map(([label, want, got]) => `${got === want ? "✓" : "✗"} ${label}: ${got}${got === want ? "" : ` (预期 ${want})`}`);
      const scTotal = Number((await c.query(`select count(*) c from public.school_communities`)).rows[0].c);
      const brokenSc = Number(
        (await c.query(
          `select count(*) c from public.school_communities sc left join public.communities p on p.id=sc.community_id where sc.community_id is not null and p.id is null`,
        )).rows[0].c,
      );
      results.push(`· public.school_communities ${scTotal} 行 · FK 失效 ${brokenSc} 行（预期 0）`);
      console.log(results.map((r) => `  ${r}`).join("\n"));
      const failed = checks.filter(([, want, got]) => want !== got);
      if (failed.length > 0 || brokenSc !== 0) throw new Error("S8 终对账失败");
      return [];
    },
  },
];

const stepNum = (id: string) => Number(id.slice(1));
const stepOrder = (id: string) => (id === "S6A" ? 6.1 : id === "S6B" ? 6.2 : id === "S6C" ? 6.3 : stepNum(id));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const c = new pg.Client(url);
  await c.connect();
  const selected = steps.filter((s) => stepOrder(s.id) >= stepOrder(fromStep) && stepOrder(s.id) <= stepOrder(toStep));
  console.log(`模式: ${APPLY ? "APPLY" : "DRY-RUN"} · 步骤: ${selected.map((s) => s.id).join(" ")}`);
  if (APPLY) {
    mkdirSync(RUN_DIR, { recursive: true });
    // 分段 apply 时不清空已有回滚语句（累积模式），仅首次写 header
    // S1 的 entity_kind 列回滚是常量 DDL，随 header 一起落盘——否则 --from=S2 起跑时
    // rollback.sql 会缺这一段，回滚后 public.communities 残留 entity_kind 列（design D6 要求 drop）。
    if (fromStep === "S0" || !existsSync(ROLLBACK)) {
      writeFileSync(ROLLBACK, [
        "-- 回滚脚本（迁移失败时按序执行）",
        "-- 生成于 " + new Date().toISOString(),
        "",
        "-- === S1: public.communities 加 entity_kind 列 ===",
        "ALTER TABLE public.communities DROP COLUMN IF EXISTS entity_kind;",
        "",
      ].join("\n"));
    }
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
