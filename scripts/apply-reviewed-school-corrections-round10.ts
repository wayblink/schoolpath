/**
 * Apply manually reviewed high-confidence school corrections, round 10.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to write
 * - updates by school id only
 * - no deletes, no merges
 * - appends every changed row to data/audit/school-data-audit-log.jsonl
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
  "reviewed-school-corrections-round10",
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-"),
);

type SchoolType = "primary" | "middle" | "nine_year";

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: SchoolType;
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
  type?: SchoolType;
  address: string;
  lat?: number | null;
  lng?: number | null;
  schoolNature: "公立" | "私立";
  aliases: string[];
  note: string;
  source: {
    type: string;
    name: string;
    title: string;
    url: string;
    date?: string;
    matchedName: string;
    rawNature: string;
    rawAddress: string;
  };
};

const GOV = "上海市人民政府/区教育局";
const HONGKOU_PUBLIC =
  "https://www.shhk.gov.cn/hkjy_nas/13bebba5-5f61-49ee-8552-4fee4665e1ac/64054e0e-3738-43c8-ba40-c345b0d09b27/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E5%85%AC%E5%8A%9E%E5%88%9D%E4%B8%AD%E6%8B%9B%E7%94%9F%E8%AE%A1%E5%88%92%E5%92%8C%E8%81%94%E7%B3%BB%E6%96%B9%E5%BC%8F.pdf";
const HONGKOU_PRIVATE =
  "https://www.shhk.gov.cn/hkjy_nas/4598de7d-1bcc-4128-a18d-77828712c114/5b1f9107-1e5c-4476-8000-8af02605e94b/2025%E5%B9%B4%E8%99%B9%E5%8F%A3%E5%8C%BA%E4%B9%89%E5%8A%A1%E6%95%99%E8%82%B2%E9%98%B6%E6%AE%B5%E6%B0%91%E5%8A%9E%E4%B8%AD%E5%B0%8F%E5%AD%A6%E5%9F%BA%E6%9C%AC%E6%83%85%E5%86%B5.pdf";

const CORRECTIONS: Correction[] = [
  {
    id: 4685,
    reviewedName: "上海外国语大学附属外国语学校",
    district: "虹口",
    address: "中山北一路295号",
    schoolNature: "公立",
    aliases: ["上外附中", "上外附属外国语学校"],
    note: "现有行名称为简称且缺地址；同区同类型既有完整行和2025虹口区义务教育阶段公办初中招生计划均指向上海外国语大学附属外国语学校，地址中山北一路295号，性质公办。本次补全全称、地址和公办性质，重复候选仅记录不合并。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年虹口区义务教育阶段公办初中招生计划和联系方式",
      url: HONGKOU_PUBLIC,
      date: "2025",
      matchedName: "上海外国语大学附属外国语学校",
      rawNature: "公办初中",
      rawAddress: "中山北一路295号",
    },
  },
  {
    id: 4690,
    reviewedName: "上海外国语大学第一实验学校",
    district: "虹口",
    address: "西江湾路800号",
    schoolNature: "私立",
    aliases: ["上外克勒", "克勒外国语学校"],
    note: "现有行名称为简称且缺地址；2025虹口区义务教育阶段民办中小学基本情况确认民办上外克勒对应上海外国语大学第一实验学校，地址西江湾路800号。本次补全全称、地址和民办性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年虹口区义务教育阶段民办中小学基本情况",
      url: HONGKOU_PRIVATE,
      date: "2025",
      matchedName: "上海外国语大学第一实验学校",
      rawNature: "民办",
      rawAddress: "西江湾路800号",
    },
  },
  {
    id: 5085,
    reviewedName: "上海市复旦初级中学",
    district: "长宁",
    type: "middle",
    address: "淞虹路475号",
    lat: null,
    lng: null,
    schoolNature: "公立",
    aliases: ["复旦初中"],
    note: "现有行 type=primary 且地址/坐标指向复旦中学高中；长宁区义务教育阶段公办初中信息确认初中实体为上海市复旦初级中学，地址淞虹路475号，性质公办。本次修正类型、全称、地址和性质，并清空旧高中坐标以待后续地图核验。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年长宁区义务教育阶段公办初中办学基本情况",
      url: "https://zwgk.shcn.gov.cn/xxgk/xxrxks-zsks/2025/97/77197.html",
      date: "2025",
      matchedName: "上海市复旦初级中学",
      rawNature: "公办初中",
      rawAddress: "淞虹路475号",
    },
  },
  {
    id: 5112,
    reviewedName: "上海市曲阳第二中学",
    district: "虹口",
    address: "玉田路180号",
    schoolNature: "公立",
    aliases: ["曲阳二中"],
    note: "现有行名称为简称且缺地址/性质；同区同类型既有完整行和2025虹口区义务教育阶段公办初中招生计划均确认上海市曲阳第二中学，地址玉田路180号，性质公办。本次补全全称、地址和公办性质，重复候选仅记录不合并。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年虹口区义务教育阶段公办初中招生计划和联系方式",
      url: HONGKOU_PUBLIC,
      date: "2025",
      matchedName: "上海市曲阳第二中学",
      rawNature: "公办初中",
      rawAddress: "玉田路180号",
    },
  },
  {
    id: 5588,
    reviewedName: "上海市西延安中学",
    district: "长宁",
    address: "金钟路299号",
    lat: null,
    lng: null,
    schoolNature: "公立",
    aliases: ["西延安"],
    note: "现有行名称为简称且地址/坐标指向延安中学高中；长宁区义务教育阶段公办初中信息确认初中实体为上海市西延安中学，地址金钟路299号，性质公办。本次修正全称、地址和性质，并清空旧高中坐标以待后续地图核验。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年长宁区义务教育阶段公办初中办学基本情况",
      url: "https://zwgk.shcn.gov.cn/xxgk/xxrxks-zsks/2025/97/77197.html",
      date: "2025",
      matchedName: "上海市西延安中学",
      rawNature: "公办初中",
      rawAddress: "金钟路299号",
    },
  },
  {
    id: 5589,
    reviewedName: "上海市第三女子初级中学",
    district: "长宁",
    address: "江苏路155号",
    schoolNature: "公立",
    aliases: ["市三初", "市三女初"],
    note: "现有行名称为简称且缺地址/性质；长宁区义务教育阶段公办初中信息确认上海市第三女子初级中学，地址江苏路155号，性质公办。本次补全全称、地址和公办性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年长宁区义务教育阶段公办初中办学基本情况",
      url: "https://zwgk.shcn.gov.cn/xxgk/xxrxks-zsks/2025/97/77197.html",
      date: "2025",
      matchedName: "上海市第三女子初级中学",
      rawNature: "公办初中",
      rawAddress: "江苏路155号",
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
  if (correction.type && before.type !== correction.type) changes.type = { from: before.type, to: correction.type };
  if (before.address !== correction.address) changes.address = { from: before.address, to: correction.address };
  if ("lat" in correction && before.lat !== correction.lat) changes.lat = { from: before.lat, to: correction.lat };
  if ("lng" in correction && before.lng !== correction.lng) changes.lng = { from: before.lng, to: correction.lng };
  if (before.school_nature !== correction.schoolNature) {
    changes.school_nature = { from: before.school_nature, to: correction.schoolNature };
  }
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
        type: correction.type ?? current.type,
        address: correction.address,
        lat: "lat" in correction ? correction.lat : current.lat,
        lng: "lng" in correction ? correction.lng : current.lng,
        school_nature: correction.schoolNature,
        tier: current.tier,
        website: current.website,
        aliases,
      };
      const event = {
        ts: new Date().toISOString(),
        operation: "reviewed_school_correction_round10",
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
              type = $3,
              address = $4,
              lat = $5,
              lng = $6,
              school_nature = $7::school_nature,
              aliases = $8,
              attrs = $9::jsonb,
              updated_at = now()
            WHERE id = $10
          `,
          [
            correction.reviewedName,
            correction.district,
            correction.type ?? current.type,
            correction.address,
            "lat" in correction ? correction.lat : current.lat,
            "lng" in correction ? correction.lng : current.lng,
            correction.schoolNature,
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
