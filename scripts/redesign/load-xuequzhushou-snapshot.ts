import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "../load-env";
import type { ParsedXuequzhushou, SourceSchool } from "../../lib/ingest/xuequzhushou";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const parsedPath = process.argv.find((arg) => arg.startsWith("--parsed="))?.slice(9);
if (!parsedPath) throw new Error("--parsed=<path> is required");
const parsed = JSON.parse(readFileSync(path.resolve(parsedPath), "utf8")) as ParsedXuequzhushou;
const client = new pg.Client({ connectionString: databaseUrl });
const normalizeDistrict = (name: string) => name === "浦东新区" ? "浦东" : name.replace(/区$/, "");
const typeFor = (kind: "primary" | "middle", school: SourceSchool) => school.名称.includes("九年一贯") ? "nine_year" : kind;

async function main() {
  await client.connect();
  try {
  await client.query("BEGIN");
  const source = await client.query(`insert into ingest.sources(source_key,name,base_url,source_kind) values('xuequzhushou','学区助手','https://xuequzhushou.cn/','third_party') on conflict(source_key) do update set updated_at=now() returning id`);
  const run = await client.query(`insert into ingest.crawl_runs(source_id,source_url,fetched_at,http_status,content_hash,parser_version,page_title,stats,raw_path) values($1,$2,now(),200,$3,1,$4,$5::jsonb,$6) on conflict(source_id,content_hash) do update set stats=excluded.stats returning id`,[source.rows[0].id,parsed.sourceUrl,parsed.contentHash,parsed.pageTitle,JSON.stringify(parsed.stats),parsedPath]);
  const runId=run.rows[0].id;
  for (const districtName of parsed.districtOrder) {
    const district=parsed.districts[districtName];
    await client.query(`insert into ingest.extracted_records(crawl_run_id,record_type,source_key,district,raw) values($1,'district',$2,$2,$3::jsonb) on conflict do nothing`,[runId,districtName,JSON.stringify(district)]);
    for (const [kind,schools] of [["primary",district.小学??[]],["middle",district.初中??[]]] as const) {
      for (const school of schools) {
        const key=`${districtName}:${kind}:${school.名称}`;
        const record=await client.query(`insert into ingest.extracted_records(crawl_run_id,record_type,source_key,district,raw) values($1,'school',$2,$3,$4::jsonb) on conflict(crawl_run_id,record_type,source_key) do update set raw=excluded.raw returning id`,[runId,key,districtName,JSON.stringify({...school,sourceSchoolType:kind})]);
        const match=await client.query(`select s.id,s.canonical_name,s.tier,s.lat,s.lng from catalog.schools s join catalog.districts d on d.id=s.district_id where d.canonical_name=$1 and s.school_type=$2 and (s.canonical_name=$3 or exists(select 1 from catalog.school_aliases a where a.school_id=s.id and a.alias=$3)) order by case when s.canonical_name=$3 then 0 else 1 end limit 1`,[normalizeDistrict(districtName),typeFor(kind,school),school.名称]);
        const matched=match.rows[0];
        const candidate=await client.query(`insert into audit.entity_match_candidates(crawl_run_id,source_record_id,entity_type,catalog_entity_id,match_method,match_score,status,explanation) values($1,$2,'school',$3,$4,$5,$6,$7) on conflict(source_record_id,entity_type) do update set catalog_entity_id=excluded.catalog_entity_id,match_method=excluded.match_method,match_score=excluded.match_score,status=excluded.status,explanation=excluded.explanation returning id`,[runId,record.rows[0].id,matched?.id??null,matched?(matched.canonical_name===school.名称?'exact_name':'alias'):'unmatched',matched?1:0,matched?'suggested':'pending',matched?'同区、同学段且名称或别名精确匹配':'未找到严格匹配']);
        if (matched && school.梯队 && matched.tier !== `${school.梯队}梯队`) await client.query(`insert into audit.field_conflicts(match_candidate_id,field_name,current_value,proposed_value) values($1,'tier',$2::jsonb,$3::jsonb) on conflict do nothing`,[candidate.rows[0].id,JSON.stringify(matched.tier),JSON.stringify(`${school.梯队}梯队`)]);
        if (matched && school.lat && school.lng && (matched.lat!==school.lat || matched.lng!==school.lng)) await client.query(`insert into audit.field_conflicts(match_candidate_id,field_name,current_value,proposed_value) values($1,'coordinates',$2::jsonb,$3::jsonb) on conflict do nothing`,[candidate.rows[0].id,JSON.stringify({lat:matched.lat,lng:matched.lng}),JSON.stringify({lat:school.lat,lng:school.lng})]);
      }
    }
  }
  await client.query("COMMIT");
  const summary=await client.query(`select status,count(*)::int from audit.entity_match_candidates where crawl_run_id=$1 group by status order by status`,[runId]);
  const conflicts=await client.query(`select field_name,count(*)::int from audit.field_conflicts f join audit.entity_match_candidates m on m.id=f.match_candidate_id where m.crawl_run_id=$1 group by field_name order by field_name`,[runId]);
  console.log({runId,matches:summary.rows,conflicts:conflicts.rows});
  } catch(error) { await client.query("ROLLBACK"); throw error; } finally { await client.end(); }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
