/**
 * Apply manually reviewed high-confidence school corrections.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to write
 * - updates by school id only
 * - no deletes, no merges
 * - appends every changed row to a persistent audit log
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const auditLogPath =
  valueArg("--audit-log") ?? path.join(process.cwd(), "data", "audit", "school-data-audit-log.jsonl");
const reportDir = path.join(
  process.cwd(),
  "data",
  "audit",
  "reviewed-school-corrections",
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-"),
);

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  aliases: string[] | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  school_nature: "公立" | "私立" | null;
  tier: string | null;
  website: string | null;
  attrs: Record<string, unknown> | null;
};

type Correction = {
  id: number;
  reviewedName: string;
  district: string;
  address?: string;
  schoolNature?: "公立" | "私立";
  aliases: string[];
  note: string;
  source: {
    type: string;
    name: string;
    title: string;
    url: string;
    date?: string;
    matchedName: string;
    rawNature?: string;
    rawAddress?: string;
  };
};

const CORRECTIONS: Correction[] = [
  {
    id: 4601,
    reviewedName: "上海市紫阳中学",
    district: "徐汇",
    address: "华展路8号",
    schoolNature: "公立",
    aliases: ["紫阳中学"],
    note: "现有地址和百度学校POI均在徐汇；2025徐汇官方初中办学规模表确认全称、区属、性质和地址。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/徐汇区教育局",
      title: "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表",
      url: "https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
      date: "2025-04-11",
      matchedName: "上海市紫阳中学",
      rawNature: "公办初中",
      rawAddress: "华展路8号",
    },
  },
  {
    id: 4768,
    reviewedName: "上海市徐汇区上汇实验学校",
    district: "徐汇",
    address: "罗香校区：罗香路240号 罗秀校区：罗秀路400号",
    schoolNature: "公立",
    aliases: ["上汇实验"],
    note: "现有地址和百度学校POI均在徐汇；2025徐汇官方小学/初中表均确认上汇实验为徐汇区公办九年一贯制。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/徐汇区教育局",
      title: "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表",
      url: "https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
      date: "2025-04-11",
      matchedName: "上海市徐汇区上汇实验学校",
      rawNature: "公办九年一贯制",
      rawAddress: "罗香校区：罗香路240号 罗秀校区：罗秀路400号",
    },
  },
  {
    id: 4783,
    reviewedName: "上海民办圣华紫竹双语学校",
    district: "闵行",
    address: "紫凤路500号； 谈家塘路155-2号",
    schoolNature: "私立",
    aliases: ["圣华紫竹"],
    note: "2025闵行官方义务教育学校基本情况表确认全称、区属、民办性质和校址；原记录区属浦东明显错误。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/闵行区教育局",
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "上海民办圣华紫竹双语学校",
      rawNature: "民办",
      rawAddress: "紫凤路500号； 谈家塘路155-2号",
    },
  },
  {
    id: 4839,
    reviewedName: "上海市民办立达中学",
    district: "黄浦",
    address: "车站支路90号 跨龙路185号（过渡校区）",
    schoolNature: "私立",
    aliases: ["民办立达"],
    note: "现有地址和百度学校POI均在黄浦；2025黄浦官方初中办学基本情况公示确认全称、区属、性质和地址。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/黄浦区教育局",
      title: "2025年黄浦区初中阶段学校办学基本情况公示",
      url: "https://www.shanghai.gov.cn/hpqywjy/20250416/5f05ce5edb724d40aa297cd684e50df6.html",
      date: "2025-04-16",
      matchedName: "上海市民办立达中学",
      rawNature: "民办初中",
      rawAddress: "车站支路90号 跨龙路185号（过渡校区）",
    },
  },
  {
    id: 5030,
    reviewedName: "上海市江宁学校（初中部）",
    district: "普陀",
    address: "西康路1518弄1号（总部）",
    schoolNature: "公立",
    aliases: ["江宁学校"],
    note: "保留当前初中部学段后缀；2025普陀官方表确认江宁学校为普陀公办九年一贯制，总部地址为西康路1518弄1号。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/普陀区教育局",
      title: "2025年普陀区义务教育阶段学校教育教学、后勤设施设备和师资配置基本情况表",
      url: "https://www.shanghai.gov.cn/ptqywjy/20251110/d17caa0f4c8c41d4ba91f0516f53ef12.html",
      date: "2025-11-10",
      matchedName: "上海市江宁学校",
      rawNature: "公办九年一贯制学校",
      rawAddress: "西康路1518弄1号（总部）",
    },
  },
  {
    id: 5034,
    reviewedName: "上海市民办新黄浦实验学校",
    district: "普陀",
    address: "交通西路95号",
    schoolNature: "私立",
    aliases: ["新黄浦实验"],
    note: "现有地址和百度学校POI均在普陀；2025普陀官方表确认全称、区属、民办九年一贯制和地址。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/普陀区教育局",
      title: "2025年普陀区义务教育阶段学校教育教学、后勤设施设备和师资配置基本情况表",
      url: "https://www.shanghai.gov.cn/ptqywjy/20251110/d17caa0f4c8c41d4ba91f0516f53ef12.html",
      date: "2025-11-10",
      matchedName: "上海市民办新黄浦实验学校",
      rawNature: "民办九年一贯制学校",
      rawAddress: "交通西路95号",
    },
  },
  {
    id: 5537,
    reviewedName: "上海市实验学校附属东滩学校（初中）",
    district: "崇明",
    address: "陈家镇雪雁路800号",
    schoolNature: "公立",
    aliases: ["上实东滩"],
    note: "原百度POI为公司企业且地址在黄浦写字楼；2025崇明官方初中基本情况表确认学校在陈家镇雪雁路800号。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/崇明区教育局",
      title: "2025年崇明区义务教育招生学校基本情况（初中）",
      url: "https://www.shanghai.gov.cn/cmqywjy/20250417/b52947a33336407185e4622bb0793dca.html",
      date: "2025-04-17",
      matchedName: "上海市实验学校附属东滩学校（初中）",
      rawNature: "公办 (九年)",
      rawAddress: "陈家镇雪雁路800号",
    },
  },
  {
    id: 5671,
    reviewedName: "上海市闵行区黄浦一中心世博小学",
    district: "闵行",
    address: "浦驰路177号",
    schoolNature: "公立",
    aliases: ["黄浦一中心"],
    note: "现有地址和百度学校POI均指向闵行浦驰路；2025闵行官方小学表确认全称、区属、公办性质和地址。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/闵行区教育局",
      title: "2025年闵行区义务教育阶段学校(小学）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/a8a110c367464ede8f98ec270dee505f.html",
      date: "2025-04-07",
      matchedName: "上海市闵行区黄浦一中心世博小学",
      rawNature: "公办",
      rawAddress: "浦驰路177号",
    },
  },
  {
    id: 4627,
    reviewedName: "上海市南汇第三中学",
    district: "浦东",
    address: "惠南镇梅花路185号",
    schoolNature: "公立",
    aliases: ["南汇三中"],
    note: "2025浦东官方初中招生入学信息公示确认全称、公办性质和地址。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/浦东新区教育局",
      title: "2025年浦东新区义务教育阶段学校招生入学信息公示（初中）",
      url: "https://www.shanghai.gov.cn/pdxqywjy/20250507/57ff6e427b4c4846b03a5d414c820531.html",
      date: "2025-05-07",
      matchedName: "上海市南汇第三中学",
      rawNature: "公办",
      rawAddress: "惠南镇梅花路185号",
    },
  },
  {
    id: 5655,
    reviewedName: "上海市南洋初级中学",
    district: "徐汇",
    address: "龙华中路200号",
    schoolNature: "公立",
    aliases: ["南洋初中"],
    note: "2025徐汇官方初中办学规模表确认南洋初级中学在徐汇；原记录区属浦东且缺地址，明显不匹配。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/徐汇区教育局",
      title: "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表",
      url: "https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
      date: "2025-04-11",
      matchedName: "上海市南洋初级中学",
      rawNature: "公办初中",
      rawAddress: "龙华中路200号",
    },
  },
  {
    id: 4678,
    reviewedName: "上海市民办明珠中学",
    district: "黄浦",
    address: "云南中路35号",
    schoolNature: "私立",
    aliases: ["民办明珠"],
    note: "2025黄浦官方初中办学基本情况公示确认全称、区属、民办性质和地址；原记录区属浦东且缺地址。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/黄浦区教育局",
      title: "2025年黄浦区初中阶段学校办学基本情况公示",
      url: "https://www.shanghai.gov.cn/hpqywjy/20250416/5f05ce5edb724d40aa297cd684e50df6.html",
      date: "2025-04-16",
      matchedName: "上海市民办明珠中学",
      rawNature: "民办初中",
      rawAddress: "云南中路35号",
    },
  },
  {
    id: 5793,
    reviewedName: "上海市宝山区虎林路第三小学",
    district: "宝山",
    address: "泗塘八村一号",
    aliases: ["虎林路三小"],
    note: "2025宝山官方小学招生计划确认全称和地址；官方记录未提供公民办性质，本次不填 school_nature。",
    source: {
      type: "official_school_info",
      name: "上海市人民政府/宝山区教育局",
      title: "2025年宝山区义务教育阶段学校校区范围与招生计划（小学）",
      url: "https://www.shanghai.gov.cn/bsqywjy/20250423/ac8a95f3a4494ef8bd356e112aec499c.html",
      date: "2025-04-23",
      matchedName: "上海市宝山区虎林路第三小学",
      rawAddress: "泗塘八村一号",
    },
  },
];

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function uniq(values: (string | null | undefined)[]) {
  return Array.from(new Set(values.map((value) => value?.trim()).filter(Boolean))) as string[];
}

function changedFields(before: SchoolRow, correction: Correction, aliases: string[]) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (before.name !== correction.reviewedName) changes.name = { from: before.name, to: correction.reviewedName };
  if (before.district !== correction.district) changes.district = { from: before.district, to: correction.district };
  if (correction.address && before.address !== correction.address) {
    changes.address = { from: before.address, to: correction.address };
  }
  if (correction.schoolNature && before.school_nature !== correction.schoolNature) {
    changes.school_nature = { from: before.school_nature, to: correction.schoolNature };
  }
  if (JSON.stringify(before.aliases ?? []) !== JSON.stringify(aliases)) {
    changes.aliases = { from: before.aliases ?? [], to: aliases };
  }
  return changes;
}

async function main() {
  mkdirSync(path.dirname(auditLogPath), { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const events: unknown[] = [];
  let changed = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");

    for (const correction of CORRECTIONS) {
      const currentResult = await client.query<SchoolRow>(
        `
          SELECT id, name, district, type, aliases, address, lat, lng, school_nature, tier, website, attrs
          FROM schools
          WHERE id = $1
          FOR UPDATE
        `,
        [correction.id],
      );
      const current = currentResult.rows[0];
      if (!current) {
        skipped += 1;
        continue;
      }

      const duplicateRows = await client.query<{ id: number; name: string; district: string; type: string }>(
        `
          SELECT id, name, district, type
          FROM schools
          WHERE id <> $1 AND name = $2
          ORDER BY id
        `,
        [current.id, correction.reviewedName],
      );
      const aliases = uniq([...(current.aliases ?? []), current.name, ...correction.aliases]);
      const changes = changedFields(current, correction, aliases);

      if (Object.keys(changes).length === 0) {
        skipped += 1;
        continue;
      }

      const sourcePayload = {
        source_type: correction.source.type,
        source_name: correction.source.name,
        source_title: correction.source.title,
        source_url: correction.source.url,
        source_date: correction.source.date,
        matched_name: correction.source.matchedName,
        raw_nature: correction.source.rawNature,
        raw_address: correction.source.rawAddress,
        reviewed_at: new Date().toISOString(),
        note: correction.note,
      };

      const attrsPatch = {
        ...(current.attrs ?? {}),
        reviewed_school_correction_source: sourcePayload,
        reviewed_school_correction_sources: [
          ...(((current.attrs?.reviewed_school_correction_sources as unknown[]) ?? []).filter(Boolean)),
          sourcePayload,
        ].slice(-20),
        ...(duplicateRows.rows.length
          ? { possible_duplicate_school_ids: uniq([...(current.attrs?.possible_duplicate_school_ids as string[] ?? []), ...duplicateRows.rows.map((row) => String(row.id))]) }
          : {}),
      };

      const event = {
        ts: new Date().toISOString(),
        operation: "reviewed_school_correction",
        mode: apply ? "apply" : "dry-run",
        school_id: current.id,
        school_name: current.name,
        changes,
        duplicate_existing_rows: duplicateRows.rows,
        source: correction.source,
        note: correction.note,
        before: {
          id: current.id,
          name: current.name,
          district: current.district,
          type: current.type,
          address: current.address,
          lat: current.lat,
          lng: current.lng,
          school_nature: current.school_nature,
          tier: current.tier,
          website: current.website,
          aliases: current.aliases ?? [],
        },
        after: {
          id: current.id,
          name: correction.reviewedName,
          district: correction.district,
          type: current.type,
          address: correction.address ?? current.address,
          lat: current.lat,
          lng: current.lng,
          school_nature: correction.schoolNature ?? current.school_nature,
          tier: current.tier,
          website: current.website,
          aliases,
        },
      };

      events.push(event);
      console.log(JSON.stringify(event));

      if (apply) {
        const result = await client.query(
          `
            UPDATE schools
            SET
              name = $1,
              district = $2,
              address = coalesce($3, address),
              school_nature = coalesce($4::school_nature, school_nature),
              aliases = $5,
              attrs = $6::jsonb,
              updated_at = now()
            WHERE id = $7
          `,
          [
            correction.reviewedName,
            correction.district,
            correction.address ?? null,
            correction.schoolNature ?? null,
            aliases,
            JSON.stringify(attrsPatch),
            current.id,
          ],
        );

        if ((result.rowCount ?? 0) > 0) {
          await client.query(
            `
              INSERT INTO web_data_source (
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
                updated_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, 'high', $8::jsonb, now(), now())
              ON CONFLICT (school_id, source_url, source_type)
              DO UPDATE SET
                source_name = excluded.source_name,
                source_title = excluded.source_title,
                source_date = excluded.source_date,
                evidence = excluded.evidence,
                confidence = excluded.confidence,
                raw = excluded.raw,
                updated_at = now()
            `,
            [
              current.id,
              correction.source.type,
              correction.source.name,
              correction.source.url,
              correction.source.title,
              correction.source.date ?? null,
              correction.note,
              JSON.stringify(sourcePayload),
            ],
          );
          appendFileSync(auditLogPath, `${JSON.stringify(event)}\n`);
          changed += 1;
        }
      } else {
        changed += 1;
      }
    }

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    const summary = {
      mode: apply ? "apply" : "dry-run",
      auditLogPath,
      reportDir,
      changed,
      skipped,
    };
    writeFileSync(path.join(reportDir, apply ? "applied-events.json" : "dry-run-events.json"), JSON.stringify(events, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
