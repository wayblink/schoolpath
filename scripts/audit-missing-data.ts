/**
 * Read-only audit for citywide missing data.
 *
 * This script does not mutate anything. It mirrors /api/completeness so large
 * data operations start with visible row counts and API-equivalent gaps.
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const requestedYear = numberArg("--year");
const district = valueArg("--district");
const jsonOnly = process.argv.includes("--json");
const showAllDetails = process.argv.includes("--all");
const detailLimit = showAllDetails ? undefined : (numberArg("--detail-limit") ?? 50);

const EMPTY_VALUES = ["", "待补充", "待核验", "未知", "未入榜/待补充", "-", "—"];

const SUMMARY_SQL = `
  WITH school_base AS (
    SELECT
      id,
      district,
      name,
      type,
      tier,
      address,
      lat,
      lng,
      school_nature,
      enrollment_note,
      attrs
    FROM schools
    WHERE ($1::text IS NULL OR district = $1)
  ),
  link_by_school AS (
    SELECT
      school_id,
      count(*) AS link_count
    FROM school_communities
    WHERE year = $3
    GROUP BY school_id
  ),
  source_by_school AS (
    SELECT school_id, count(*) AS source_count
    FROM web_data_source
    GROUP BY school_id
  ),
  linked_communities AS (
    SELECT DISTINCT
      s.district AS school_district,
      c.id AS community_id,
      c.amap_address,
      c.source_committee,
      c.lat,
      c.lng
    FROM school_base s
    INNER JOIN school_communities sc ON sc.school_id = s.id AND sc.year = $3
    INNER JOIN communities c ON c.id = sc.community_id
  ),
  school_stats AS (
    SELECT
      district,
      count(*)::int AS school_total,
      count(*) FILTER (
        WHERE nullif(trim(name), '') IS NOT NULL
          AND nullif(trim(district), '') IS NOT NULL
          AND type IS NOT NULL
      )::int AS school_basic_complete,
      count(*) FILTER (
        WHERE nullif(trim(coalesce(tier, '')), '') IS NOT NULL
          AND coalesce(tier, '') NOT IN (SELECT unnest($2::text[]))
      )::int AS tier_complete,
      count(*) FILTER (
        WHERE school_nature IS NOT NULL
      )::int AS nature_complete,
      count(*) FILTER (
        WHERE nullif(trim(coalesce(enrollment_note, '')), '') IS NOT NULL
          AND coalesce(enrollment_note, '') NOT IN (SELECT unnest($2::text[]))
      )::int AS enrollment_note_complete,
      count(*) FILTER (
        WHERE nullif(trim(coalesce(address, '')), '') IS NOT NULL
          AND coalesce(address, '') NOT IN (SELECT unnest($2::text[]))
          AND lat IS NOT NULL
          AND lng IS NOT NULL
      )::int AS school_location_complete,
      count(*) FILTER (WHERE coalesce(l.link_count, 0) > 0)::int AS schools_with_communities,
      count(*) FILTER (WHERE coalesce(src.source_count, 0) > 0)::int AS schools_with_sources
    FROM school_base s
    LEFT JOIN link_by_school l ON l.school_id = s.id
    LEFT JOIN source_by_school src ON src.school_id = s.id
    GROUP BY district
  ),
  community_stats AS (
    SELECT
      school_district AS district,
      count(*)::int AS linked_community_total,
      count(*) FILTER (
        WHERE (nullif(trim(coalesce(amap_address, '')), '') IS NOT NULL AND coalesce(amap_address, '') NOT IN (SELECT unnest($2::text[])))
           OR (nullif(trim(coalesce(source_committee, '')), '') IS NOT NULL AND coalesce(source_committee, '') NOT IN (SELECT unnest($2::text[])))
      )::int AS community_location_complete,
      count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int AS community_coordinate_complete
    FROM linked_communities
    GROUP BY school_district
  ),
  assignment_stats AS (
    SELECT
      s.district,
      count(*)::int AS assignment_total,
      count(*) FILTER (WHERE sc.verified)::int AS verified_assignments
    FROM school_communities sc
    JOIN school_base s ON s.id = sc.school_id
    WHERE sc.year = $3
    GROUP BY s.district
  ),
  feeder_stats AS (
    SELECT
      d.canonical_name AS district,
      count(*)::int AS feeder_total,
      count(*) FILTER (WHERE f.review_status IN ('accepted', 'published', 'verified'))::int AS reviewed_feeders
    FROM catalog.school_feeder_relations f
    JOIN catalog.schools cs ON cs.id = f.from_school_id
    JOIN catalog.districts d ON d.id = cs.district_id
    WHERE ($1::text IS NULL OR d.canonical_name = $1)
    GROUP BY d.canonical_name
  ),
  policy_stats AS (
    SELECT
      d.canonical_name AS district,
      count(DISTINCT NULLIF(trim(p.source_url), ''))::int AS policy_distinct_urls
    FROM public.policy_documents p
    JOIN catalog.districts d ON d.id = p.district_id
    WHERE ($1::text IS NULL OR d.canonical_name = $1)
    GROUP BY d.canonical_name
  )
  SELECT
    s.district,
    s.school_total,
    s.school_basic_complete,
    s.tier_complete,
    s.nature_complete,
    s.enrollment_note_complete,
    s.school_location_complete,
    s.schools_with_communities,
    s.schools_with_sources,
    coalesce(c.linked_community_total, 0)::int AS linked_community_total,
    coalesce(c.community_location_complete, 0)::int AS community_location_complete,
    coalesce(c.community_coordinate_complete, 0)::int AS community_coordinate_complete,
    coalesce(a.assignment_total, 0)::int AS assignment_total,
    coalesce(a.verified_assignments, 0)::int AS verified_assignments,
    coalesce(f.feeder_total, 0)::int AS feeder_total,
    coalesce(f.reviewed_feeders, 0)::int AS reviewed_feeders,
    1::int AS policy_target_districts,
    coalesce(p.policy_distinct_urls, 0)::int AS policy_distinct_urls
  FROM school_stats s
  LEFT JOIN community_stats c ON c.district = s.district
  LEFT JOIN assignment_stats a ON a.district = s.district
  LEFT JOIN feeder_stats f ON f.district = s.district
  LEFT JOIN policy_stats p ON p.district = s.district
  ORDER BY s.district
`;

type MetricRow = {
  district: string;
  school_total: number;
  school_basic_complete: number;
  tier_complete: number;
  nature_complete: number;
  enrollment_note_complete: number;
  school_location_complete: number;
  schools_with_communities: number;
  schools_with_sources: number;
  linked_community_total: number;
  community_location_complete: number;
  community_coordinate_complete: number;
  assignment_total: number;
  verified_assignments: number;
  feeder_total: number;
  reviewed_feeders: number;
  policy_target_districts: number;
  policy_distinct_urls: number;
};

type Metric = {
  total: number;
  complete: number;
  missing: number;
  percent: number;
};

type SummaryRow = {
  district: string;
  schools: Metric;
  tiers: Metric;
  schoolNature: Metric;
  enrollmentNotes: Metric;
  schoolLocation: Metric;
  schoolCommunities: Metric;
  sourceCoverage: Metric;
  communityLocation: Metric;
  communityPreciseCoordinates: Metric;
  verifiedAssignments: Metric;
  reviewedFeeders: Metric;
  policySourceCoverage: Metric;
  overallPercent: number;
  weightedPercent: number;
};

type SchoolGap = {
  id: number;
  district: string;
  name: string;
  type: string;
  tier?: string | null;
  address?: string | null;
  lat?: number | null;
  lng?: number | null;
  school_nature?: string | null;
  link_count?: number;
};

type CommunityGap = {
  id: number;
  district: string;
  name: string;
  amap_address: string | null;
  source_committee: string | null;
  lat: number | null;
  lng: number | null;
  linked_schools: number;
  link_rows: number;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function numberArg(name: string) {
  const raw = valueArg(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function baseParams(year: number): Array<string | string[] | number | null> {
  return [district ?? null, EMPTY_VALUES, year];
}

async function latestAvailableYear(client: pg.Client) {
  const result = await client.query<{ year: number }>(
    "SELECT coalesce(max(year), extract(year from current_date)::int)::int AS year FROM school_communities",
  );
  return Number(result.rows[0]?.year);
}

function detailLimitSql(params: Array<string | string[] | number | null>) {
  if (detailLimit === undefined) return "";
  params.push(detailLimit);
  return `LIMIT $${params.length}`;
}

function metric(total: number, complete: number): Metric {
  return {
    total,
    complete,
    missing: total - complete,
    percent: total > 0 ? Math.round((complete / total) * 1000) / 10 : 0,
  };
}

function buildSummary(row: MetricRow): SummaryRow {
  const schools = metric(row.school_total, row.school_basic_complete);
  const tiers = metric(row.school_total, row.tier_complete);
  const schoolNature = metric(row.school_total, row.nature_complete);
  const enrollmentNotes = metric(row.school_total, row.enrollment_note_complete);
  const schoolLocation = metric(row.school_total, row.school_location_complete);
  const schoolCommunities = metric(row.school_total, row.schools_with_communities);
  const sourceCoverage = metric(row.school_total, row.schools_with_sources);
  const communityLocation = metric(row.linked_community_total, row.community_location_complete);
  const communityPreciseCoordinates = metric(
    row.linked_community_total,
    row.community_coordinate_complete,
  );
  const verifiedAssignments = metric(row.assignment_total, row.verified_assignments);
  const reviewedFeeders = metric(row.feeder_total, row.reviewed_feeders);
  const policySourceCoverage = metric(
    row.policy_target_districts,
    Math.min(row.policy_target_districts, row.policy_distinct_urls),
  );
  const percents = [
    schools.percent,
    tiers.percent,
    schoolNature.percent,
    enrollmentNotes.percent,
    schoolLocation.percent,
    schoolCommunities.percent,
    sourceCoverage.percent,
    communityLocation.percent,
    communityPreciseCoordinates.percent,
    verifiedAssignments.percent,
    reviewedFeeders.percent,
    policySourceCoverage.percent,
  ];
  const weightedMetrics: Array<[Metric, number]> = [
    [schools, 5],
    [tiers, 5],
    [schoolNature, 10],
    [enrollmentNotes, 10],
    [schoolLocation, 10],
    [schoolCommunities, 10],
    [sourceCoverage, 10],
    [communityLocation, 5],
    [communityPreciseCoordinates, 15],
    [verifiedAssignments, 10],
    [reviewedFeeders, 5],
    [policySourceCoverage, 5],
  ];
  const weightedPercent = weightedMetrics.reduce(
    (sum, [qualityMetric, weight]) => sum + qualityMetric.percent * weight,
    0,
  ) / weightedMetrics.reduce((sum, [, weight]) => sum + weight, 0);

  return {
    district: row.district,
    schools,
    tiers,
    schoolNature,
    enrollmentNotes,
    schoolLocation,
    schoolCommunities,
    sourceCoverage,
    communityLocation,
    communityPreciseCoordinates,
    verifiedAssignments,
    reviewedFeeders,
    policySourceCoverage,
    overallPercent: Math.round((percents.reduce((sum, percent) => sum + percent, 0) / percents.length) * 10) / 10,
    weightedPercent: Math.round(weightedPercent * 10) / 10,
  };
}

function buildCitySummary(rows: SummaryRow[]): SummaryRow {
  const cityRow: MetricRow = {
    district: district ?? "全市",
    school_total: rows.reduce((sum, item) => sum + item.schools.total, 0),
    school_basic_complete: rows.reduce((sum, item) => sum + item.schools.complete, 0),
    tier_complete: rows.reduce((sum, item) => sum + item.tiers.complete, 0),
    nature_complete: rows.reduce((sum, item) => sum + item.schoolNature.complete, 0),
    enrollment_note_complete: rows.reduce((sum, item) => sum + item.enrollmentNotes.complete, 0),
    school_location_complete: rows.reduce((sum, item) => sum + item.schoolLocation.complete, 0),
    schools_with_communities: rows.reduce((sum, item) => sum + item.schoolCommunities.complete, 0),
    schools_with_sources: rows.reduce((sum, item) => sum + item.sourceCoverage.complete, 0),
    linked_community_total: rows.reduce((sum, item) => sum + item.communityLocation.total, 0),
    community_location_complete: rows.reduce((sum, item) => sum + item.communityLocation.complete, 0),
    community_coordinate_complete: rows.reduce(
      (sum, item) => sum + item.communityPreciseCoordinates.complete,
      0,
    ),
    assignment_total: rows.reduce((sum, item) => sum + item.verifiedAssignments.total, 0),
    verified_assignments: rows.reduce((sum, item) => sum + item.verifiedAssignments.complete, 0),
    feeder_total: rows.reduce((sum, item) => sum + item.reviewedFeeders.total, 0),
    reviewed_feeders: rows.reduce((sum, item) => sum + item.reviewedFeeders.complete, 0),
    policy_target_districts: rows.reduce((sum, item) => sum + item.policySourceCoverage.total, 0),
    policy_distinct_urls: rows.reduce((sum, item) => sum + item.policySourceCoverage.complete, 0),
  };
  return buildSummary(cityRow);
}

function flattenSummary(summary: SummaryRow) {
  return {
    district: summary.district,
    weighted_percent: summary.weightedPercent,
    unweighted_percent: summary.overallPercent,
    school_basic: `${summary.schools.complete}/${summary.schools.total} (${summary.schools.percent}%)`,
    tiers: `${summary.tiers.complete}/${summary.tiers.total} (${summary.tiers.percent}%)`,
    school_nature: `${summary.schoolNature.complete}/${summary.schoolNature.total} (${summary.schoolNature.percent}%)`,
    enrollment_notes: `${summary.enrollmentNotes.complete}/${summary.enrollmentNotes.total} (${summary.enrollmentNotes.percent}%)`,
    school_location: `${summary.schoolLocation.complete}/${summary.schoolLocation.total} (${summary.schoolLocation.percent}%)`,
    school_communities: `${summary.schoolCommunities.complete}/${summary.schoolCommunities.total} (${summary.schoolCommunities.percent}%)`,
    school_sources: `${summary.sourceCoverage.complete}/${summary.sourceCoverage.total} (${summary.sourceCoverage.percent}%)`,
    community_location: `${summary.communityLocation.complete}/${summary.communityLocation.total} (${summary.communityLocation.percent}%)`,
    community_coordinates: `${summary.communityPreciseCoordinates.complete}/${summary.communityPreciseCoordinates.total} (${summary.communityPreciseCoordinates.percent}%)`,
    verified_assignments: `${summary.verifiedAssignments.complete}/${summary.verifiedAssignments.total} (${summary.verifiedAssignments.percent}%)`,
    reviewed_feeders: `${summary.reviewedFeeders.complete}/${summary.reviewedFeeders.total} (${summary.reviewedFeeders.percent}%)`,
    policy_sources: `${summary.policySourceCoverage.complete}/${summary.policySourceCoverage.total} (${summary.policySourceCoverage.percent}%)`,
  };
}

async function querySchoolGaps(client: pg.Client, year: number, where: string) {
  const params: Array<string | string[] | number | null> = baseParams(year);
  const limit = detailLimitSql(params);
  return client.query<SchoolGap>(
    `
      WITH link_by_school AS (
        SELECT school_id, count(*)::int AS link_count
        FROM school_communities
        WHERE year = $3
        GROUP BY school_id
      )
      SELECT
        s.id,
        s.district,
        s.name,
        s.type::text AS type,
        s.tier,
        s.address,
        s.lat,
        s.lng,
        s.school_nature::text AS school_nature,
        coalesce(l.link_count, 0)::int AS link_count
      FROM schools s
      LEFT JOIN link_by_school l ON l.school_id = s.id
      WHERE ($1::text IS NULL OR s.district = $1)
        AND $2::text[] IS NOT NULL
        AND (${where})
      ORDER BY s.district, s.id
      ${limit}
    `,
    params,
  );
}

async function queryCommunityGaps(client: pg.Client, year: number, where: string) {
  const params: Array<string | string[] | number | null> = baseParams(year);
  const limit = detailLimitSql(params);
  return client.query<CommunityGap>(
    `
      SELECT
        c.id,
        c.district,
        c.name,
        c.amap_address,
        c.source_committee,
        c.lat,
        c.lng,
        count(DISTINCT sc.school_id)::int AS linked_schools,
        count(sc.id)::int AS link_rows
      FROM communities c
      INNER JOIN school_communities sc ON sc.community_id = c.id AND sc.year = $3
      INNER JOIN schools s ON s.id = sc.school_id
      WHERE ($1::text IS NULL OR s.district = $1)
        AND $2::text[] IS NOT NULL
        AND (${where})
      GROUP BY c.id, c.district, c.name, c.amap_address, c.source_committee, c.lat, c.lng
      ORDER BY c.district, c.id
      ${limit}
    `,
    params,
  );
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const year = requestedYear ?? await latestAvailableYear(client);
    if (!Number.isFinite(year)) throw new Error("Could not resolve completeness year.");

    const summaryResult = await client.query<MetricRow>(SUMMARY_SQL, baseParams(year));
    const districtSummaries = summaryResult.rows.map(buildSummary);
    const citySummary = buildCitySummary(districtSummaries);

    const gaps = {
      missingTiers: (
        await querySchoolGaps(
          client,
          year,
          `s.tier IS NULL OR btrim(s.tier) = '' OR s.tier IN (SELECT unnest($2::text[]))`,
        )
      ).rows,
      missingSchoolNature: (
        await querySchoolGaps(
          client,
          year,
          `s.school_nature IS NULL`,
        )
      ).rows,
      missingSchoolLocation: (
        await querySchoolGaps(
          client,
          year,
          `s.address IS NULL
            OR btrim(s.address) = ''
            OR s.address IN (SELECT unnest($2::text[]))
            OR s.lat IS NULL
            OR s.lng IS NULL`,
        )
      ).rows,
      missingSchoolCommunities: (
        await querySchoolGaps(client, year, `coalesce(l.link_count, 0) = 0`)
      ).rows,
      missingCommunityLocation: (
        await queryCommunityGaps(
          client,
          year,
          `NOT (
            (nullif(trim(coalesce(c.amap_address, '')), '') IS NOT NULL AND coalesce(c.amap_address, '') NOT IN (SELECT unnest($2::text[])))
            OR (nullif(trim(coalesce(c.source_committee, '')), '') IS NOT NULL AND coalesce(c.source_committee, '') NOT IN (SELECT unnest($2::text[])))
          )`,
        )
      ).rows,
      missingCommunityCoordinates: (
        await queryCommunityGaps(client, year, `c.lat IS NULL OR c.lng IS NULL`)
      ).rows,
    };

    const output = {
      year,
      district: district ?? null,
      detailLimit: detailLimit ?? null,
      city: citySummary,
      districts: districtSummaries,
      gaps,
    };

    if (jsonOnly) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`Completeness audit year=${year}${district ? ` district=${district}` : ""}`);
    console.log(detailLimit === undefined ? "Detail rows: all" : `Detail rows per gap: ${detailLimit}`);
    console.log("\n## completeness summary");
    console.table([citySummary, ...districtSummaries].map(flattenSummary));

    console.log("\n## missing tiers");
    console.table(gaps.missingTiers);
    console.log("\n## missing school nature");
    console.table(gaps.missingSchoolNature);
    console.log("\n## missing school location");
    console.table(gaps.missingSchoolLocation);
    console.log("\n## schools without 2025 community links");
    console.table(gaps.missingSchoolCommunities);
    console.log("\n## linked communities missing location text");
    console.table(gaps.missingCommunityLocation);
    console.log("\n## linked communities missing coordinates");
    console.table(gaps.missingCommunityCoordinates);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
