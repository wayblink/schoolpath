// Phase A2/A4：导出迁移前快照——结构 DDL、关键表数据 CSV、行数基线。
// 用法：node scripts/migration/export-baseline.ts <snapshotDir>
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const SNAPSHOT_TABLES = [
  "catalog.school_district_relations",
  "catalog.school_community_assignments",
  "catalog.source_schools",
  "catalog.schools",
  "catalog.communities",
  "catalog.policy_documents",
  "catalog.school_aliases",
  "catalog.school_feeder_relations",
  "catalog.districts",
  "audit.entity_match_candidates",
  "audit.field_conflicts",
  "audit.release_batches",
  "audit.school_community_relation_candidates",
  "public.schools",
  "public.communities",
  "public.school_communities",
  "public.school_community_candidates",
  "public.policies",
  "public.web_data_source",
  "public.district_boundaries",
  "public.community_price_snapshots",
  "public.community_price_sources",
  "catalog.school_ratings",
  "ingest.sources",
  "ingest.crawl_runs",
  "ingest.extracted_records",
];

async function main() {
  const snapshotDir = path.resolve(process.argv[2]);
  mkdirSync(snapshotDir, { recursive: true });
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const c = new pg.Client(url);
  await c.connect();

  // --- 全库结构 DDL（pg_dump 不可用，用 information_schema + pg_catalog 拼）---
  const tables = await c.query(
    `select table_schema, table_name from information_schema.tables
     where table_schema in ('public','catalog','ingest','audit') and table_type='BASE TABLE'
     order by table_schema, table_name`,
  );
  const lines: string[] = ["-- schema snapshot before 2026-09-14 convergence", ""];
  const baseline: Record<string, number> = {};
  for (const { table_schema, table_name } of tables.rows) {
    const cols = await c.query(
      `select column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema=$1 and table_name=$2 order by ordinal_position`,
      [table_schema, table_name],
    );
    lines.push(`-- ${table_schema}.${table_name}`);
    lines.push(`CREATE TABLE ${table_schema}.${table_name} (`);
    lines.push(
      cols.rows
        .map((r) => `  ${r.column_name} ${r.data_type}${r.is_nullable === "NO" ? " NOT NULL" : ""}`)
        .join(",\n"),
    );
    lines.push(");");
    lines.push("");
    const key = `${table_schema}.${table_name}`;
    if (SNAPSHOT_TABLES.includes(key)) {
      const cnt = await c.query(`select count(*) c from ${key}`);
      baseline[key] = Number(cnt.rows[0].c);
    }
  }
  writeFileSync(path.join(snapshotDir, "schema-before.txt"), lines.join("\n"));
  writeFileSync(path.join(snapshotDir, "rowcount-baseline.json"), JSON.stringify(baseline, null, 2));

  // --- 关键表数据 CSV 快照 ---
  for (const key of SNAPSHOT_TABLES) {
    const rows = await c.query(`select * from ${key}`);
    const file = path.join(snapshotDir, `data-${key.replace(".", "_")}.csv`);
    if (rows.fields.length === 0) continue;
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      rows.fields.map((f) => f.name).join(","),
      ...rows.rows.map((r) => rows.fields.map((f) => esc(r[f.name])).join(",")),
    ].join("\n");
    writeFileSync(file, csv);
  }
  await c.end();
  console.log(JSON.stringify({ snapshotDir, tables: tables.rowCount, baseline }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
