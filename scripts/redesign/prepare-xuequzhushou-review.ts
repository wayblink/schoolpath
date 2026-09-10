import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { extractCommitteeRelations, isSafeSchoolMatch, normalizeSchoolName, schoolNameSimilarity, type ParsedXuequzhushou, type SourceSchool } from "../../lib/ingest/xuequzhushou";
import { loadLocalEnv } from "../load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const parsedPath = process.argv.find((arg) => arg.startsWith("--parsed="))?.slice(9);
if (!parsedPath) throw new Error("--parsed=<path> is required");
const parsed = JSON.parse(readFileSync(path.resolve(parsedPath), "utf8")) as ParsedXuequzhushou;
const client = new pg.Client({ connectionString: databaseUrl });
const normalizeDistrict = (name: string) => name === "浦东新区" ? "浦东" : name.replace(/区$/, "");
const typeFor = (kind: "primary" | "middle", school: SourceSchool) => school.名称.includes("九年一贯") ? "nine_year" : kind;

type CatalogSchool = { id: string; canonical_name: string; alias: string | null };

async function bestSchoolMatch(district: string, schoolType: string, sourceName: string) {
  const { rows } = await client.query<CatalogSchool>(`
    select s.id, s.canonical_name, a.alias
    from catalog.schools s
    join catalog.districts d on d.id=s.district_id
    left join catalog.school_aliases a on a.school_id=s.id
    where d.canonical_name=$1 and s.school_type=$2
  `, [district, schoolType]);
  const bySchool = new Map<string, { id: string; canonicalName: string; score: number; method: string }>();
  for (const row of rows) {
    const candidateName = row.alias ?? row.canonical_name;
    const score = schoolNameSimilarity(sourceName, candidateName);
    const current = bySchool.get(row.id);
    if (!current || score > current.score) {
      bySchool.set(row.id, {
        id: row.id,
        canonicalName: row.canonical_name,
        score,
        method: normalizeSchoolName(sourceName) === normalizeSchoolName(candidateName)
          ? row.alias ? "normalized_alias" : "normalized_name"
          : row.alias ? "fuzzy_alias" : "fuzzy_name",
      });
    }
  }
  return [...bySchool.values()].sort((a, b) => b.score - a.score)[0];
}

async function main() {
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(readFileSync(path.join(process.cwd(), "db/redesign/002_create_relation_review.sql"), "utf8").replace(/^BEGIN;|COMMIT;$/gm, ""));
    const { rows: runs } = await client.query<{ id: string }>(
      `select id from ingest.crawl_runs where content_hash=$1 order by id desc limit 1`,
      [parsed.contentHash],
    );
    const runId = runs[0]?.id;
    if (!runId) throw new Error("crawl run not found; run redesign:load-source first");

    for (const districtName of parsed.districtOrder) {
      const district = parsed.districts[districtName];
      for (const [kind, schools] of [["primary", district.小学 ?? []], ["middle", district.初中 ?? []]] as const) {
        for (const school of schools) {
          const sourceKey = `${districtName}:${kind}:${school.名称}`;
          const { rows: records } = await client.query<{ id: string }>(
            `select id from ingest.extracted_records where crawl_run_id=$1 and record_type='school' and source_key=$2`,
            [runId, sourceKey],
          );
          if (!records[0]) continue;
          const best = await bestSchoolMatch(normalizeDistrict(districtName), typeFor(kind, school), school.名称);
          const score = best?.score ?? 0;
          const safeMatch = isSafeSchoolMatch(score);
          const status = safeMatch ? "suggested" : "pending";
          await client.query(`
            update audit.entity_match_candidates
            set catalog_entity_id=$2, match_method=$3, match_score=$4, status=$5,
                explanation=$6
            where source_record_id=$1 and entity_type='school' and status <> 'accepted'
          `, [records[0].id, safeMatch ? best?.id ?? null : null, best?.method ?? "unmatched", score, status,
            best ? `最佳候选：${best.canonicalName}，规范化相似度 ${score.toFixed(4)}` : "未找到同区同学段候选"]);
        }
      }
    }

    for (const relation of extractCommitteeRelations(parsed)) {
      const raw = JSON.stringify(relation);
      const { rows: records } = await client.query<{ id: string }>(`
        insert into ingest.extracted_records(crawl_run_id,record_type,source_key,district,raw)
        values($1,'school_community_relation',$2,$3,$4::jsonb)
        on conflict(crawl_run_id,record_type,source_key) do update set raw=excluded.raw
        returning id
      `, [runId, relation.sourceKey, relation.district, raw]);
      const { rows: matches } = await client.query<{ id: string; catalog_entity_id: string | null; match_score: string }>(`
        select m.id,m.catalog_entity_id,m.match_score
        from audit.entity_match_candidates m
        join ingest.extracted_records r on r.id=m.source_record_id
        where m.crawl_run_id=$1 and m.entity_type='school'
          and r.source_key=$2 and m.status='suggested'
      `, [runId, `${relation.district}:primary:${relation.schoolName}`]);
      const schoolMatch = matches[0];
      const { rows: communities } = await client.query<{ id: string }>(`
        select c.id from catalog.communities c
        join catalog.districts d on d.id=c.district_id
        where d.canonical_name=$1 and (c.committee_name=$2 or c.name=$2)
        order by case when c.committee_name=$2 then 0 else 1 end, c.id
        limit 2
      `, [normalizeDistrict(relation.district), relation.committeeName]);
      const uniqueCommunity = communities.length === 1 ? communities[0] : null;
      await client.query(`
        insert into audit.school_community_relation_candidates(
          crawl_run_id,source_record_id,school_match_candidate_id,catalog_school_id,catalog_community_id,
          district,school_name_raw,committee_name_raw,area,street,school_match_score,
          community_match_method,community_match_score,review_status
        ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
        on conflict(source_record_id) do update set
          school_match_candidate_id=excluded.school_match_candidate_id,
          catalog_school_id=excluded.catalog_school_id,
          catalog_community_id=excluded.catalog_community_id,
          school_match_score=excluded.school_match_score,
          community_match_method=excluded.community_match_method,
          community_match_score=excluded.community_match_score
      `, [runId, records[0].id, schoolMatch?.id ?? null, schoolMatch?.catalog_entity_id ?? null,
        uniqueCommunity?.id ?? null, relation.district, relation.schoolName, relation.committeeName,
        relation.area ?? null, relation.street ?? null, Number(schoolMatch?.match_score ?? 0),
        uniqueCommunity ? "district_committee_exact" : communities.length > 1 ? "ambiguous_exact" : "unmatched",
        uniqueCommunity ? 1 : 0]);
    }
    await client.query("COMMIT");
    const { rows: summary } = await client.query(`
      select
        (select count(*)::int from ingest.extracted_records where crawl_run_id=$1 and record_type='school_community_relation') extracted_relations,
        (select count(*)::int from audit.entity_match_candidates where crawl_run_id=$1 and status='suggested') suggested_schools,
        (select count(*)::int from audit.entity_match_candidates where crawl_run_id=$1 and status='pending') pending_schools,
        (select count(*)::int from audit.school_community_relation_candidates where crawl_run_id=$1 and catalog_school_id is not null) relations_with_school,
        (select count(*)::int from audit.school_community_relation_candidates where crawl_run_id=$1 and catalog_community_id is not null) relations_with_community
    `, [runId]);
    console.table(summary);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
