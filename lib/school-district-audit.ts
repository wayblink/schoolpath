import { sql } from "drizzle-orm";
import { db } from "./db/client";

export const AUDIT_YEARS = [2025, 2026] as const;
export const SHANGHAI_ENROLLMENT_INDEX_URL = "https://shrxbm.edu.sh.gov.cn/zszc/zcsm.html";

const DISTRICTS = [
  "黄浦", "徐汇", "长宁", "静安", "普陀", "虹口", "杨浦", "浦东",
  "闵行", "宝山", "嘉定", "金山", "松江", "青浦", "奉贤", "崇明",
];

type AuditStatus = "missing" | "source-found" | "boundary-text" | "partially-linked" | "linked";

export type AuditSource = {
  year: number;
  district: string;
  title: string;
  url: string | null;
  sourceName: string;
  sourceType: "official-index" | "db-school-community" | "db-policy" | "db-web-data-source" | "seed";
  category: "district-policy" | "primary-scope" | "middle-scope" | "school-list" | "service" | "other";
  confidence: "high" | "medium" | "low";
};

export type DistrictAuditRow = {
  year: number;
  district: string;
  schoolTotal: number;
  boundaryTextSchools: number;
  linkedSchools: number;
  linkRows: number;
  linkedCommunities: number;
  sourceCount: number;
  scopeSourceCount: number;
  coveragePercent: number;
  status: AuditStatus;
  sources: AuditSource[];
};

export type SchoolDistrictAudit = {
  generatedAt: string;
  years: number[];
  indexUrl: string;
  rows: DistrictAuditRow[];
  summary: Array<{
    year: number;
    schoolTotal: number;
    boundaryTextSchools: number;
    linkedSchools: number;
    linkRows: number;
    linkedCommunities: number;
    sourceCount: number;
    scopeSourceCount: number;
    coveragePercent: number;
  }>;
};

type CoverageRow = {
  year: number | string;
  district: string;
  school_total: number | string;
  boundary_text_schools: number | string;
  linked_schools: number | string;
  link_rows: number | string;
  linked_communities: number | string;
};

type DbSourceRow = {
  year: number | string;
  district: string;
  title: string | null;
  url: string | null;
  source_name: string;
  source_type: AuditSource["sourceType"];
};

const STATIC_2025_SOURCES: AuditSource[] = [
  {
    year: 2025,
    district: "全市",
    title: "上海市教育委员会关于2025年本市义务教育阶段学校招生入学工作的实施意见",
    url: "https://www.shanghai.gov.cn/shsywjy/20250423/d4a7422648a5470387367304d3c3e495.html",
    sourceName: "上海市人民政府 / 上海市教育委员会",
    sourceType: "seed",
    category: "district-policy",
    confidence: "high",
  },
  {
    year: 2025,
    district: "徐汇",
    title: "徐汇区关于2025年义务教育阶段学校招生入学工作的实施方案",
    url: "https://www.xuhui.gov.cn/xxgk/portal/article/detail?id=8a4c0c0692292eab01960ed796202416",
    sourceName: "徐汇区人民政府",
    sourceType: "seed",
    category: "district-policy",
    confidence: "high",
  },
  {
    year: 2025,
    district: "普陀",
    title: "2025年普陀区义务教育阶段学校招生入学工作实施意见",
    url: "https://www.shpt.gov.cn/zhengwu/ywjyzs-jyjrxbkyzs/2025/97/195792.html",
    sourceName: "普陀区人民政府",
    sourceType: "seed",
    category: "district-policy",
    confidence: "high",
  },
  {
    year: 2025,
    district: "静安",
    title: "上海市静安区教育局关于2025年本区义务教育阶段学校招生入学工作的实施意见",
    url: "https://www.jingan.gov.cn/govxxgk/JA4/2025-04-05/e57ac857-2ea6-4031-93b7-d316b3e9b597.html",
    sourceName: "静安区人民政府",
    sourceType: "seed",
    category: "district-policy",
    confidence: "high",
  },
  {
    year: 2025,
    district: "浦东",
    title: "2025年浦东新区义务教育阶段学校招生入学政策问答",
    url: "https://www.pudong.gov.cn/019020001/20250408/804729.html",
    sourceName: "浦东新区人民政府",
    sourceType: "seed",
    category: "district-policy",
    confidence: "high",
  },
];

function toNumber(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

function stripHtml(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDistrict(value: string) {
  return value.replace(/新区$/, "").replace(/区$/, "").trim();
}

function sourceCategory(title: string): AuditSource["category"] {
  if (
    /公办小学.*(划片|对口|范围)|小学.*(划片|对口范围|学区划分)|幼升小.*对口|一年级新生招生范围/.test(title)
  ) {
    return "primary-scope";
  }
  if (
    /公办初中.*(入学方式|对口|范围)|初中.*(对口|划区|学区划分|地段公示)|小升初.*对口|小学对口公办初中方案/.test(title)
  ) {
    return "middle-scope";
  }
  if (/招生方案（学校层面）/.test(title)) {
    if (/初中|中学|九年|一贯制/.test(title)) return "middle-scope";
    return "primary-scope";
  }
  if (/校区范围|招生划片|招生地段公示|办学基本情况.*对口范围/.test(title)) {
    return "primary-scope";
  }
  if (/实施意见|实施方案|招生入学工作/.test(title)) return "district-policy";
  if (/学校一览|招生学校|登记点|验证点/.test(title)) return "school-list";
  if (/考试中心|门户|专栏|服务网站/.test(title)) return "service";
  return "other";
}

function inferYear(title: string, fallbackYear: number) {
  const match = title.match(/20\d{2}/);
  return match ? Number(match[0]) : fallbackYear;
}

function extractAnchorUrl(anchor: string) {
  const openMatch = anchor.match(/window\.open\(['"]([^'"]+)['"]/i);
  if (openMatch) return new URL(openMatch[1], SHANGHAI_ENROLLMENT_INDEX_URL).href;

  const hrefMatch = anchor.match(/\shref=["']([^"']+)["']/i);
  const href = hrefMatch?.[1];
  if (!href || href === "#") return null;
  return new URL(href, SHANGHAI_ENROLLMENT_INDEX_URL).href;
}

export async function fetchOfficialEnrollmentIndexSources() {
  const response = await fetch(SHANGHAI_ENROLLMENT_INDEX_URL, {
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.7",
    },
  });
  if (!response.ok) throw new Error(`Failed to fetch official enrollment index: ${response.status}`);

  const html = await response.text();
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const sources: AuditSource[] = [];
  let currentDistrict = "";

  for (const row of rows) {
    const districtMatch = stripHtml(row).match(/(黄浦|徐汇|长宁|静安|普陀|虹口|杨浦|浦东新区|闵行|宝山|嘉定|金山|松江|青浦|奉贤|崇明)区?/);
    if (districtMatch) currentDistrict = normalizeDistrict(districtMatch[1]);
    if (!currentDistrict) continue;

    const anchors = row.match(/<a\b[\s\S]*?<\/a>/gi) ?? [];
    for (const anchor of anchors) {
      const title = stripHtml(anchor).replace(/^《|》$/g, "");
      if (!title) continue;
      const year = inferYear(title, 2026);
      const category = sourceCategory(title);
      sources.push({
        year,
        district: currentDistrict,
        title,
        url: extractAnchorUrl(anchor),
        sourceName: "上海市义务教育入学报名系统",
        sourceType: "official-index",
        category,
        confidence: category === "service" ? "medium" : "high",
      });
    }
  }

  return dedupeSources(sources);
}

function dedupeSources(sources: AuditSource[]) {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = [
      source.year,
      source.district,
      source.url ?? "",
      source.title,
      source.sourceType,
    ].join("\u0000");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasScopeSignal(source: AuditSource) {
  return source.category === "primary-scope" || source.category === "middle-scope";
}

function statusFor(row: {
  schoolTotal: number;
  linkedSchools: number;
  boundaryTextSchools: number;
  scopeSourceCount: number;
}): AuditStatus {
  if (row.schoolTotal > 0 && row.linkedSchools >= row.schoolTotal) return "linked";
  if (row.linkedSchools > 0) return "partially-linked";
  if (row.boundaryTextSchools > 0) return "boundary-text";
  if (row.scopeSourceCount > 0) return "source-found";
  return "missing";
}

async function queryCoverage(years: number[]) {
  const yearValues = sql.join(years.map((year) => sql`(${year}::int)`), sql`, `);
  const result = await db.execute<CoverageRow>(sql`
    with years(year) as (values ${yearValues}),
    district_base as (
      select distinct district from schools
    ),
    school_base as (
      select
        y.year,
        s.id,
        s.district,
        s.attrs
      from years y
      cross join schools s
    ),
    link_by_school as (
      select
        year,
        school_id,
        count(*)::int as link_count,
        count(distinct community_id)::int as community_count
      from school_communities
      where year in (${sql.join(years.map((year) => sql`${year}`), sql`, `)})
      group by year, school_id
    )
    select
      y.year,
      d.district,
      count(sb.id)::int as school_total,
      count(*) filter (
        where nullif(trim(coalesce(sb.attrs->>'official_boundary_text', '')), '') is not null
          or nullif(trim(coalesce(sb.attrs->>'official_boundary_source', '')), '') is not null
      )::int as boundary_text_schools,
      count(*) filter (where coalesce(l.link_count, 0) > 0)::int as linked_schools,
      coalesce(sum(l.link_count), 0)::int as link_rows,
      coalesce(sum(l.community_count), 0)::int as linked_communities
    from years y
    cross join district_base d
    left join school_base sb on sb.year = y.year and sb.district = d.district
    left join link_by_school l on l.year = y.year and l.school_id = sb.id
    group by y.year, d.district
    order by y.year desc, d.district
  `);

  return result.rows;
}

async function queryDbSources(years: number[]) {
  const result = await db.execute<DbSourceRow>(sql`
    select distinct
      sc.year,
      s.district,
      coalesce(sc.source_name, 'school_communities') as title,
      sc.source_url as url,
      sc.source_name,
      'db-school-community'::text as source_type
    from school_communities sc
    inner join schools s on s.id = sc.school_id
    where sc.year in (${sql.join(years.map((year) => sql`${year}`), sql`, `)})
      and nullif(trim(coalesce(sc.source_url, sc.source_name, '')), '') is not null

    union all

    select distinct
      p.year,
      coalesce(p.district, s.district) as district,
      p.title,
      p.source_url as url,
      'policies' as source_name,
      'db-policy'::text as source_type
    from policies p
    left join schools s on s.id = p.school_id
    where p.year in (${sql.join(years.map((year) => sql`${year}`), sql`, `)})
      and coalesce(p.district, s.district) is not null

    union all

    select distinct
      coalesce(nullif(substring(coalesce(w.source_date, w.source_title, w.evidence, '') from '(20[0-9]{2})'), '')::int, 2025) as year,
      s.district,
      coalesce(w.source_title, w.source_name) as title,
      w.source_url as url,
      w.source_name,
      'db-web-data-source'::text as source_type
    from web_data_source w
    inner join schools s on s.id = w.school_id
    where coalesce(nullif(substring(coalesce(w.source_date, w.source_title, w.evidence, '') from '(20[0-9]{2})'), '')::int, 2025)
      in (${sql.join(years.map((year) => sql`${year}`), sql`, `)})
  `);

  return result.rows.map((row): AuditSource => {
    const title = row.title ?? row.source_name;
    return {
      year: toNumber(row.year),
      district: normalizeDistrict(row.district),
      title,
      url: row.url,
      sourceName: row.source_name,
      sourceType: row.source_type,
      category: sourceCategory(title),
      confidence: "high",
    };
  });
}

export async function buildSchoolDistrictAudit(options: {
  years?: number[];
  includeRemoteSources?: boolean;
} = {}): Promise<SchoolDistrictAudit> {
  const years = options.years?.length ? options.years : [...AUDIT_YEARS];
  const [coverageRows, dbSources, officialSources] = await Promise.all([
    queryCoverage(years),
    queryDbSources(years),
    options.includeRemoteSources === false ? Promise.resolve([]) : fetchOfficialEnrollmentIndexSources(),
  ]);

  const sourceList = dedupeSources([
    ...officialSources.filter((source) => years.includes(source.year)),
    ...dbSources.filter((source) => years.includes(source.year)),
    ...STATIC_2025_SOURCES.filter((source) => years.includes(source.year)),
  ]);

  const sourcesByDistrictYear = new Map<string, AuditSource[]>();
  for (const source of sourceList) {
    const districts = source.district === "全市" ? DISTRICTS : [source.district];
    for (const district of districts) {
      const key = `${source.year}:${district}`;
      sourcesByDistrictYear.set(key, [...(sourcesByDistrictYear.get(key) ?? []), source]);
    }
  }

  const rows = coverageRows.map((row): DistrictAuditRow => {
    const year = toNumber(row.year);
    const district = normalizeDistrict(row.district);
    const sources = dedupeSources(sourcesByDistrictYear.get(`${year}:${district}`) ?? [])
      .sort((a, b) => Number(hasScopeSignal(b)) - Number(hasScopeSignal(a)) || a.title.localeCompare(b.title, "zh-Hans-CN"));
    const schoolTotal = toNumber(row.school_total);
    const linkedSchools = toNumber(row.linked_schools);
    const boundaryTextSchools = toNumber(row.boundary_text_schools);
    const scopeSourceCount = sources.filter(hasScopeSignal).length;
    const base = {
      year,
      district,
      schoolTotal,
      boundaryTextSchools,
      linkedSchools,
      linkRows: toNumber(row.link_rows),
      linkedCommunities: toNumber(row.linked_communities),
      sourceCount: sources.length,
      scopeSourceCount,
      coveragePercent: schoolTotal > 0 ? Math.round((linkedSchools / schoolTotal) * 1000) / 10 : 0,
      sources,
    };

    return {
      ...base,
      status: statusFor(base),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    years,
    indexUrl: SHANGHAI_ENROLLMENT_INDEX_URL,
    rows,
    summary: years.map((year) => {
      const yearRows = rows.filter((row) => row.year === year);
      const schoolTotal = yearRows.reduce((sum, row) => sum + row.schoolTotal, 0);
      const linkedSchools = yearRows.reduce((sum, row) => sum + row.linkedSchools, 0);
      return {
        year,
        schoolTotal,
        boundaryTextSchools: yearRows.reduce((sum, row) => sum + row.boundaryTextSchools, 0),
        linkedSchools,
        linkRows: yearRows.reduce((sum, row) => sum + row.linkRows, 0),
        linkedCommunities: yearRows.reduce((sum, row) => sum + row.linkedCommunities, 0),
        sourceCount: yearRows.reduce((sum, row) => sum + row.sourceCount, 0),
        scopeSourceCount: yearRows.reduce((sum, row) => sum + row.scopeSourceCount, 0),
        coveragePercent: schoolTotal > 0 ? Math.round((linkedSchools / schoolTotal) * 1000) / 10 : 0,
      };
    }),
  };
}
