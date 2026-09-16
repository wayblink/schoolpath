// school_pathways 迁移：把 schools.feeder_middle_school 模糊文本解析为结构化路径表。
// 幂等：create table if not exists + on conflict do nothing + 应用层去重，可重跑。
// 用法：npx tsx scripts/migration/pathways-from-feeder.ts [--dry-run]
import pg from "pg";
import { loadLocalEnv } from "../load-env";
import { parseFeederRow, type AdmissionMode } from "../../lib/pathways/parse";

loadLocalEnv();

const DDL = `
create table if not exists public.school_pathways (
  id bigserial primary key,
  primary_school_id bigint not null references public.schools(id),
  middle_school_id bigint references public.schools(id),
  admission_mode text not null check (admission_mode in ('assign','placement','direct','partial','unknown')),
  raw_text text not null,
  source_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (primary_school_id, middle_school_id, admission_mode)
);
`;

const SUFFIXES = ["", "中学", "初级中学", "学校"];

async function matchMiddle(client: pg.PoolClient, candidate: string): Promise<number | null> {
  for (const suffix of SUFFIXES) {
    const { rows } = await client.query(
      `select id from public.schools where type = 'middle' and name = $1 order by id limit 1`,
      [candidate + suffix],
    );
    if (rows.length) return Number(rows[0].id);
  }
  return null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    if (!dryRun) await client.query(DDL);

    const { rows: feeders } = await client.query(
      `select id, name, feeder_middle_school from public.schools
       where type = 'primary' and feeder_middle_school is not null and trim(feeder_middle_school) <> ''
       order by id`,
    );
    console.log(`feeder 行数: ${feeders.length}`);

    let matched = 0;
    let unmatched = 0;
    const unmatchedNames = new Set<string>();
    const insertRows: { primaryId: number; middleId: number | null; mode: AdmissionMode; raw: string }[] = [];

    for (const f of feeders) {
      const parsed = parseFeederRow(f.name, f.feeder_middle_school);
      const seen = new Set<string>();
      for (const candidate of parsed.candidates) {
        const middleId = await matchMiddle(client, candidate);
        const key = `${candidate}|${middleId ?? "null"}|${parsed.admissionMode}`;
        if (seen.has(key)) continue; // 应用层去重（唯一约束对 NULL middle 不去重）
        seen.add(key);
        if (middleId) matched++; else { unmatched++; unmatchedNames.add(candidate); }
        // matched 行留整行原文作凭证；unmatched 行留候选名，供 ops 人工补录时直接对照
        insertRows.push({ primaryId: Number(f.id), middleId, mode: parsed.admissionMode, raw: middleId ? parsed.rawText : candidate });
      }
    }

    if (!dryRun) {
      await client.query(`delete from public.school_pathways where source_name = 'pathway-migration'`);
      if (insertRows.length) {
        const placeholders = insertRows.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(", ");
        const values = insertRows.flatMap((r) => [r.primaryId, r.middleId, r.mode, r.raw, "pathway-migration"]);
        await client.query(
          `insert into public.school_pathways(primary_school_id, middle_school_id, admission_mode, raw_text, source_name)
           values ${placeholders} on conflict do nothing`,
          values,
        );
      }
    }

    console.log(`解析边数: ${insertRows.length}（matched ${matched} / unmatched ${unmatched}）`);
    if (!dryRun) {
      const { rows: totalRows } = await client.query(`select count(*)::int c from public.school_pathways`);
      console.log(`school_pathways 当前行数: ${totalRows[0].c}`);
    }
    console.log(`unmatched 初中名（${unmatchedNames.size} 个，待人工补录）: ${[...unmatchedNames].sort().join(", ")}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
