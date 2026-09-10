/**
 * Apply manually reviewed high-confidence school corrections, round 7.
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
  "reviewed-school-corrections-round7",
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
  lat?: number | null;
  lng?: number | null;
  schoolNature?: "公立" | "私立";
  website?: string;
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

const SHANGHAI_GOV = "上海市人民政府/区教育局";

const CORRECTIONS: Correction[] = [
  {
    id: 4672,
    reviewedName: "上海音乐学院实验学校",
    district: "杨浦",
    address: "杨浦区政和路359号",
    schoolNature: "公立",
    website: "http://www.zysy.edu.sh.cn/",
    aliases: ["上音实验", "上海音乐学院实验学校（初中部）"],
    note: "现有简称为“上音实验”，且地址为民庆路333号；上海市教委公办初中清单和杨浦区开放日官方汇总均确认全称为上海音乐学院实验学校（初中部），地址政和路359号，性质公办，并列出学校网址。本次按官方源修正简称、地址、性质和官网。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2024年杨浦区义务教育阶段学校“校园开放日”活动汇总（初中）",
      url: "https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-czzs/20240410/452191/57185e4d1a754809bbefececd1df85e3.pdf",
      date: "2024-04-10",
      matchedName: "上海音乐学院实验学校（初中部）",
      rawNature: "公办",
      rawAddress: "政和路359号",
    },
  },
  {
    id: 4684,
    reviewedName: "上海市敬业初级中学",
    district: "黄浦",
    address: "尚文路73号",
    schoolNature: "公立",
    aliases: ["敬业中学"],
    note: "现有行 type=middle 但名称和地址指向敬业高中；2025黄浦官方初中阶段学校办学基本情况公示确认初中全称为上海市敬业初级中学，地址尚文路73号，性质公办初中。本次按初中官方源修正名称与地址，原简称进入别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年黄浦区初中阶段学校办学基本情况公示",
      url: "https://www.shanghai.gov.cn/hpqywjy/20250416/5f05ce5edb724d40aa297cd684e50df6.html",
      date: "2025-04-16",
      matchedName: "上海市敬业初级中学",
      rawNature: "公办初中",
      rawAddress: "尚文路73号",
    },
  },
  {
    id: 4751,
    reviewedName: "上海民办兰生中学",
    district: "杨浦",
    address: "杨浦区世界路8号",
    schoolNature: "私立",
    website: "http://lansheng.fdfz.cn/",
    aliases: ["民办兰生", "上海民办兰生复旦中学"],
    note: "现有行 district=浦东 但地址和学校均指向杨浦兰生；2025杨浦官方招生简章及学校官网确认全称上海民办兰生中学，原名上海民办兰生复旦中学，校址世界路8号，并列出学校网址。本次纠正区属、名称、地址、性质和官网。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年上海民办兰生中学招生简章",
      url: "https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-czzs/20250408/477867.html",
      date: "2025-04-08",
      matchedName: "上海民办兰生中学",
      rawNature: "民办",
      rawAddress: "杨浦区世界路8号",
    },
  },
  {
    id: 4770,
    reviewedName: "华东师范大学第二附属中学前滩学校",
    district: "浦东",
    address: "晴雪路28号",
    schoolNature: "公立",
    aliases: ["华二前滩", "华二附属前滩学校"],
    note: "现有简称“华二前滩”且百度 POI 为 AED，不是学校主 POI；2025浦东官方义务教育阶段初中信息确认全称华东师范大学第二附属中学前滩学校，性质公办，地址晴雪路28号。本次用官方源覆盖简称、地址和性质。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年浦东新区义务教育阶段学校招生入学信息公示（初中）",
      url: "https://www.shanghai.gov.cn/pdxqywjy/20250507/57ff6e427b4c4846b03a5d414c820531.html",
      date: "2025-05-07",
      matchedName: "华东师范大学第二附属中学前滩学校",
      rawNature: "公办",
      rawAddress: "晴雪路28号",
    },
  },
  {
    id: 5107,
    reviewedName: "上海市民办迅行中学",
    district: "虹口",
    address: "玉田路211号",
    schoolNature: "私立",
    aliases: ["民办迅行", "迅行中学"],
    note: "现有简称为“民办迅行”；2025虹口区义务教育阶段民办中小学基本情况确认全称上海市民办迅行中学、地址玉田路211号。本次补全学校全称和民办性质，保留简称为别名，不合并任何重复候选。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年虹口区义务教育阶段民办中小学基本情况",
      url: "https://www.shhk.gov.cn/hkjy_nas/4598de7d-1bcc-4128-a18d-77828712c114/5b1f9107-1e5c-4476-8000-8af02605e94b/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E6%B0%91%E5%8A%9E%E4%B8%AD%E5%B0%8F%E5%AD%A6%E5%9F%BA%E6%9C%AC%E6%83%85%E5%86%B5.pdf",
      date: "2025",
      matchedName: "上海市民办迅行中学",
      rawNature: "民办",
      rawAddress: "玉田路211号",
    },
  },
  {
    id: 5108,
    reviewedName: "上海市民办新北郊初级中学",
    district: "虹口",
    address: "东体育会路429号",
    schoolNature: "私立",
    aliases: ["民办新北郊", "新北郊初级"],
    note: "现有简称为“民办新北郊”；2025虹口区义务教育阶段民办中小学基本情况确认全称上海市民办新北郊初级中学、地址东体育会路429号。本次补全全称、地址和民办性质，保留简称为别名，不合并任何重复候选。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年虹口区义务教育阶段民办中小学基本情况",
      url: "https://www.shhk.gov.cn/hkjy_nas/4598de7d-1bcc-4128-a18d-77828712c114/5b1f9107-1e5c-4476-8000-8af02605e94b/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E6%B0%91%E5%8A%9E%E4%B8%AD%E5%B0%8F%E5%AD%A6%E5%9F%BA%E6%9C%AC%E6%83%85%E5%86%B5.pdf",
      date: "2025",
      matchedName: "上海市民办新北郊初级中学",
      rawNature: "民办",
      rawAddress: "东体育会路429号",
    },
  },
  {
    id: 5161,
    reviewedName: "上海市惠民中学",
    district: "杨浦",
    address: "怀德路568号",
    schoolNature: "公立",
    website: "http://www.hmzx.edu.sh.cn/",
    aliases: ["惠民中学"],
    note: "现有名称为简称“惠民中学”；上海市教委公办初中清单确认全称上海市惠民中学、地址怀德路568号、性质公办，杨浦区开放日官方汇总列出同一学校网址。本次补全全称、地址、性质和官网。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2024年杨浦区义务教育阶段学校“校园开放日”活动汇总（初中）",
      url: "https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-czzs/20240410/452191/57185e4d1a754809bbefececd1df85e3.pdf",
      date: "2024-04-10",
      matchedName: "上海市惠民中学",
      rawNature: "公办",
      rawAddress: "怀德路568号",
    },
  },
  {
    id: 5170,
    reviewedName: "上海市长阳实验学校",
    district: "杨浦",
    address: "怀德路1000号",
    schoolNature: "私立",
    website: "http://fwpt.yp.edu.sh.cn/kjmb/",
    aliases: ["长阳实验", "上海市长阳实验学校（初中部）", "上海控江中学附属民办学校"],
    note: "现有名称为简称“长阳实验”；2025/2026杨浦区政府招生简章确认全称上海市长阳实验学校（初中部）、地址怀德路1000号、官网，并归于民办招生。本次补全全称、性质、地址和官网。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年上海市长阳实验学校初中部招生简章",
      url: "https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-czzs/20250408/477872.html",
      date: "2025-04-08",
      matchedName: "上海市长阳实验学校",
      rawNature: "民办",
      rawAddress: "怀德路1000号",
    },
  },
  {
    id: 5266,
    reviewedName: "上海市民办迅行中学",
    district: "虹口",
    address: "玉田路211号",
    schoolNature: "私立",
    aliases: ["迅行中学", "民办迅行"],
    note: "现有行 district=杨浦 但地址和学校 POI 均为虹口玉田路211号；2025虹口区义务教育阶段民办中小学基本情况确认全称上海市民办迅行中学、地址玉田路211号。本次纠正区属和全称，不合并重复候选。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年虹口区义务教育阶段民办中小学基本情况",
      url: "https://www.shhk.gov.cn/hkjy_nas/4598de7d-1bcc-4128-a18d-77828712c114/5b1f9107-1e5c-4476-8000-8af02605e94b/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E6%B0%91%E5%8A%9E%E4%B8%AD%E5%B0%8F%E5%AD%A6%E5%9F%BA%E6%9C%AC%E6%83%85%E5%86%B5.pdf",
      date: "2025",
      matchedName: "上海市民办迅行中学",
      rawNature: "民办",
      rawAddress: "玉田路211号",
    },
  },
  {
    id: 5552,
    reviewedName: "上海市民办新华初级中学",
    district: "虹口",
    address: "中州路102号",
    schoolNature: "私立",
    aliases: ["新华初", "新华初级"],
    note: "现有行 district=浦东 但地址和学校 POI 均为虹口中州路102号；2025虹口区义务教育阶段民办中小学基本情况确认全称上海市民办新华初级中学、地址中州路102号。本次纠正区属、全称、地址和民办性质。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年虹口区义务教育阶段民办中小学基本情况",
      url: "https://www.shhk.gov.cn/hkjy_nas/4598de7d-1bcc-4128-a18d-77828712c114/5b1f9107-1e5c-4476-8000-8af02605e94b/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E6%B0%91%E5%8A%9E%E4%B8%AD%E5%B0%8F%E5%AD%A6%E5%9F%BA%E6%9C%AC%E6%83%85%E5%86%B5.pdf",
      date: "2025",
      matchedName: "上海市民办新华初级中学",
      rawNature: "民办",
      rawAddress: "中州路102号",
    },
  },
  {
    id: 5688,
    reviewedName: "上海市民办新世纪小学",
    district: "长宁",
    address: "上海市长宁区兴国路374弄2号(近淮海中路)",
    schoolNature: "私立",
    aliases: ["新世纪小学"],
    note: "现有名称为简称“新世纪小学”；2025长宁区教育局招生简章确认全称上海市民办新世纪小学、位于兴国路374弄2号，并列入民办小学招生计划。本次补全全称、地址和民办性质。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "上海市民办新世纪小学2025学年秋季招生简章",
      url: "https://zwgk.shcn.gov.cn/xxgk/xxrxks-zsks/2025/97/77175.html",
      date: "2025-04-07",
      matchedName: "上海市民办新世纪小学",
      rawNature: "民办",
      rawAddress: "上海市长宁区兴国路374弄2号(近淮海中路)",
    },
  },
  {
    id: 5741,
    reviewedName: "上海市民办阳浦小学",
    district: "杨浦",
    address: "上海市杨浦区河间路379号",
    schoolNature: "私立",
    website: "http://www.ypxx.edu.sh.cn/",
    aliases: ["阳浦小学", "民办阳浦小学"],
    note: "现有名称为简称“阳浦小学”；2025杨浦区政府招生简章确认全称上海市民办阳浦小学，地址河间路379号，官网为 ypxx.edu.sh.cn，并归于民办小学招生。本次补全全称、地址、性质和官网。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年上海市民办阳浦小学招生简章",
      url: "https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-xxzs/20250408/477860.html",
      date: "2025-04-08",
      matchedName: "上海市民办阳浦小学",
      rawNature: "民办",
      rawAddress: "上海市杨浦区河间路379号",
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
  if ("lat" in correction && before.lat !== correction.lat) changes.lat = { from: before.lat, to: correction.lat };
  if ("lng" in correction && before.lng !== correction.lng) changes.lng = { from: before.lng, to: correction.lng };
  if (correction.schoolNature && before.school_nature !== correction.schoolNature) {
    changes.school_nature = { from: before.school_nature, to: correction.schoolNature };
  }
  if (correction.website && before.website !== correction.website) {
    changes.website = { from: before.website, to: correction.website };
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
      const aliases = uniq([
        ...(current.aliases ?? []),
        current.name === correction.reviewedName ? undefined : current.name,
        ...correction.aliases,
      ]);
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
          ? {
              possible_duplicate_school_ids: uniq([
                ...(((current.attrs?.possible_duplicate_school_ids as string[]) ?? []).filter(Boolean)),
                ...duplicateRows.rows.map((row) => String(row.id)),
              ]),
            }
          : {}),
      };

      const event = {
        ts: new Date().toISOString(),
        operation: "reviewed_school_correction_round7",
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
          lat: "lat" in correction ? correction.lat : current.lat,
          lng: "lng" in correction ? correction.lng : current.lng,
          school_nature: correction.schoolNature ?? current.school_nature,
          tier: current.tier,
          website: correction.website ?? current.website,
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
              lat = $4,
              lng = $5,
              school_nature = coalesce($6::school_nature, school_nature),
              website = coalesce($7, website),
              aliases = $8,
              attrs = $9::jsonb,
              updated_at = now()
            WHERE id = $10
          `,
          [
            correction.reviewedName,
            correction.district,
            correction.address ?? null,
            "lat" in correction ? correction.lat : current.lat,
            "lng" in correction ? correction.lng : current.lng,
            correction.schoolNature ?? null,
            correction.website ?? null,
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
