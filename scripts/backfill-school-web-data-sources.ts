/**
 * Backfill reviewed web sources for the recent school short-name cleanup.
 *
 * Dry-run by default. Pass --apply to insert/update web_data_source rows and
 * fill schools.website only for confirmed official school homepages.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
const reportDir = path.join(process.cwd(), ".tmp", "backfill-school-web-data-sources", stamp);
const detectedAt = now.toISOString();

type SourceType =
  | "official_website"
  | "official_notice"
  | "official_school_info"
  | "official_admission"
  | "map"
  | "third_party_directory";

type SourceEntry = {
  schoolId: number;
  schoolName: string;
  sourceType: SourceType;
  sourceName: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceDate?: string;
  evidence: string;
  confidence: "high" | "medium";
  setAsWebsite?: boolean;
  raw?: Record<string, unknown>;
};

const SOURCES: SourceEntry[] = [
  {
    schoolId: 4008,
    schoolName: "上海市曹杨二中附属江桥实验中学",
    sourceType: "official_website",
    sourceName: "江桥实验中学",
    sourceUrl: "https://jqzx.jdjy.sh.cn/",
    sourceTitle: "江桥实验中学",
    evidence: "官网首页用于确认曹杨二中附属江桥实验中学的学校官网。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4008,
    schoolName: "上海市曹杨二中附属江桥实验中学",
    sourceType: "third_party_directory",
    sourceName: "上哪学",
    sourceUrl: "https://shangnaxue.net/school/1161623531803140098.html?cid=102",
    sourceTitle: "上海市曹杨二中附属江桥实验中学",
    evidence: "目录页列出学校全称、地址和学校官网 https://jqzx.jdjy.sh.cn/，作为官网归属的辅助佐证。",
    confidence: "medium",
  },
  {
    schoolId: 4298,
    schoolName: "上海市崇明中学附属东门中学（江山校区/城东校区）",
    sourceType: "official_notice",
    sourceName: "上海市崇明区人民政府",
    sourceUrl: "https://shcm.gov.cn/bmpd/019002/019002003/20240102/cbef2f29-3b5c-4058-b2a0-db112e8ea3cf.html",
    sourceTitle: "上海市崇明中学附属东门中学揭牌",
    sourceDate: "2024-01-02",
    evidence: "政府新闻确认东门中学揭牌为上海市崇明中学附属东门中学。",
    confidence: "high",
  },
  {
    schoolId: 4298,
    schoolName: "上海市崇明中学附属东门中学（江山校区/城东校区）",
    sourceType: "official_school_info",
    sourceName: "上海市崇明区人民政府",
    sourceUrl: "https://www.shcm.gov.cn/govxxgk/qjyj/2025-06-05/4b9eac2c-ac38-4415-9a40-d85014e74310.html",
    sourceTitle: "上海市崇明中学附属东门中学发展性督导评价意见书",
    sourceDate: "2025-06-05",
    evidence: "政府公开页说明学校设有江山、城东、育林三个校区。",
    confidence: "high",
  },
  {
    schoolId: 3467,
    schoolName: "上海市黄浦区卢湾二中心小学",
    sourceType: "official_website",
    sourceName: "上海市黄浦区卢湾二中心小学",
    sourceUrl: "https://ezx.hpe.cn/",
    sourceTitle: "上海市黄浦区卢湾二中心小学",
    evidence: "黄浦教育体系内学校站点，用于确认卢湾二中心小学官网。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 3467,
    schoolName: "上海市黄浦区卢湾二中心小学",
    sourceType: "official_school_info",
    sourceName: "上海市黄浦区卢湾二中心小学",
    sourceUrl: "https://ezx.hpe.cn/tzgg/695049.htm",
    sourceTitle: "上海市黄浦区卢湾二中心小学2024年度决算",
    evidence: "学校站内公开页页脚列出学校名称、地址、电话和邮箱。",
    confidence: "high",
  },
  {
    schoolId: 4573,
    schoolName: "上海市格致初级中学",
    sourceType: "official_website",
    sourceName: "上海市格致初级中学",
    sourceUrl: "https://gc.hpe.cn/",
    sourceTitle: "格致初级中学",
    evidence: "黄浦教育体系内学校站点，用于确认格致初级中学官网。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4573,
    schoolName: "上海市格致初级中学",
    sourceType: "official_school_info",
    sourceName: "上海市黄浦区教育局",
    sourceUrl: "https://www.hpe.cn/xxgk/schooldetail.jsp?id=5710&node_id=37",
    sourceTitle: "上海市格致初级中学-基础教育信息公开",
    evidence: "黄浦区基础教育信息公开页用于佐证学校全称。",
    confidence: "high",
  },
  {
    schoolId: 3502,
    schoolName: "上海市长宁区愚园路第一小学",
    sourceType: "official_school_info",
    sourceName: "上海市长宁区教育局",
    sourceUrl: "https://zwgk.shcn.gov.cn/xxgk/yyldyzx-qjyj/index.html",
    sourceTitle: "上海市长宁区愚园路第一小学 - 政务公开",
    evidence: "长宁政务公开页用于确认学校全称；未发现可确认的独立官网。",
    confidence: "high",
  },
  {
    schoolId: 3585,
    schoolName: "上海市风华初级中学教育集团",
    sourceType: "official_admission",
    sourceName: "上海市人民政府",
    sourceUrl: "https://www.shanghai.gov.cn/jaqywjy/20250407/523014b1946441c187bc41107d313641.html",
    sourceTitle: "2025年静安区公办初中入学方式",
    sourceDate: "2025-04-07",
    evidence: "上海市政府页列出上海市风华初级中学教育集团及东、西、南、北校，佐证集团名和校区拆分。",
    confidence: "high",
  },
  {
    schoolId: 3586,
    schoolName: "上海市新中初级中学",
    sourceType: "official_admission",
    sourceName: "上海市人民政府",
    sourceUrl: "https://www.shanghai.gov.cn/jaqywjy/20250407/523014b1946441c187bc41107d313641.html",
    sourceTitle: "2025年静安区公办初中入学方式",
    sourceDate: "2025-04-07",
    evidence: "上海市政府页列出上海市新中初级中学教育集团和上海市新中初级中学，佐证去除误入校名的教育集团后缀。",
    confidence: "high",
  },
  {
    schoolId: 3586,
    schoolName: "上海市新中初级中学",
    sourceType: "official_school_info",
    sourceName: "上海市静安区人民政府",
    sourceUrl: "https://www.jingan.gov.cn/jagl/006012/006012002/006012002007/20191021/a757dabb-fc19-4f05-a409-88e924fd9a67.html",
    sourceTitle: "上海市新中初级中学",
    sourceDate: "2019-10-21",
    evidence: "静安区政府学校页列出学校全称、地址和联系电话。",
    confidence: "high",
  },
  {
    schoolId: 4406,
    schoolName: "上海市吴淞中学附属宝山实验学校（原上海市吴淞初级中学）",
    sourceType: "official_admission",
    sourceName: "上海市宝山区人民政府",
    sourceUrl: "https://xxgk.shbsq.gov.cn/article.html?infoid=a2a1672c-d0c4-4452-b59b-e9f6596c012e",
    sourceTitle: "2025年宝山区义务教育阶段学校校区范围与招生计划（初中）",
    sourceDate: "2025-04-23",
    evidence: "宝山区招生计划列出上海市吴淞中学附属宝山实验学校（原上海市吴淞初级中学）及永清路156号。",
    confidence: "high",
  },
  {
    schoolId: 4567,
    schoolName: "上海市民办华育中学",
    sourceType: "official_website",
    sourceName: "上海市民办华育中学",
    sourceUrl: "https://www.hy.sh.cn/",
    sourceTitle: "上海华育中学",
    evidence: "官网首页页脚和站点标题用于确认上海市民办华育中学官网。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4579,
    schoolName: "上海市世外中学",
    sourceType: "official_website",
    sourceName: "上海市世外中学",
    sourceUrl: "https://www.wflms.cn/",
    sourceTitle: "上海市世外中学",
    evidence: "官网首页用于确认上海市世外中学官网。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4579,
    schoolName: "上海市世外中学",
    sourceType: "official_school_info",
    sourceName: "上海市世界外国语中学",
    sourceUrl: "https://www.wflms.cn/site/site1/detail/10100_2ece3cc7-9fe5-4ad0-a655-bfa88cc3b76d.html",
    sourceTitle: "上海市世界外国语中学简介",
    evidence: "学校旧站/简介用于佐证“上海市世界外国语中学”曾用名/别名关系。",
    confidence: "high",
  },
  {
    schoolId: 4579,
    schoolName: "上海市世外中学",
    sourceType: "official_admission",
    sourceName: "上海市教育考试院",
    sourceUrl: "https://www.shmeea.edu.cn/20190424/12.htm",
    sourceTitle: "世外中学",
    evidence: "上海市教育考试院页面列出学校网址和地址，用于佐证官网及地址。",
    confidence: "high",
  },
  {
    schoolId: 4580,
    schoolName: "上海市位育初级中学",
    sourceType: "official_website",
    sourceName: "上海市位育初级中学",
    sourceUrl: "https://wycz.xhedu.sh.cn/cms/",
    sourceTitle: "上海市位育初级中学",
    evidence: "徐汇区2025办学规模公开表列出的学校网址。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4580,
    schoolName: "上海市位育初级中学",
    sourceType: "official_school_info",
    sourceName: "上海市人民政府",
    sourceUrl: "https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
    sourceTitle: "2025年徐汇区义务教育阶段学校（初中）办学规模",
    sourceDate: "2025-04-11",
    evidence: "上海市政府页列出学校全称、地址、学校网址和办学规模。",
    confidence: "high",
  },
  {
    schoolId: 4700,
    schoolName: "上海市西南位育中学",
    sourceType: "official_website",
    sourceName: "上海西南位育中学",
    sourceUrl: "https://xnwy.xhedu.sh.cn/cms/",
    sourceTitle: "首页- 上海市西南位育中学",
    evidence: "官网首页页脚显示上海西南位育中学，用于确认学校官网。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4581,
    schoolName: "上海市南洋模范初级中学",
    sourceType: "official_website",
    sourceName: "上海市南洋模范初级中学",
    sourceUrl: "https://nmcz.xhedu.sh.cn/",
    sourceTitle: "上海市南洋模范初级中学",
    evidence: "官网首页用于确认南洋模范初级中学官网。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4581,
    schoolName: "上海市南洋模范初级中学",
    sourceType: "official_admission",
    sourceName: "上海市教育委员会",
    sourceUrl: "https://edu.sh.gov.cn/gqzszc_xhq/20210430/22f4e8ca11c048099ee314302f61cba6.html",
    sourceTitle: "2021年徐汇区公办初中招生学校一览",
    sourceDate: "2021-04-30",
    evidence: "市教委页面列出上海市南洋模范初级中学及其网址 http://nmcz.xhedu.sh.cn/。",
    confidence: "high",
  },
  {
    schoolId: 4486,
    schoolName: "上海市普陀区新普陀小学及东校",
    sourceType: "official_website",
    sourceName: "上海市普陀区新普陀小学",
    sourceUrl: "https://xpt.pte.sh.cn/",
    sourceTitle: "上海市普陀区新普陀小学",
    evidence: "学校官网首页发布新普陀小学、新普陀小学东校招生和开放日信息。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4486,
    schoolName: "上海市普陀区新普陀小学及东校",
    sourceType: "official_website",
    sourceName: "上海市普陀区新普陀小学东校",
    sourceUrl: "https://expt.pte.sh.cn/",
    sourceTitle: "上海市普陀区新普陀小学东校",
    evidence: "东校独立官网；保存在来源表中，schools.website 使用本部/联合招生主页。",
    confidence: "high",
  },
  {
    schoolId: 4486,
    schoolName: "上海市普陀区新普陀小学及东校",
    sourceType: "official_admission",
    sourceName: "上海市人民政府",
    sourceUrl: "https://www.shanghai.gov.cn/ptqywjy/20240408/ebd2ce6c6d2b4a84bad0345188f933a5.html",
    sourceTitle: "2024年普陀区义务教育阶段学校校园开放日信息表",
    sourceDate: "2024-04-08",
    evidence: "上海市政府页列出上海市普陀区新普陀小学及东校、梅川路838号和公众号。",
    confidence: "high",
  },
  {
    schoolId: 4533,
    schoolName: "上海华东师范大学附属进华中学",
    sourceType: "official_website",
    sourceName: "上海华东师范大学附属进华中学",
    sourceUrl: "https://jh.ecnu.edu.cn/",
    sourceTitle: "上海华东师范大学附属进华中学",
    evidence: "官网首页页脚列出学校地址、电话、官网和邮箱。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4533,
    schoolName: "上海华东师范大学附属进华中学",
    sourceType: "official_school_info",
    sourceName: "上海华东师范大学附属进华中学",
    sourceUrl: "https://jh.ecnu.edu.cn/xxjj/list.htm",
    sourceTitle: "学校简介 - 上海华东师范大学附属进华中学",
    evidence: "学校简介页说明2018年更名为上海华东师范大学附属进华中学。",
    confidence: "high",
  },
  {
    schoolId: 4555,
    schoolName: "上海市杨浦区五角场小学",
    sourceType: "official_school_info",
    sourceName: "上海市杨浦区人民政府",
    sourceUrl: "https://www.shyp.gov.cn/shypq/ggfw-tycg/20240219/448511.html",
    sourceTitle: "上海市杨浦区五角场小学",
    evidence: "杨浦区政府公共服务页面用于确认学校全称；未发现可确认的独立官网。",
    confidence: "high",
  },
  {
    schoolId: 3901,
    schoolName: "上海市闵行区颛桥中学",
    sourceType: "official_website",
    sourceName: "上海市闵行区颛桥中学",
    sourceUrl: "http://zqzx.mhedu.sh.cn",
    sourceTitle: "上海市闵行区颛桥中学",
    evidence: "上海市政府校园开放日页面列出的学校官网。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 3901,
    schoolName: "上海市闵行区颛桥中学",
    sourceType: "official_admission",
    sourceName: "上海市人民政府",
    sourceUrl: "https://www.shanghai.gov.cn/mhqywjy/20230425/de2eda470deb4f50a9c2181be7455963.html",
    sourceTitle: "2023年闵行区义务教育阶段学校网上“校园开放日”",
    sourceDate: "2023-04-25",
    evidence: "上海市政府页列出上海市闵行区颛桥中学和网址 http://zqzx.mhedu.sh.cn。",
    confidence: "high",
  },
  {
    schoolId: 3901,
    schoolName: "上海市闵行区颛桥中学",
    sourceType: "map",
    sourceName: "高德地图",
    sourceUrl: "https://ditu.amap.com/place/B001539BAC",
    sourceTitle: "上海市闵行区颛桥中学",
    evidence: "地图页用于佐证地址为老沪闵路3112号。",
    confidence: "medium",
  },
  {
    schoolId: 4574,
    schoolName: "上海市大同初级中学",
    sourceType: "official_website",
    sourceName: "上海市大同初级中学",
    sourceUrl: "https://dtc.hpe.cn/",
    sourceTitle: "上海市大同初级中学",
    evidence: "黄浦教育体系内学校站点；站内页脚列出网址 dtc.hpe.cn。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4574,
    schoolName: "上海市大同初级中学",
    sourceType: "official_admission",
    sourceName: "上海市教育委员会",
    sourceUrl: "https://edu.sh.gov.cn/gqzszc_hpq/20210430/976fbe62a2b94ba3bcad907650fc7dce.html",
    sourceTitle: "2021年黄浦区公办初中招生学校一览",
    sourceDate: "2021-04-30",
    evidence: "市教委页面列出上海市大同初级中学及地址。",
    confidence: "high",
  },
  {
    schoolId: 4583,
    schoolName: "上海市向明初级中学",
    sourceType: "official_website",
    sourceName: "上海市向明初级中学",
    sourceUrl: "https://xmcj.hpe.cn/",
    sourceTitle: "上海市向明初级中学",
    evidence: "官网首页用于确认向明初级中学官网。",
    confidence: "high",
    setAsWebsite: true,
  },
  {
    schoolId: 4583,
    schoolName: "上海市向明初级中学",
    sourceType: "official_admission",
    sourceName: "上海市教育委员会",
    sourceUrl: "https://edu.sh.gov.cn/gqzszc_hpq/20210430/976fbe62a2b94ba3bcad907650fc7dce.html",
    sourceTitle: "2021年黄浦区公办初中招生学校一览",
    sourceDate: "2021-04-30",
    evidence: "市教委页面列出上海市向明初级中学及地址。",
    confidence: "high",
  },
];

function normalizeUrl(url: string | null | undefined) {
  if (!url) return "";
  return url.trim().replace(/\/+$/, "");
}

async function main() {
  mkdirSync(reportDir, { recursive: true });

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const tableExists = (await client.query(`SELECT to_regclass('public.web_data_source') AS table_name`)).rows[0]
      .table_name;
    if (!tableExists) {
      throw new Error("web_data_source table does not exist. Run scripts/add-web-data-source-table.ts --apply first.");
    }

    const schoolIds = Array.from(new Set(SOURCES.map((source) => source.schoolId)));
    const schools = (
      await client.query(
        `SELECT id, name, website
         FROM schools
         WHERE id = ANY($1::int[])
         ORDER BY id`,
        [schoolIds],
      )
    ).rows as Array<{ id: number; name: string; website: string | null }>;
    const schoolById = new Map(schools.map((school) => [school.id, school]));

    const missingSchools = schoolIds.filter((id) => !schoolById.has(id));
    const nameMismatches = SOURCES.flatMap((source) => {
      const school = schoolById.get(source.schoolId);
      return school && school.name !== source.schoolName
        ? [{ id: source.schoolId, expected: source.schoolName, actual: school.name }]
        : [];
    });
    if (missingSchools.length > 0 || nameMismatches.length > 0) {
      throw new Error(
        `school validation failed: missing=${missingSchools.join(",")}, mismatches=${JSON.stringify(nameMismatches)}`,
      );
    }

    const websitePlans = SOURCES.filter((source) => source.setAsWebsite).map((source) => {
      const school = schoolById.get(source.schoolId);
      const currentWebsite = school?.website ?? null;
      const current = normalizeUrl(currentWebsite);
      const next = normalizeUrl(source.sourceUrl);
      const action = !current ? "set" : current === next ? "keep" : "conflict";
      return {
        schoolId: source.schoolId,
        schoolName: source.schoolName,
        currentWebsite,
        nextWebsite: source.sourceUrl,
        action,
      };
    });
    const conflicts = websitePlans.filter((plan) => plan.action === "conflict");
    const plan = {
      apply,
      sourceRows: SOURCES.length,
      targetSchools: schoolIds.length,
      websitesToSet: websitePlans.filter((plan) => plan.action === "set").length,
      websitesAlreadySame: websitePlans.filter((plan) => plan.action === "keep").length,
      websiteConflicts: conflicts,
      sources: SOURCES,
    };
    writeFileSync(path.join(reportDir, "plan.json"), JSON.stringify(plan, null, 2));
    console.log(
      `Plan: sources=${SOURCES.length}, targetSchools=${schoolIds.length}, websitesToSet=${plan.websitesToSet}, websiteConflicts=${conflicts.length}. Report: ${reportDir}`,
    );
    if (conflicts.length > 0) {
      console.log("Website conflicts found; they will not be overwritten.");
    }
    if (!apply) return;

    await client.query("BEGIN");

    let insertedOrUpdatedSources = 0;
    let websitesSet = 0;
    const websiteResults: Array<Record<string, unknown>> = [];

    for (const source of SOURCES) {
      const raw = {
        ...(source.raw ?? {}),
        school_name_at_review: source.schoolName,
        backfill_reason: "school_short_name_cleanup_source",
        reviewed_at: detectedAt,
      };
      const result = await client.query(
        `INSERT INTO web_data_source (
           school_id,
           source_type,
           source_name,
           source_url,
           source_title,
           source_date,
           evidence,
           confidence,
           raw,
           fetched_at,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now(), now())
         ON CONFLICT (school_id, source_url, source_type)
         DO UPDATE SET
           source_name = EXCLUDED.source_name,
           source_title = EXCLUDED.source_title,
           source_date = EXCLUDED.source_date,
           evidence = EXCLUDED.evidence,
           confidence = EXCLUDED.confidence,
           raw = EXCLUDED.raw,
           fetched_at = EXCLUDED.fetched_at,
           updated_at = now()
         RETURNING id`,
        [
          source.schoolId,
          source.sourceType,
          source.sourceName,
          source.sourceUrl,
          source.sourceTitle,
          source.sourceDate ?? null,
          source.evidence,
          source.confidence,
          JSON.stringify(raw),
        ],
      );
      insertedOrUpdatedSources += result.rowCount ?? 0;
    }

    for (const source of SOURCES.filter((item) => item.setAsWebsite)) {
      const school = schoolById.get(source.schoolId);
      const current = normalizeUrl(school?.website ?? null);
      const next = normalizeUrl(source.sourceUrl);
      if (current && current !== next) {
        websiteResults.push({
          schoolId: source.schoolId,
          schoolName: source.schoolName,
          action: "skipped_conflict",
          currentWebsite: school?.website,
          nextWebsite: source.sourceUrl,
        });
        continue;
      }
      if (current === next) {
        websiteResults.push({
          schoolId: source.schoolId,
          schoolName: source.schoolName,
          action: "already_same",
          website: school?.website,
        });
        continue;
      }
      const update = await client.query(
        `UPDATE schools
         SET website = $1,
             updated_at = now()
         WHERE id = $2
           AND (website IS NULL OR btrim(website) = '')
         RETURNING id`,
        [source.sourceUrl, source.schoolId],
      );
      websitesSet += update.rowCount ?? 0;
      websiteResults.push({
        schoolId: source.schoolId,
        schoolName: source.schoolName,
        action: update.rowCount === 1 ? "set" : "not_set",
        website: source.sourceUrl,
      });
    }

    await client.query("COMMIT");

    const counts = {
      insertedOrUpdatedSources,
      websitesSet,
      sourcesTotal: Number((await client.query(`SELECT count(*)::int AS count FROM web_data_source`)).rows[0].count),
    };
    writeFileSync(
      path.join(reportDir, "applied.json"),
      JSON.stringify({ counts, websiteResults, sourceCount: SOURCES.length }, null, 2),
    );
    console.log(
      `Applied: sourceUpserts=${insertedOrUpdatedSources}, websitesSet=${websitesSet}, webDataSourceTotal=${counts.sourcesTotal}. Report: ${reportDir}`,
    );
  } catch (error) {
    if (apply) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
