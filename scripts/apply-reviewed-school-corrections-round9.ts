/**
 * Apply manually reviewed high-confidence school corrections, round 9.
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
  "reviewed-school-corrections-round9",
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-"),
);

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: string;
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
  address: string;
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
    id: 4769,
    reviewedName: "上海外国语大学附属浦东外国语学校",
    district: "浦东",
    address: "达尔文路91号",
    schoolNature: "公立",
    aliases: ["浦外附中", "上外浦外"],
    note: "现有行名称为简称且缺地址/性质；本地2025浦东新区义务教育阶段学校招生入学信息公示（初中）官方缓存唯一确认上海外国语大学附属浦东外国语学校，地址达尔文路91号，性质公办。本次补全全称、地址和公办性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年浦东新区义务教育阶段学校招生入学信息公示（初中）",
      url: "https://www.shanghai.gov.cn/pdxqywjy/20250507/57ff6e427b4c4846b03a5d414c820531.html",
      date: "2025-05-07",
      matchedName: "上海外国语大学附属浦东外国语学校",
      rawNature: "公办",
      rawAddress: "达尔文路91号",
    },
  },
  {
    id: 4772,
    reviewedName: "上海交通大学附属第二中学",
    district: "闵行",
    address: "姚安路159号",
    schoolNature: "公立",
    aliases: ["交大二附", "交大二附中"],
    note: "现有行 district=浦东 且名称为简称；本地2025闵行区义务教育阶段学校（初中和一贯制学校）官方缓存确认上海交通大学附属第二中学，地址姚安路159号，性质公办。本次修正全称、区属、地址和公办性质；若存在同名行仅记录重复候选，不合并删除。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "上海交通大学附属第二中学",
      rawNature: "公办",
      rawAddress: "姚安路159号",
    },
  },
  {
    id: 5326,
    reviewedName: "上海市松江区九亭第三小学",
    district: "松江",
    address: "松江区九里亭街道涞坊路177号",
    schoolNature: "公立",
    aliases: ["九亭三小", "九亭第三小学"],
    note: "现有行名称为简称且缺地址/性质；本地2025松江区义务教育阶段学校规模等公示官方缓存确认上海市松江区九亭第三小学，地址松江区九里亭街道涞坊路177号，性质公办小学。本次补全全称、地址和公办性质。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年松江区义务教育阶段学校规模、招生计划、校舍场地条件、教育教学、后勤设施设备和师资配置基本情况公示",
      url: "https://www.shanghai.gov.cn/cmsres/90/901088067bed467382785e3076498c44/6a224298ebd26d6b2a03e14b75f56c5c.pdf",
      date: "2025",
      matchedName: "上海市松江区九亭第三小学",
      rawNature: "公办小学",
      rawAddress: "松江区九里亭街道涞坊路177号",
    },
  },
  {
    id: 5626,
    reviewedName: "上海交通大学附属第二中学",
    district: "闵行",
    address: "姚安路159号",
    schoolNature: "公立",
    aliases: ["交大二附中", "交大二附"],
    note: "现有行名称为简称且缺地址/性质；本地2025闵行区义务教育阶段学校（初中和一贯制学校）官方缓存确认上海交通大学附属第二中学，地址姚安路159号，性质公办。本次补全全称、地址和公办性质；若存在同名行仅记录重复候选，不合并删除。",
    source: {
      type: "official_school_info",
      name: GOV,
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "上海交通大学附属第二中学",
      rawNature: "公办",
      rawAddress: "姚安路159号",
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
  if (before.address !== correction.address) changes.address = { from: before.address, to: correction.address };
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
        type: current.type,
        address: correction.address,
        lat: current.lat,
        lng: current.lng,
        school_nature: correction.schoolNature,
        tier: current.tier,
        website: current.website,
        aliases,
      };
      const event = {
        ts: new Date().toISOString(),
        operation: "reviewed_school_correction_round9",
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
              address = $3,
              school_nature = $4::school_nature,
              aliases = $5,
              attrs = $6::jsonb,
              updated_at = now()
            WHERE id = $7
          `,
          [correction.reviewedName, correction.district, correction.address, correction.schoolNature, aliases, JSON.stringify(attrsPatch), current.id],
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
