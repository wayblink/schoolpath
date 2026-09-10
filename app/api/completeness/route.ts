import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

type MetricRow = {
  district: string;
  school_total: string | number;
  school_basic_complete: string | number;
  tier_complete: string | number;
  nature_complete: string | number;
  school_location_complete: string | number;
  schools_with_communities: string | number;
  linked_community_total: string | number;
  community_location_complete: string | number;
  community_coordinate_complete: string | number;
};

type DetailRow = {
  id: number;
  name: string;
  district: string;
  school_type: string;
  basic_complete: boolean;
  tier_complete: boolean;
  nature_complete: boolean;
  school_location_complete: boolean;
  school_communities_complete: boolean;
  community_location_complete: boolean;
  community_coordinate_complete: boolean;
};

type CompletionMetric = {
  total: number;
  complete: number;
  percent: number;
};

type CompletionSummary = {
  district: string;
  schools: CompletionMetric;
  tiers: CompletionMetric;
  schoolNature: CompletionMetric;
  schoolLocation: CompletionMetric;
  schoolCommunities: CompletionMetric;
  communityLocation: CompletionMetric;
  communityPreciseCoordinates: CompletionMetric;
  overall: { percent: number };
};

const EMPTY_VALUES = ["", "待补充", "待核验", "未知", "未入榜/待补充", "-", "—"];
const EMPTY_VALUE_LIST = sql.join(EMPTY_VALUES.map((value) => sql`${value}`), sql`, `);
const QUALITY_TAGS = ["缺基础信息", "缺梯队", "缺性质", "缺学校位置", "缺对口小区", "缺小区位置", "缺精确坐标"];

function toNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function metric(total: number, complete: number): CompletionMetric {
  return {
    total,
    complete,
    percent: total > 0 ? Math.round((complete / total) * 1000) / 10 : 0,
  };
}

async function latestAvailableYear() {
  const rows = await db.execute<{ year: string | number }>(sql`
    select coalesce(max(year), extract(year from current_date)::int)::int as year
    from school_communities
  `);
  return toNumber(rows.rows[0]?.year);
}

function buildSummary(row: MetricRow): CompletionSummary {
  const schoolTotal = toNumber(row.school_total);
  const linkedCommunityTotal = toNumber(row.linked_community_total);

  const summary = {
    district: row.district,
    schools: metric(schoolTotal, toNumber(row.school_basic_complete)),
    tiers: metric(schoolTotal, toNumber(row.tier_complete)),
    schoolNature: metric(schoolTotal, toNumber(row.nature_complete)),
    schoolLocation: metric(schoolTotal, toNumber(row.school_location_complete)),
    schoolCommunities: metric(schoolTotal, toNumber(row.schools_with_communities)),
    communityLocation: metric(linkedCommunityTotal, toNumber(row.community_location_complete)),
    communityPreciseCoordinates: metric(
      linkedCommunityTotal,
      toNumber(row.community_coordinate_complete),
    ),
    overall: { percent: 0 },
  };

  const percents = [
    summary.schools.percent,
    summary.tiers.percent,
    summary.schoolNature.percent,
    summary.schoolLocation.percent,
    summary.schoolCommunities.percent,
    summary.communityLocation.percent,
    summary.communityPreciseCoordinates.percent,
  ];
  summary.overall.percent = Math.round(
    (percents.reduce((sum, percent) => sum + percent, 0) / percents.length) * 10,
  ) / 10;

  return summary;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const district = url.searchParams.get("district")?.trim();
  const yearParam = url.searchParams.get("year");
  const year = yearParam ? Number(yearParam) : await latestAvailableYear();

  if (!Number.isFinite(year)) {
    return NextResponse.json({ error: "invalid year" }, { status: 400 });
  }

  const rows = await db.execute<MetricRow>(sql`
    with school_base as (
      select
        id,
        district,
        name,
        type,
        tier,
        address,
        lat,
        lng,
        attrs,
        school_nature
      from schools
      where ${district ? sql`district = ${district}` : sql`true`}
    ),
    link_by_school as (
      select
        school_id,
        count(*) as link_count
      from school_communities
      where year = ${year}
      group by school_id
    ),
    linked_communities as (
      select distinct
        s.district as school_district,
        c.id as community_id,
        c.amap_address,
        c.source_committee,
        c.lat,
        c.lng
      from school_base s
      inner join school_communities sc on sc.school_id = s.id and sc.year = ${year}
      inner join communities c on c.id = sc.community_id
    ),
    school_stats as (
      select
        district,
        count(*)::int as school_total,
        count(*) filter (
          where nullif(trim(name), '') is not null
            and nullif(trim(district), '') is not null
            and type is not null
        )::int as school_basic_complete,
        count(*) filter (
          where nullif(trim(coalesce(tier, '')), '') is not null
            and coalesce(tier, '') not in (${EMPTY_VALUE_LIST})
        )::int as tier_complete,
        count(*) filter (
          where school_nature is not null
        )::int as nature_complete,
        count(*) filter (
          where nullif(trim(coalesce(address, '')), '') is not null
            and coalesce(address, '') not in (${EMPTY_VALUE_LIST})
            and lat is not null
            and lng is not null
        )::int as school_location_complete,
        count(*) filter (where coalesce(l.link_count, 0) > 0)::int as schools_with_communities
      from school_base s
      left join link_by_school l on l.school_id = s.id
      group by district
    ),
    community_stats as (
      select
        school_district as district,
        count(*)::int as linked_community_total,
        count(*) filter (
          where (nullif(trim(coalesce(amap_address, '')), '') is not null and coalesce(amap_address, '') not in (${EMPTY_VALUE_LIST}))
             or (nullif(trim(coalesce(source_committee, '')), '') is not null and coalesce(source_committee, '') not in (${EMPTY_VALUE_LIST}))
        )::int as community_location_complete,
        count(*) filter (where lat is not null and lng is not null)::int as community_coordinate_complete
      from linked_communities
      group by school_district
    )
    select
      s.district,
      s.school_total,
      s.school_basic_complete,
      s.tier_complete,
      s.nature_complete,
      s.school_location_complete,
      s.schools_with_communities,
      coalesce(c.linked_community_total, 0)::int as linked_community_total,
      coalesce(c.community_location_complete, 0)::int as community_location_complete,
      coalesce(c.community_coordinate_complete, 0)::int as community_coordinate_complete
    from school_stats s
    left join community_stats c on c.district = s.district
    order by s.district
  `);

  const detailRows = await db.execute<DetailRow>(sql`
    select
      s.id,
      s.name,
      s.district,
      s.type::text as school_type,
      (nullif(trim(s.name), '') is not null and nullif(trim(s.district), '') is not null and s.type is not null) as basic_complete,
      (nullif(trim(coalesce(s.tier, '')), '') is not null and coalesce(s.tier, '') not in (${EMPTY_VALUE_LIST})) as tier_complete,
      (s.school_nature is not null) as nature_complete,
      (nullif(trim(coalesce(s.address, '')), '') is not null and coalesce(s.address, '') not in (${EMPTY_VALUE_LIST}) and s.lat is not null and s.lng is not null) as school_location_complete,
      (count(sc.id) > 0) as school_communities_complete,
      (count(sc.id) > 0 and bool_and(
        (nullif(trim(coalesce(c.amap_address, '')), '') is not null and coalesce(c.amap_address, '') not in (${EMPTY_VALUE_LIST}))
        or (nullif(trim(coalesce(c.source_committee, '')), '') is not null and coalesce(c.source_committee, '') not in (${EMPTY_VALUE_LIST}))
      )) as community_location_complete,
      (count(sc.id) > 0 and bool_and(c.lat is not null and c.lng is not null)) as community_coordinate_complete
    from public.schools s
    left join public.school_communities sc on sc.school_id = s.id and sc.year = ${year}
    left join public.communities c on c.id = sc.community_id
    where ${district ? sql`s.district = ${district}` : sql`true`}
    group by s.id,s.name,s.district,s.type,s.tier,s.school_nature,s.address,s.lat,s.lng
    order by s.district,s.name,s.id
  `);

  const districts = rows.rows.map(buildSummary);
  const cityRow: MetricRow = {
    district: district ?? "全市",
    school_total: districts.reduce((sum, item) => sum + item.schools.total, 0),
    school_basic_complete: districts.reduce((sum, item) => sum + item.schools.complete, 0),
    tier_complete: districts.reduce((sum, item) => sum + item.tiers.complete, 0),
    nature_complete: districts.reduce((sum, item) => sum + item.schoolNature.complete, 0),
    school_location_complete: districts.reduce((sum, item) => sum + item.schoolLocation.complete, 0),
    schools_with_communities: districts.reduce((sum, item) => sum + item.schoolCommunities.complete, 0),
    linked_community_total: districts.reduce((sum, item) => sum + item.communityLocation.total, 0),
    community_location_complete: districts.reduce((sum, item) => sum + item.communityLocation.complete, 0),
    community_coordinate_complete: districts.reduce(
      (sum, item) => sum + item.communityPreciseCoordinates.complete,
      0,
    ),
  };

  const details = detailRows.rows.map((row) => {
    const checks = [
      row.basic_complete,
      row.tier_complete,
      row.nature_complete,
      row.school_location_complete,
      row.school_communities_complete,
      row.community_location_complete,
      row.community_coordinate_complete,
    ];
    return {
      id: row.id,
      name: row.name,
      district: row.district === "浦东" ? "浦东新区" : `${row.district}区`,
      type: row.school_type,
      percent: Math.round((checks.filter(Boolean).length / checks.length) * 100),
      missingTags: QUALITY_TAGS.filter((_, index) => !checks[index]),
    };
  });

  return NextResponse.json({
    year,
    city: buildSummary(cityRow),
    districts,
    availableTags: QUALITY_TAGS,
    details,
  });
}
