/**
 * Apply manually reviewed high-confidence school corrections, round 8.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to write
 * - updates by school id only
 * - no deletes, no merges
 * - appends every changed row to a persistent audit log under data/audit
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
  "reviewed-school-corrections-round8",
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

const GOV = "上海市人民政府/区教育局";

const CORRECTIONS: Correction[] = [
  {
    id: 4638,
    reviewedName: "上海市吴淞中学附属宝山实验学校（原上海市海滨第二中学）",
    district: "宝山",
    address: "永清路156号",
    schoolNature: "公立",
    aliases: ["海滨二中", "上海市海滨第二中学"],
    note: "现有行 district=浦东 且缺地址坐标；2025宝山区义务教育阶段学校校区范围与招生计划（初中）列出上海市吴淞中学附属宝山实验学校（原上海市海滨第二中学），地址永清路156号。本次按官方源修正全称、区属、地址和公办性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年宝山区义务教育阶段学校校区范围与招生计划（初中）",
      url: "https://www.shanghai.gov.cn/bsqywjy/20250423/497250a7552b43c59fca0a904b1eee82.html",
      date: "2025-04-23",
      matchedName: "上海市吴淞中学附属宝山实验学校（原上海市海滨第二中学）",
      rawNature: "公办初中",
      rawAddress: "永清路156号",
    },
  },
  {
    id: 4689,
    reviewedName: "上海市民办新北郊初级中学",
    district: "虹口",
    address: "东体育会路429号",
    schoolNature: "私立",
    aliases: ["新北郊初级", "民办新北郊"],
    note: "现有行名称为简称且 school_nature=公立；2025虹口区义务教育阶段民办中小学基本情况确认全称上海市民办新北郊初级中学，地址东体育会路429号，性质民办。本次修正全称、地址和性质，记录重复候选但不合并删除。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年虹口区义务教育阶段民办中小学基本情况",
      url: "https://www.shhk.gov.cn/hkjy_nas/4598de7d-1bcc-4128-a18d-77828712c114/5b1f9107-1e5c-4476-8000-8af02605e94b/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E6%B0%91%E5%8A%9E%E4%B8%AD%E5%B0%8F%E5%AD%A6%E5%9F%BA%E6%9C%AC%E6%83%85%E5%86%B5.pdf",
      date: "2025",
      matchedName: "上海市民办新北郊初级中学",
      rawNature: "民办",
      rawAddress: "东体育会路429号",
    },
  },
  {
    id: 4691,
    reviewedName: "上海市长青学校",
    district: "虹口",
    address: "大连路975弄58号",
    schoolNature: "公立",
    aliases: ["长青学校"],
    note: "现有行 district=浦东 但地址和百度学校 POI 均指向虹口；2025虹口区义务教育阶段公办初中招生计划和联系方式确认上海市长青学校，临时安置点大连路975弄58号，性质公办九年一贯制。本次修正全称、区属、地址和性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年虹口区义务教育阶段公办初中招生计划和联系方式",
      url: "https://www.shhk.gov.cn/hkjy_nas/13bebba5-5f61-49ee-8552-4fee4665e1ac/64054e0e-3738-43c8-ba40-c345b0d09b27/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E5%85%AC%E5%8A%9E%E5%88%9D%E4%B8%AD%E6%8B%9B%E7%94%9F%E8%AE%A1%E5%88%92%E5%92%8C%E8%81%94%E7%B3%BB%E6%96%B9%E5%BC%8F.pdf",
      date: "2025",
      matchedName: "上海市长青学校",
      rawNature: "公办九年一贯制",
      rawAddress: "临时安置点：大连路975弄58号",
    },
  },
  {
    id: 4784,
    reviewedName: "上海五浦汇实验学校",
    district: "青浦",
    address: "上海市青浦区盘龙浦路500号",
    schoolNature: "私立",
    aliases: ["五浦汇实验", "上海五浦汇实验学校（初中）"],
    note: "现有行 district=浦东 但地址盘龙浦路500号位于青浦；青浦区民办初中招生计划和青浦区教育机构一览表确认全称上海五浦汇实验学校，地址上海市青浦区盘龙浦路500号，并列为民办初中招生。本次修正区属、全称、地址和性质。",
    source: {
      type: "official_school_info",
      name: "青浦区教育局",
      title: "2025年青浦区民办初中招生计划一览表 / 2024青浦区教育机构一览表",
      url: "https://www.shqp.gov.cn/edu/eduzwgk/lm/jy/zs/cz/20250407/1276481.html",
      date: "2025-04-07",
      matchedName: "上海五浦汇实验学校（初中）",
      rawNature: "民办",
      rawAddress: "上海市青浦区盘龙浦路500号",
    },
  },
  {
    id: 4785,
    reviewedName: "上海青浦兰生学校",
    district: "青浦",
    address: "上海市青浦区朱家角路1588号",
    schoolNature: "私立",
    aliases: ["青浦兰生", "上海青浦兰生学校（初中）"],
    note: "现有名称为简称；2025青浦区民办初中招生计划和青浦区教育机构一览表确认上海青浦兰生学校（初中），地址上海市青浦区朱家角路1588号，属民办初中招生。本次补全全称、规范地址和性质。",
    source: {
      type: "official_school_info",
      name: "青浦区教育局",
      title: "2025年青浦区民办初中招生计划一览表 / 2024青浦区教育机构一览表",
      url: "https://www.shqp.gov.cn/edu/eduzwgk/lm/jy/zs/cz/20250407/1276481.html",
      date: "2025-04-07",
      matchedName: "上海青浦兰生学校（初中）",
      rawNature: "民办",
      rawAddress: "上海市青浦区朱家角路1588号",
    },
  },
  {
    id: 4786,
    reviewedName: "上海青浦区世外学校",
    district: "青浦",
    address: "上海市青浦区龙联路915号",
    lat: null,
    lng: null,
    schoolNature: "私立",
    aliases: ["青浦世外", "上海青浦区世外学校（初中）"],
    note: "现有行名称为青浦世外但地址/POI 指向上海青浦区世外高级中学；2025青浦区民办初中招生计划确认初中为上海青浦区世外学校（初中），青浦区教育机构一览表列出初中地址为龙联路915号。本次改回义务教育初中实体，并清空原高级中学坐标以待后续百度地图核验。",
    source: {
      type: "official_school_info",
      name: "青浦区教育局",
      title: "2025年青浦区民办初中招生计划一览表 / 2024青浦区教育机构一览表",
      url: "https://www.shqp.gov.cn/edu/eduzwgk/lm/jy/zs/cz/20250407/1276481.html",
      date: "2025-04-07",
      matchedName: "上海青浦区世外学校（初中）",
      rawNature: "民办",
      rawAddress: "上海市青浦区龙联路915号",
    },
  },
  {
    id: 5110,
    reviewedName: "上海市虹口实验学校",
    district: "虹口",
    address: "辉河路65号",
    schoolNature: "公立",
    aliases: ["虹口实验", "上海市虹口实验学校（初中部）"],
    note: "现有名称为简称；2025虹口区义务教育阶段公办初中招生计划和联系方式确认上海市虹口实验学校，地址辉河路65号，性质公办九年一贯制。本次补全全称、规范地址和性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年虹口区义务教育阶段公办初中招生计划和联系方式",
      url: "https://www.shhk.gov.cn/hkjy_nas/13bebba5-5f61-49ee-8552-4fee4665e1ac/64054e0e-3738-43c8-ba40-c345b0d09b27/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E5%85%AC%E5%8A%9E%E5%88%9D%E4%B8%AD%E6%8B%9B%E7%94%9F%E8%AE%A1%E5%88%92%E5%92%8C%E8%81%94%E7%B3%BB%E6%96%B9%E5%BC%8F.pdf",
      date: "2025",
      matchedName: "上海市虹口实验学校",
      rawNature: "公办九年一贯制",
      rawAddress: "辉河路65号",
    },
  },
  {
    id: 5111,
    reviewedName: "上海市鲁迅初级中学",
    district: "虹口",
    address: "宝安路66弄7号",
    lat: null,
    lng: null,
    schoolNature: "公立",
    aliases: ["鲁迅中学"],
    note: "现有行 type=middle 但地址/POI 指向鲁迅中学高中；2025虹口区初中校园开放日官方安排列出上海市鲁迅初级中学，开放地点宝安路66弄7号。本次按初中实体修正全称和地址，并清空原高中坐标以待后续地图核验。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年虹口区初中“校园开放日”活动安排",
      url: "https://www.shhk.gov.cn/hkjy_nas/91c5d222-bc66-445c-90f5-8f61443b6640/eb1ee30e-f750-4af0-9929-5bdc52a61758/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E5%88%9D%E4%B8%AD%E2%80%9C%E6%A0%A1%E5%9B%AD%E5%BC%80%E6%94%BE%E6%97%A5%E2%80%9D%E6%B4%BB%E5%8A%A8%E5%AE%89%E6%8E%92.pdf",
      date: "2025",
      matchedName: "上海市鲁迅初级中学",
      rawNature: "公办初中",
      rawAddress: "宝安路66弄7号",
    },
  },
  {
    id: 5113,
    reviewedName: "上海市北郊学校",
    district: "虹口",
    address: "大连西路205号",
    schoolNature: "公立",
    aliases: ["北郊学校"],
    note: "现有名称为简称且地址只有门牌弄号；2025虹口区义务教育阶段公办初中招生计划和联系方式确认上海市北郊学校，地址大连西路205号，性质公办九年一贯制。本次补全全称、规范地址和性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年虹口区义务教育阶段公办初中招生计划和联系方式",
      url: "https://www.shhk.gov.cn/hkjy_nas/13bebba5-5f61-49ee-8552-4fee4665e1ac/64054e0e-3738-43c8-ba40-c345b0d09b27/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E5%85%AC%E5%8A%9E%E5%88%9D%E4%B8%AD%E6%8B%9B%E7%94%9F%E8%AE%A1%E5%88%92%E5%92%8C%E8%81%94%E7%B3%BB%E6%96%B9%E5%BC%8F.pdf",
      date: "2025",
      matchedName: "上海市北郊学校",
      rawNature: "公办九年一贯制",
      rawAddress: "大连西路205号",
    },
  },
  {
    id: 5648,
    reviewedName: "上海市位育初级中学",
    district: "徐汇",
    address: "总校：复兴中路1261号；北校区：长乐路455号",
    schoolNature: "公立",
    website: "https://wycz.xhedu.sh.cn/cms/",
    aliases: ["位育初中", "位育初级中学"],
    note: "现有行 district=宝山 且缺地址坐标；2025徐汇区义务教育阶段学校（初中）办学规模公示确认上海市位育初级中学，性质公办初中，地址为总校复兴中路1261号、北校区长乐路455号，并列出官网。本次按官方源修正全称、区属、地址、性质和官网。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年徐汇区义务教育阶段学校（初中）办学规模、招生计划、校舍场地条件及设备配置公示汇总表",
      url: "https://www.shanghai.gov.cn/xhqywjy/20250411/832e8a6c9de94342b77c087100ff956c.html",
      date: "2025-04-11",
      matchedName: "上海市位育初级中学",
      rawNature: "公办初中",
      rawAddress: "总校：复兴中路1261号；北校区：长乐路455号",
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
  if (correction.address && before.address !== correction.address) changes.address = { from: before.address, to: correction.address };
  if ("lat" in correction && before.lat !== correction.lat) changes.lat = { from: before.lat, to: correction.lat };
  if ("lng" in correction && before.lng !== correction.lng) changes.lng = { from: before.lng, to: correction.lng };
  if (correction.schoolNature && before.school_nature !== correction.schoolNature) {
    changes.school_nature = { from: before.school_nature, to: correction.schoolNature };
  }
  if (correction.website && before.website !== correction.website) changes.website = { from: before.website, to: correction.website };
  if (JSON.stringify(before.aliases ?? []) !== JSON.stringify(aliases)) changes.aliases = { from: before.aliases ?? [], to: aliases };
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
      const aliases = uniq([...(current.aliases ?? []), current.name === correction.reviewedName ? undefined : current.name, ...correction.aliases]);
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

      const after = {
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
      };
      const event = {
        ts: new Date().toISOString(),
        operation: "reviewed_school_correction_round8",
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
        after,
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

    const summary = { mode: apply ? "apply" : "dry-run", auditLogPath, reportDir, changed, skipped };
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
