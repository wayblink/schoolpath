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
  const rows = await query<{schools:number;communities:number;assignments:number;policies:number}>(`
    select
      (select count(*)::int from public.schools s where ${districtExpression("s.district")} = any($1::text[])) schools,
      (select count(*)::int from public.communities c where ${districtExpression("c.district")} = any($1::text[])) communities,
      (select count(*)::int from public.school_communities a join public.schools s on s.id=a.school_id where ${districtExpression("s.district")} = any($1::text[])) assignments,
      (select count(*)::int from public.policy_documents p left join public.districts d on d.id=p.district_id left join public.schools s on s.id=p.public_school_id where coalesce(d.canonical_name,${districtExpression("s.district")}) = any($1::text[]) and (s.id is null or ${districtExpression("s.district")} = any($1::text[]))) policies

  `, [PRODUCT_DISTRICTS]);
  return rows[0];
}

async function getFullOverview() {
  const rows = await query<{schools:number;communities:number;assignments:number;policies:number}>(`
    select
      (select count(*)::int from public.schools) schools,
      (select count(*)::int from public.communities) communities,
      (select count(*)::int from public.school_communities) assignments,
      (select count(*)::int from public.policy_documents) policies

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
export type SchoolPathway = {
  id:number;primaryId:number;primaryName:string;primaryTier:number|null;
  middleId:number|null;middleName:string|null;middleTier:number|null;
  district:string;area:string|null;admissionMode:string;modeLabel:string;
  rawText:string|null;sourceName:string|null;
};
const MODE_LABELS:Record<string,string>={assign:"对口",placement:"派位",direct:"直升",partial:"部分对口",unknown:"待识别"};
export async function getPathways(filters:{district?:string;mode?:string;limit?:number}={}) {
  const values:unknown[]=[];
  const where:string[]=[];
  addProductDistrictFilter(where, values, "p.district", filters.district);
  if(filters.mode){values.push(filters.mode);where.push(`w.admission_mode=$${values.length}`);}
  values.push(boundedLimit(filters.limit,300,1000));
  return query<SchoolPathway>(`
    select w.id,p.id "primaryId",p.name "primaryName",p.source_tier "primaryTier",
      m.id "middleId",m.name "middleName",m.source_tier "middleTier",
      ${displayDistrictExpression("p.district")} district,p.area,w.admission_mode "admissionMode",
      w.raw_text "rawText",w.source_name "sourceName"
    from public.school_pathways w
    join public.schools p on p.id=w.primary_school_id
    left join public.schools m on m.id=w.middle_school_id
    where ${where.join(" and ")}
    order by ${districtExpression("p.district")},p.source_tier nulls last,p.name,w.admission_mode,m.name
    limit $${values.length}
  `,values).then(rows=>rows.map(r=>({...r,modeLabel:MODE_LABELS[r.admissionMode]??r.admissionMode})));
}

/** 学校详情页双向查询：小学查下游初中，初中查上游生源小学。 */
export async function getSchoolPathways(schoolId:number) {
  if (!Number.isInteger(schoolId) || schoolId <= 0) return { downstream: [], upstream: [] };
  const rows = await query<Omit<SchoolPathway,"district"|"area"|"modeLabel">>(`
    select w.id,p.id "primaryId",p.name "primaryName",p.source_tier "primaryTier",
      m.id "middleId",m.name "middleName",m.source_tier "middleTier",
      w.admission_mode "admissionMode",w.raw_text "rawText",w.source_name "sourceName"
    from public.school_pathways w
    join public.schools p on p.id=w.primary_school_id
    left join public.schools m on m.id=w.middle_school_id
    where w.primary_school_id=$1 or w.middle_school_id=$1
    order by w.admission_mode,m.name
  `,[schoolId]);
  const map = (r: typeof rows[number]) => ({...r, modeLabel: MODE_LABELS[r.admissionMode]??r.admissionMode});
  return {
    downstream: rows.filter(r=>r.primaryId===schoolId).map(map),
    upstream: rows.filter(r=>r.middleId===schoolId).map(map),
  };
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
  return { overview: await getFullOverview() };
}

// ── 质量队列：实体匹配候选（R3）──
export type MatchCandidateRow = {
  id:number;status:string;matchMethod:string;matchScore:number;
  sourceName:string|null;catalogEntityId:number|null;explanation:string|null;
  schoolId:number|null;publicSchoolName:string|null;totalCount:number;
};
