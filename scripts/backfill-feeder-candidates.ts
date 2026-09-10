/** Promote explicit extracted "对口初中" fields into pending catalog feeder candidates. */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const apply = process.argv.includes("--apply");

function district(value: string) { return value === "浦东新区" ? "浦东" : value.replace(/区$/, ""); }

type SourceRow = {
  source_record_id: number;
  district: string | null;
  raw: Record<string, unknown> | null;
  source_url: string | null;
  source_name: string;
};
type SchoolMatch = { id: number; name: string; type: "primary" | "middle" | "nine_year" };

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<SourceRow>(`
      select e.id source_record_id, e.district, e.raw, coalesce(cr.source_url, src.base_url) source_url,
             coalesce(cr.page_title, src.name) source_name
      from ingest.extracted_records e
      join ingest.crawl_runs cr on cr.id=e.crawl_run_id
      join ingest.sources src on src.id=cr.source_id
      where e.record_type='school' and nullif(trim(e.raw->>'对口初中'),'') is not null
    `);
    let inserted = 0, matched = 0, skipped = 0;
    const report: Array<Record<string, unknown>> = [];
    for (const row of rows) {
      const d = district(row.district ?? "");
      const primaryName = String(row.raw?.["名称"] ?? row.raw?.name ?? "");
      const middleName = String(row.raw?.["对口初中"] ?? "");
      const schools = await client.query<SchoolMatch>(`
        select s.id, s.canonical_name name, s.school_type type from catalog.schools s join catalog.districts d on d.id=s.district_id
        where replace(d.canonical_name,'区','')=$1 and s.school_type in ('primary','nine_year','middle')
          and (lower(s.canonical_name)=lower($2) or replace(replace(s.canonical_name,'上海市',''),'区','')=replace(replace($2,'上海市',''),'区','')
               or exists (select 1 from catalog.school_aliases a where a.school_id=s.id and (lower(a.alias)=lower($2) or replace(a.alias,'上海市','')=replace($2,'上海市',''))))
      `, [d, primaryName]);
      const from = schools.rows.filter((s) => s.type !== "middle");
      const to = await client.query<SchoolMatch>(`
        select s.id, s.canonical_name name from catalog.schools s join catalog.districts d on d.id=s.district_id
        where replace(d.canonical_name,'区','')=$1 and s.school_type='middle'
          and (lower(s.canonical_name)=lower($2) or replace(s.canonical_name,'上海市','')=replace($2,'上海市','')
               or exists (select 1 from catalog.school_aliases a where a.school_id=s.id and (lower(a.alias)=lower($2) or replace(a.alias,'上海市','')=replace($2,'上海市',''))))
      `, [d, middleName]);
      const item = { sourceRecordId: row.source_record_id, district: d, primaryName, middleName, from: from.length, to: to.rows.length };
      if (from.length !== 1 || to.rows.length !== 1) { skipped++; report.push({...item, action: "unmatched"}); continue; }
      matched++;
      if (apply) {
        const result = await client.query(`
          insert into catalog.school_feeder_relations(from_school_id,to_school_id,to_school_name_raw,year,relation_type,assignment_mode,source_type,source_name,source_url,confidence,review_status,raw)
          values($1,$2,$3,2025,'对口初中',coalesce(nullif($4,''),'deterministic'),'official_extracted',$5,$6,'medium','pending',$7::jsonb)
          on conflict (from_school_id,to_school_name_raw,year,source_name) do nothing
        `, [from[0].id, to.rows[0].id, middleName, String(row.raw?.["入学方式"] ?? ""), row.source_name, row.source_url, JSON.stringify({ sourceRecordId: row.source_record_id, primaryName, middleName, raw: row.raw })]);
        inserted += result.rowCount ?? 0;
      }
      report.push({...item, action: apply ? "inserted_if_new" : "dry_run"});
    }
    console.log(JSON.stringify({ candidates: rows.length, matched, skipped, inserted, mode: apply ? "apply" : "dry-run" }));
    if (apply) await client.query("commit"); else await client.query("rollback");
  } catch (error) { await client.query("rollback"); throw error; }
  finally { await client.end(); }
}
main().catch((error) => { console.error(error); process.exit(1); });
