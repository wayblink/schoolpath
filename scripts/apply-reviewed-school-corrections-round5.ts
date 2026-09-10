/**
 * Apply manually reviewed high-confidence school corrections, round 5.
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
  "reviewed-school-corrections-round5",
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
const PUDONG_2025_MIDDLE_TITLE = "2025年浦东新区义务教育阶段学校招生入学信息公示（初中）";
const PUDONG_2025_MIDDLE_URL = "https://www.shanghai.gov.cn/pdxqywjy/20250507/57ff6e427b4c4846b03a5d414c820531.html";
const MINHANG_2025_MIDDLE_TITLE =
  "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况";
const MINHANG_2025_MIDDLE_URL = "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html";

const CORRECTIONS: Correction[] = [
  {
    id: 4626,
    reviewedName: "上海市南汇第四中学",
    district: "浦东",
    address: "沿河泾南路18号",
    lat: null,
    lng: null,
    schoolNature: "公立",
    aliases: ["南汇四中"],
    note: "2025浦东官方初中招生入学信息中南汇第四中学有本部、北校区、东校区；现有行地址为沿河泾南路18号且简称为南汇四中，和本部记录匹配。当前坐标来自 AED POI，非学校点位，故清空等待后续地图核验。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: PUDONG_2025_MIDDLE_TITLE,
      url: PUDONG_2025_MIDDLE_URL,
      date: "2025-05-07",
      matchedName: "上海市南汇第四中学",
      rawNature: "公办",
      rawAddress: "沿河泾南路18号",
    },
  },
  {
    id: 4629,
    reviewedName: "上海市陆行中学南校",
    district: "浦东",
    address: "金台路96号",
    schoolNature: "公立",
    aliases: ["陆行南校", "陆行中学南校"],
    note: "2025浦东官方初中招生入学信息确认上海市陆行中学南校、公办性质和金台路96号地址；现有地图 POI 也是陆行中学南校，故保留坐标并补全全称。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: PUDONG_2025_MIDDLE_TITLE,
      url: PUDONG_2025_MIDDLE_URL,
      date: "2025-05-07",
      matchedName: "上海市陆行中学南校",
      rawNature: "公办",
      rawAddress: "金台路96号",
    },
  },
  {
    id: 4630,
    reviewedName: "华东师范大学附属东昌中学南校（潍坊校区）",
    district: "浦东",
    address: "南泉北路1020号",
    schoolNature: "公立",
    aliases: ["东昌南校", "东昌中学南校"],
    note: "2025浦东官方初中招生入学信息中东昌中学南校有潍坊、张江两个校区；现有地址南泉北路1020号匹配潍坊校区，地图 POI 也为东昌中学南校，故补全校区全称并保留坐标。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: PUDONG_2025_MIDDLE_TITLE,
      url: PUDONG_2025_MIDDLE_URL,
      date: "2025-05-07",
      matchedName: "华东师范大学附属东昌中学南校（潍坊校区）",
      rawNature: "公办",
      rawAddress: "南泉北路1020号",
    },
  },
  {
    id: 4775,
    reviewedName: "上海市建平实验地杰中学（御桥路校区）",
    district: "浦东",
    address: "御桥路1977号",
    schoolNature: "公立",
    aliases: ["建平地杰", "建平实验地杰中学"],
    note: "2025浦东官方初中招生入学信息中建平实验地杰中学有御桥路、博华路两个校区；现有地址御桥路1977弄匹配御桥路校区，地图 POI 也为建平实验地杰中学，故补全校区全称。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: PUDONG_2025_MIDDLE_TITLE,
      url: PUDONG_2025_MIDDLE_URL,
      date: "2025-05-07",
      matchedName: "上海市建平实验地杰中学（御桥路校区）",
      rawNature: "公办",
      rawAddress: "御桥路1977号",
    },
  },
  {
    id: 5022,
    reviewedName: "上海市上南中学北校",
    district: "浦东",
    address: "南码头路1347号",
    lat: null,
    lng: null,
    schoolNature: "公立",
    aliases: ["上南北校", "上南中学北校"],
    note: "2025浦东官方初中招生入学信息确认上海市上南中学北校、公办性质和南码头路1347号地址；当前坐标来自羽毛球培训店 POI，非学校点位，故清空等待后续地图核验。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: PUDONG_2025_MIDDLE_TITLE,
      url: PUDONG_2025_MIDDLE_URL,
      date: "2025-05-07",
      matchedName: "上海市上南中学北校",
      rawNature: "公办",
      rawAddress: "南码头路1347号",
    },
  },
  {
    id: 5627,
    reviewedName: "上海市实验学校西校",
    district: "闵行",
    address: "平吉路300号",
    schoolNature: "公立",
    aliases: ["上实西校"],
    note: "2025闵行官方义务教育阶段学校基本情况确认上海市实验学校西校、公办性质和地址；现有地址与地图 POI 均匹配，故补全全称并保留坐标。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: MINHANG_2025_MIDDLE_TITLE,
      url: MINHANG_2025_MIDDLE_URL,
      date: "2025-04-07",
      matchedName: "上海市实验学校西校",
      rawNature: "公办",
      rawAddress: "平吉路300号",
    },
  },
  {
    id: 5633,
    reviewedName: "上海市莘光学校",
    district: "闵行",
    address: "雅致路18号",
    schoolNature: "公立",
    aliases: ["莘光中学", "莘光学校"],
    note: "2025闵行官方义务教育阶段学校基本情况中上海市莘光学校有山花路555号和雅致路18号；现有地址雅致路18弄匹配雅致路校区，地图 POI 也为莘光学校，故补全全称和官方地址。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: MINHANG_2025_MIDDLE_TITLE,
      url: MINHANG_2025_MIDDLE_URL,
      date: "2025-04-07",
      matchedName: "上海市莘光学校",
      rawNature: "公办",
      rawAddress: "雅致路18号",
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
        operation: "reviewed_school_correction_round5",
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
              lat = $4,
              lng = $5,
              school_nature = coalesce($6::school_nature, school_nature),
              aliases = $7,
              attrs = $8::jsonb,
              updated_at = now()
            WHERE id = $9
          `,
          [
            correction.reviewedName,
            correction.district,
            correction.address ?? null,
            "lat" in correction ? correction.lat : current.lat,
            "lng" in correction ? correction.lng : current.lng,
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
