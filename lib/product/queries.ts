import pg from "pg";
import type { QueryResultRow } from "pg";
import { PRODUCT_DISTRICTS, normalizeProductDistrict } from "./districts";
export { PRODUCT_DISTRICTS, normalizeProductDistrict } from "./districts";
export type { ProductDistrict } from "./districts";

function databaseUrl() {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is required");
  return value;
}

function districtExpression(column: string) {
  return `case when ${column}='浦东新区' then '浦东' else regexp_replace(${column},'区$','') end`;
}

function displayDistrictExpression(column: string) {
  const canonical = districtExpression(column);
  return `case when ${canonical}='浦东' then '浦东新区' else ${canonical}||'区' end`;
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number) {
  return Number.isFinite(value) ? Math.min(Math.max(value ?? fallback, 1), maximum) : fallback;
}

function addProductDistrictFilter(
  where: string[],
  values: unknown[],
  column: string,
  requested?: string | null,
) {
  const normalized = requested ? normalizeProductDistrict(requested) : null;
  if (requested?.trim() && !normalized) {
    values.push([]);
    where.push(`${districtExpression(column)} = any($${values.length}::text[])`);
    return;
  }
  values.push(normalized ? [normalized] : PRODUCT_DISTRICTS);
  where.push(`${districtExpression(column)} = any($${values.length}::text[])`);
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 4 });
  try { return (await pool.query<T>(text, values)).rows; } finally { await pool.end(); }
}

export async function getOverview() {
  const rows = await query<{schools:number;communities:number;assignments:number;policies:number;pending_matches:number;conflicts:number}>(`
    select
      (select count(*)::int from public.schools s where ${districtExpression("s.district")} = any($1::text[])) schools,
      (select count(*)::int from public.communities c where ${districtExpression("c.district")} = any($1::text[])) communities,
      (select count(*)::int from public.school_communities a join public.schools s on s.id=a.school_id where ${districtExpression("s.district")} = any($1::text[])) assignments,
      (select count(*)::int from public.policy_documents p left join public.districts d on d.id=p.district_id left join public.schools s on s.id=p.public_school_id where coalesce(d.canonical_name,${districtExpression("s.district")}) = any($1::text[]) and (s.id is null or ${districtExpression("s.district")} = any($1::text[]))) policies,
      (select count(*)::int from public.entity_match_candidates c join public.schools s on s.id=c.public_school_id where c.status='pending' and ${districtExpression("s.district")} = any($1::text[])) pending_matches,
      (select count(*)::int from public.field_conflicts f join public.entity_match_candidates c on c.id=f.match_candidate_id join public.schools s on s.id=c.public_school_id where f.status='pending' and ${districtExpression("s.district")} = any($1::text[])) conflicts
  `, [PRODUCT_DISTRICTS]);
  return rows[0];
}

async function getFullOverview() {
  const rows = await query<{schools:number;communities:number;assignments:number;policies:number;pending_matches:number;conflicts:number}>(`
    select
      (select count(*)::int from public.schools) schools,
      (select count(*)::int from public.communities) communities,
      (select count(*)::int from public.school_communities) assignments,
      (select count(*)::int from public.policy_documents) policies,
      (select count(*)::int from public.entity_match_candidates where status='pending') pending_matches,
      (select count(*)::int from public.field_conflicts where status='pending') conflicts,
  `);
  return rows[0];
}

export type ProductSchool = {id:number;name:string;district:string;type:string;nature:string|null;tier:number|null;tierLabel:string|null;address:string|null;lat:number|null;lng:number|null;area:string|null;street:string|null;feederMiddleSchool:string|null;middleSchoolTier:number|null;evaluation:string|null;admissionMode:string|null;classCount:number|null;tags:string[];sourceName:string|null;sourceUrl:string|null;sourceYear:number|null;relationCount:number;communityCount:number;policyCount:number};
export async function getSchools(filters: {district?:string;type?:string;tier?:string;q?:string;limit?:number} = {}) {
  const values: unknown[]=[]; const where:string[]=[];
  const add=(sql:string,value:unknown)=>{values.push(value);where.push(sql.replace("?",`$${values.length}`));};
  addProductDistrictFilter(where, values, "s.district", filters.district);
  if(filters.type) add("s.type::text=?",filters.type);
  if(filters.tier) {
    const tier = Number(filters.tier);
    if (Number.isInteger(tier)) add("s.source_tier=?", tier);
    else where.push("false");
  }
  if(filters.q){values.push(filters.q);where.push(`(s.name ilike '%'||$${values.length}||'%' or exists(select 1 from unnest(coalesce(s.aliases,array[]::text[])) alias where alias ilike '%'||$${values.length}||'%') or coalesce(s.area,s.street,s.evaluation,'') ilike '%'||$${values.length}||'%')`)}
  const limit=boundedLimit(filters.limit,500,2500);values.push(limit);
  return query<ProductSchool>(`
    select s.id,s.name,${displayDistrictExpression("s.district")} district,s.type::text type,s.school_nature::text nature,
      s.source_tier tier,s.tier "tierLabel",s.address,s.lat,s.lng,s.area,s.street,s.feeder_middle_school "feederMiddleSchool",
      s.middle_school_tier "middleSchoolTier",s.evaluation,s.admission_mode "admissionMode",s.class_count "classCount",
      coalesce(s.tags,'[]'::jsonb) tags,s.source_name "sourceName",s.source_url "sourceUrl",s.source_year "sourceYear",
      (select count(*)::int from public.school_communities a where a.school_id=s.id) "relationCount",
      (select count(*)::int from public.school_communities a where a.school_id=s.id) "communityCount",
      (select count(*)::int from public.policy_documents p left join public.districts d on d.id=p.district_id where p.public_school_id=s.id and (d.canonical_name is null or d.canonical_name = ${districtExpression("s.district")})) "policyCount"
    from public.schools s
    ${where.length?`where ${where.join(" and ")}`:""}
    order by s.district,s.type,s.source_tier nulls last,s.name
    limit $${values.length}
  `,values);
}

export async function getSchoolById(id:number){
  if (!Number.isInteger(id) || id <= 0) return null;
  const rows=await query<ProductSchool>(`
  select s.id,s.name,${displayDistrictExpression("s.district")} district,s.type::text type,s.school_nature::text nature,
    s.source_tier tier,s.tier "tierLabel",s.address,s.lat,s.lng,s.area,s.street,s.feeder_middle_school "feederMiddleSchool",
    s.middle_school_tier "middleSchoolTier",s.evaluation,s.admission_mode "admissionMode",s.class_count "classCount",
    coalesce(s.tags,'[]'::jsonb) tags,s.source_name "sourceName",s.source_url "sourceUrl",s.source_year "sourceYear",
    (select count(*)::int from public.school_communities a where a.school_id=s.id) "relationCount",
    (select count(*)::int from public.school_communities a where a.school_id=s.id) "communityCount",
    (select count(*)::int from public.policy_documents p left join public.districts d on d.id=p.district_id where p.public_school_id=s.id and (d.canonical_name is null or d.canonical_name = ${districtExpression("s.district")})) "policyCount"
  from public.schools s where s.id=$1 and ${districtExpression("s.district")} = any($2::text[])`,[id,PRODUCT_DISTRICTS]);return rows[0]??null
}

export async function getSchoolDistrictSummary(){return query<{district:string;admissionSystem:string|null;schoolCount:number;primaryCount:number;middleCount:number;tierOneCount:number;relationCount:number;coordinateCount:number}>(`
  select ${displayDistrictExpression("s.district")} district,
    (array_agg(s.attrs->>'districtAdmissionSystem') filter(where s.attrs->>'districtAdmissionSystem' is not null))[1] "admissionSystem",
    count(*)::int "schoolCount",count(*) filter(where s.type='primary')::int "primaryCount",
    count(*) filter(where s.type='middle')::int "middleCount",count(*) filter(where s.source_tier=1)::int "tierOneCount",
    (select count(*)::int from public.school_communities a where a.school_id in (select x.id from public.schools x where ${districtExpression("x.district")} = ${districtExpression("s.district")})) "relationCount",
    count(*) filter(where s.lng is not null and s.lat is not null)::int "coordinateCount"
  from public.schools s where ${districtExpression("s.district")} = any($1::text[]) group by s.district order by s.district`,[PRODUCT_DISTRICTS])}

export type SchoolDistrictRelation = {
  id:number;district:string;schoolName:string;schoolType:string|null;committeeName:string;
  area:string|null;street:string|null;schoolId:number|null;catalogSchoolId:number|null;catalogCommunityId:number|null;
  matchStatus:string;reviewStatus:string;verified:boolean;sourceYear:number|null;sourceName:string;
  sourceUrl:string|null;officialAreaLevel:string|null;residentialPoi:boolean|null;
};
export async function getPathways(filters:{district?:string;limit?:number}={}) {
  const values:unknown[]=[];
  const where:string[]=[`sp.feeder_middle_school is not null`,`trim(sp.feeder_middle_school)<>''`];
  addProductDistrictFilter(where, values, "sp.district", filters.district);
  const districtParam = values.length;
  where.push(`(sm.id is null or ${districtExpression("sm.district")} = any($${districtParam}::text[]))`);
  values.push(boundedLimit(filters.limit,300,1000));
  return query<{primaryId:number|null;primaryName:string;primaryTier:number|null;middleId:number|null;middleName:string;middleTier:number|null;district:string;area:string|null;mode:string|null;reviewStatus:string|null;catalogSchoolId:number|null}>(`
    select sp.id "primaryId",sp.name "primaryName",sp.source_tier "primaryTier",sm.id "middleId",
      sp.feeder_middle_school "middleName",sm.source_tier "middleTier",
      ${displayDistrictExpression("sp.district")} district,sp.area,sp.admission_mode mode,
      NULL::text "reviewStatus",sp.id "catalogSchoolId"
    from public.schools sp
    left join lateral (
      select school.id,school.district,school.source_tier from public.schools school
      where school.district=${districtExpression("sp.district")}
        and school.name=sp.feeder_middle_school
      order by (school.source_key is not null) desc,school.id
      limit 1
    ) sm on true
    where ${where.join(" and ")}
    order by ${districtExpression("sp.district")},sp.source_tier nulls last,sp.name
    limit $${values.length}
  `,values);
}

export type ProductPolicy = {
  id:number;
  type:"district"|"school";
  typeLabel:string;
  district:string;
  year:number;
  title:string;
  schoolName:string|null;
  schoolType:string|null;
  sourceUrl:string|null;
  content:string;
};

export async function getPolicies() {
  return query<ProductPolicy>(`
    select p.id,
      case when p.public_school_id is null then 'district' else 'school' end "type",
      case p.scope::text when 'district' then '区级政策' when 'school' then '学校招生记录' else p.scope::text end "typeLabel",
      ${displayDistrictExpression(`coalesce(d.canonical_name,s.district)`)} district,
      p.year,
      p.title,
      s.name "schoolName",
      s.type::text "schoolType",
      p.source_url "sourceUrl",
      p.content
    from public.policy_documents p
    left join public.districts d on d.id=p.district_id
    left join public.schools s on s.id=p.public_school_id
    where ${districtExpression("coalesce(d.canonical_name,s.district)")} = any($1::text[])
      and (s.id is null or ${districtExpression("s.district")} = any($1::text[]))
    order by p.year desc,case when p.public_school_id is null then 1 else 2 end,coalesce(d.canonical_name,s.district),s.name nulls first,p.id
  `, [PRODUCT_DISTRICTS]);
}

export async function getOpsSummary() {
  const [overview,matches,conflicts]=await Promise.all([
    getFullOverview(),
    query(`select status,count(*)::int from public.entity_match_candidates group by status order by status`),
    query(`select field_name "fieldName",status,count(*)::int from public.field_conflicts group by field_name,status order by field_name,status`),
  ]);
  return { overview, matches, conflicts };
}

// ── 质量队列：实体匹配候选（R3）──
export type MatchCandidateRow = {
  id:number;status:string;matchMethod:string;matchScore:number;
  sourceName:string|null;catalogEntityId:number|null;explanation:string|null;
  schoolId:number|null;publicSchoolName:string|null;totalCount:number;
};
export async function listMatchCandidates(filters:{status?:string;page?:number;pageSize?:number}={}) {
  const values:unknown[]=[];const where:string[]=[];
  if(filters.status){values.push(filters.status);where.push(`m.status=$${values.length}`)}
  const pageSize=Math.min(Math.max(filters.pageSize??30,1),100);
  const page=Math.max(filters.page??1,1);
  values.push(pageSize);const limitParam=values.length;
  values.push((page-1)*pageSize);const offsetParam=values.length;
  const rows=await query<MatchCandidateRow>(`
    select m.id,m.status,m.match_method "matchMethod",m.match_score::float "matchScore",
      coalesce(e.raw->>'名称',e.raw->>'name') "sourceName",m.catalog_entity_id "catalogEntityId",m.explanation,
      m.public_school_id "schoolId",s.name "publicSchoolName",
      count(*) over()::int "totalCount"
    from public.entity_match_candidates m
    left join ingest.extracted_records e on e.id=m.source_record_id
    left join public.schools s on s.id=m.public_school_id
    ${where.length?`where ${where.join(" and ")}`:""}
    order by m.match_score desc,m.id
    limit $${limitParam} offset $${offsetParam}
  `,values);
  return { candidates: rows, total: rows[0]?.totalCount ?? 0, page, pageSize };
}

// ── 质量队列：字段冲突（R3）──
export type FieldConflictRow = {
  id:number;fieldName:string;currentValue:unknown;proposedValue:unknown;status:string;
  schoolId:number|null;publicSchoolName:string|null;totalCount:number;
};
export async function listFieldConflicts(filters:{fieldName?:string;status?:string;page?:number;pageSize?:number}={}) {
  const values:unknown[]=[];const where:string[]=[];
  if(filters.fieldName){values.push(filters.fieldName);where.push(`f.field_name=$${values.length}`)}
  if(filters.status){values.push(filters.status);where.push(`f.status=$${values.length}`)}
  const pageSize=Math.min(Math.max(filters.pageSize??30,1),100);
  const page=Math.max(filters.page??1,1);
  values.push(pageSize);const limitParam=values.length;
  values.push((page-1)*pageSize);const offsetParam=values.length;
  const rows=await query<FieldConflictRow>(`
    select f.id,f.field_name "fieldName",f.current_value "currentValue",f.proposed_value "proposedValue",f.status,
      m.public_school_id "schoolId",s.name "publicSchoolName",
      count(*) over()::int "totalCount"
    from public.field_conflicts f
    left join public.entity_match_candidates m on m.id=f.match_candidate_id
    left join public.schools s on s.id=m.public_school_id
    ${where.length?`where ${where.join(" and ")}`:""}
    order by f.field_name,f.id
    limit $${limitParam} offset $${offsetParam}
  `,values);
  return { conflicts: rows, total: rows[0]?.totalCount ?? 0, page, pageSize };
}

/** 处理实体匹配候选：confirm=确认来源名与关联学校一致（status→accepted），reject=不匹配（status→rejected）。 */
export async function reviewMatchCandidate(id:number,action:"confirm"|"reject",note?:string) {
  if(!Number.isInteger(id)||id<=0) throw new Error("invalid candidate id");
  if(action!=="confirm"&&action!=="reject") throw new Error("action must be confirm or reject");
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const {rows}=await client.query(`select * from public.entity_match_candidates where id=$1 for update`,[id]);
    const current=rows[0];
    if(!current){await client.query("rollback");return null}
    if(current.status==="accepted"||current.status==="rejected") throw new Error("candidate was already reviewed");
    const {rows:updated}=await client.query(
      `update public.entity_match_candidates
       set status=$2,explanation=coalesce($3,explanation),reviewed_at=now()
       where id=$1
       returning id,status,reviewed_at "reviewedAt"`,
      [id,action==="confirm"?"accepted":"rejected",note??null],
    );
    await client.query("commit");
    return updated[0];
  } catch(error) {await client.query("rollback").catch(()=>{});throw error} finally {client.release();await pool.end()}
}

/** 处理字段冲突：keep_current=保留产品层现值（status→resolved_keep_current），take_source=采纳来源值（status→resolved_take_source）。
 *  仅记录裁决（current/proposed 两值留在行内备查），不改写 public.schools——产品层字段变更走发布批次。 */
export async function reviewFieldConflict(id:number,action:"keep_current"|"take_source",note?:string) {
  if(!Number.isInteger(id)||id<=0) throw new Error("invalid conflict id");
  if(action!=="keep_current"&&action!=="take_source") throw new Error("action must be keep_current or take_source");
  const pool = new pg.Pool({ connectionString: databaseUrl(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const {rows}=await client.query(`select * from public.field_conflicts where id=$1 for update`,[id]);
    const current=rows[0];
    if(!current){await client.query("rollback");return null}
    if(current.status!=="pending") throw new Error("conflict was already reviewed");
    const {rows:updated}=await client.query(
      `update public.field_conflicts
       set status=$2,resolution_note=$3
       where id=$1
       returning id,status,resolution_note "resolutionNote"`,
      [id,action==="keep_current"?"resolved_keep_current":"resolved_take_source",note??null],
    );
    await client.query("commit");
    return updated[0];
  } catch(error) {await client.query("rollback").catch(()=>{});throw error} finally {client.release();await pool.end()}
}

