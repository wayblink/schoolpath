import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "../load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(readFileSync(path.join(process.cwd(), "db/redesign/003_create_school_district_relations.sql"), "utf8").replace(/^BEGIN;|COMMIT;$/gm, ""));
    await client.query(`
      insert into catalog.school_district_relations(
        source_record_id,source_name,source_url,source_year,district,school_name,school_type,
        committee_name,area,street,catalog_school_id,catalog_community_id,
        school_match_score,community_match_score,match_status,review_status,verified,attrs
      )
      select
        r.source_record_id,'学区助手','https://xuequzhushou.cn/',2026,r.district,r.school_name_raw,
        coalesce(e.raw->>'schoolType','primary'),r.committee_name_raw,r.area,r.street,
        r.catalog_school_id,r.catalog_community_id,r.school_match_score,r.community_match_score,
        case
          when r.catalog_school_id is not null and r.catalog_community_id is not null then 'matched'
          when r.catalog_school_id is not null then 'school_matched'
          when r.catalog_community_id is not null then 'community_matched'
          else 'raw'
        end,
        case when r.review_status='accepted' then 'accepted' else 'provisional' end,
        r.review_status='accepted',
        jsonb_build_object(
          'crawlRunId',r.crawl_run_id,
          'relationCandidateId',r.id,
          'communityMatchMethod',r.community_match_method,
          'resolutionNote',r.resolution_note
        )
      from audit.school_community_relation_candidates r
      join ingest.extracted_records e on e.id=r.source_record_id
      on conflict(source_record_id) do update set
        catalog_school_id=excluded.catalog_school_id,
        catalog_community_id=excluded.catalog_community_id,
        school_match_score=excluded.school_match_score,
        community_match_score=excluded.community_match_score,
        match_status=excluded.match_status,
        review_status=excluded.review_status,
        verified=excluded.verified,
        attrs=excluded.attrs,
        updated_at=now()
    `);
    await client.query("COMMIT");
    const { rows } = await client.query(`
      select count(*)::int total,
        count(*) filter(where catalog_school_id is not null)::int with_school,
        count(*) filter(where catalog_community_id is not null)::int with_community,
        count(*) filter(where catalog_school_id is null and catalog_community_id is null)::int raw_only,
        count(*) filter(where review_status='accepted')::int accepted,
        count(*) filter(where review_status='provisional')::int provisional
      from catalog.school_district_relations where source_name='学区助手'
    `);
    console.table(rows);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
