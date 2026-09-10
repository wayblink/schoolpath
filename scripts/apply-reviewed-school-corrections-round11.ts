/**
 * Apply manually reviewed high-confidence school corrections, round 11.
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
  "reviewed-school-corrections-round11",
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

const CORRECTIONS: Correction[] = [
  {
    id: 5085,
    reviewedName: "上海市复旦初级中学",
    district: "长宁",
    type: "middle",
    address: "华山路1626号",
    lat: null,
    lng: null,
    schoolNature: "公立",
    aliases: ["复旦初中"],
    note: "round10 曾按较弱地址线索写入淞虹路475号；复核2025长宁区初中校园开放日官方表，上海市复旦初级中学开放地点为华山路1626号，且与原行地址一致。本次修正为更高置信的官方开放日地址，并继续清空旧高中坐标以待后续地图核验。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年长宁区初中校园开放日情况一览表",
      url: "https://zwgk.shcn.gov.cn/xxgk/ywjyzs-jyjzsgl/2025/99/77226.html",
      date: "2025",
      matchedName: "上海市复旦初级中学",
      rawNature: "公办初中",
      rawAddress: "华山路1626号",
    },
  },
  {
    id: 5147,
    reviewedName: "上海市长阳实验学校",
    district: "杨浦",
    address: "怀德路1000号",
    lat: null,
    lng: null,
    schoolNature: "私立",
    aliases: ["民办控江", "上海控江中学附属民办学校", "上海市长阳实验学校（初中部）"],
    note: "现有行名称为旧简称且地址/坐标指向控江高中；2025年上海市长阳实验学校初中部招生简章确认学校原为上海控江中学附属民办学校，现名上海市长阳实验学校，地址怀德路1000号，属于民办初中招生。本次修正全称、地址和民办性质，并清空旧高中坐标。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年上海市长阳实验学校初中部招生简章",
      url: "https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-czzs/20250408/477872.html",
      date: "2025-04-08",
      matchedName: "上海市长阳实验学校",
      rawNature: "民办",
      rawAddress: "怀德路1000号",
    },
  },
  {
    id: 5548,
    reviewedName: "上海浦东新区民办欣竹中学",
    district: "浦东",
    address: "潍坊校区：潍坊路357号；龙居校区：龙居路118号",
    schoolNature: "私立",
    aliases: ["新竹园", "新竹园中学", "上海浦东新区民办欣竹中学（潍坊校区）", "上海浦东新区民办欣竹中学（龙居校区）"],
    note: "现有行名称为旧简称且地址/POI 为内部楼栋；2025浦东新区义务教育阶段学校招生入学信息公示（初中）列出上海浦东新区民办欣竹中学两个校区，性质民办，地址为潍坊路357号、龙居路118号。本次补全当前官方名称和校区地址。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年浦东新区义务教育阶段学校招生入学信息公示（初中）",
      url: "https://www.shanghai.gov.cn/pdxqywjy/20250507/57ff6e427b4c4846b03a5d414c820531.html",
      date: "2025-05-07",
      matchedName: "上海浦东新区民办欣竹中学",
      rawNature: "民办",
      rawAddress: "潍坊路357号；龙居路118号",
    },
  },
  {
    id: 5588,
    reviewedName: "上海市西延安中学",
    district: "长宁",
    address: "清池路211号",
    lat: null,
    lng: null,
    schoolNature: "公立",
    aliases: ["西延安"],
    note: "round10 曾写入金钟路299号；复核2025长宁区初中校园开放日官方表和2026长宁区中小学校通讯信息表，上海市西延安中学地址均为清池路211号。本次修正为一致的官方地址，并继续清空旧高中坐标。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年长宁区初中校园开放日情况一览表 / 2026年长宁区中小学校和托幼机构通讯信息表",
      url: "https://zwgk.shcn.gov.cn/xxgk/ywjyzs-jyjzsgl/2025/99/77226.html",
      date: "2025",
      matchedName: "上海市西延安中学",
      rawNature: "公办初中",
      rawAddress: "清池路211号",
    },
  },
  {
    id: 5622,
    reviewedName: "华东师范大学第二附属中学附属初级中学",
    district: "闵行",
    address: "紫凤路350号",
    schoolNature: "公立",
    aliases: ["闵华二初级", "华二附属初级中学"],
    note: "现有行名称为简称且缺地址/性质；2025闵行区义务教育阶段学校官方公示确认华东师范大学第二附属中学附属初级中学，地址紫凤路350号，性质公办。本次补全全称、地址和公办性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "华东师范大学第二附属中学附属初级中学",
      rawNature: "公办",
      rawAddress: "紫凤路350号",
    },
  },
  {
    id: 5739,
    reviewedName: "上海市第二师范学校附属小学杨浦北校",
    district: "杨浦",
    address: "政立路570号",
    lat: null,
    lng: null,
    schoolNature: "公立",
    aliases: ["政立路二小", "政立路第二小学"],
    note: "现有行名称为旧简称且地图 POI 误指道路；2025杨浦区义务教育阶段公办小学基本情况公示和招生计划确认当前学校名为上海市第二师范学校附属小学杨浦北校，地址政立路570号，性质公办小学。本次补全当前全称、地址和公办性质，并清空道路坐标。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年杨浦区义务教育阶段公办小学基本情况公示（规模、设备、师资）及招生计划",
      url: "https://www.shyp.gov.cn/shypq/yqyw-wb-jyjzl-ypzs-xxzs/20250407/477710/d1833493558244b3ad870c206b1b43d0.pdf",
      date: "2025-04-07",
      matchedName: "上海市第二师范学校附属小学杨浦北校",
      rawNature: "公办小学",
      rawAddress: "政立路570号",
    },
  },
  {
    id: 5747,
    reviewedName: "上海浦东新区民办正达外国语小学",
    district: "浦东",
    address: "南校区：沪南公路2061号",
    schoolNature: "私立",
    aliases: ["福山正达", "上海浦东新区民办正达外国语小学（南校区）"],
    note: "现有行名称为简称，地址为沪南路2061弄；2025浦东新区义务教育阶段学校招生入学信息公示（小学）确认上海浦东新区民办正达外国语小学南校区，性质民办，地址沪南公路2061号。本次补全当前官方名称、校区地址和民办性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年浦东新区义务教育阶段学校招生入学信息公示（小学）",
      url: "https://www.shanghai.gov.cn/pdxqywjy/20250507/4b6f7cccd64a4bc2a7e60cfe5a7d202f.html",
      date: "2025-05-07",
      matchedName: "上海浦东新区民办正达外国语小学（南校区）",
      rawNature: "民办",
      rawAddress: "沪南公路2061号",
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
        operation: "reviewed_school_correction_round11",
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
