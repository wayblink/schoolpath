/** Register existing official catchment evidence in web_data_source. */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const apply = process.argv.includes("--apply");

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    const rows = await client.query<{ id: number; name: string; district: string; url: string }>(`
      select id, name, district, attrs->>'official_boundary_source' url
      from public.schools
      where attrs->>'official_boundary_source' is not null
        and attrs->>'official_boundary_source' <> ''
    `);
    let upserts = 0;
    for (const row of rows.rows) {
      const result = await client.query(`
        insert into public.web_data_source
          (school_id, source_type, source_name, source_url, source_title, source_date, evidence, confidence, raw, fetched_at, created_at, updated_at)
        values ($1, 'official_admission', '区教育局/上海市政府', $2, '2025年义务教育招生学区范围', '2025', $3, 'high', $4::jsonb, now(), now(), now())
        on conflict (school_id, source_url, source_type) do update set updated_at=now(), confidence='high'
      `, [row.id, row.url, `${row.district}区官方招生范围已关联到学校记录`, JSON.stringify({ evidence: "official_boundary_source", backfill: "2026-08-12" })]);
      upserts += result.rowCount ?? 0;
    }
    const total = Number((await client.query("select count(*)::int count from public.web_data_source")).rows[0].count);
    console.log(JSON.stringify({ targets: rows.rowCount, upserts, total, mode: apply ? "apply" : "dry-run" }));
    if (apply) await client.query("commit"); else await client.query("rollback");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally { await client.end(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
