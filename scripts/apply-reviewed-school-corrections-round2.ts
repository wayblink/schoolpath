/**
 * Apply manually reviewed high-confidence school corrections, round 2.
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
  "reviewed-school-corrections-round2",
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

const SHANGHAI_GOV = "上海市人民政府/区教育局";

const CORRECTIONS: Correction[] = [
  {
    id: 4660,
    reviewedName: "上海市民办远东学校",
    district: "嘉定",
    address: "嘉定区胜竹路1630号",
    schoolNature: "私立",
    aliases: ["远东学校"],
    note: "2025嘉定官方民办学校基本情况 PDF 确认全称、嘉定区、民办性质和地址；现有简称保留为别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年嘉定区义务教育阶段民办学校基本情况",
      url: "https://www.shanghai.gov.cn/cmsres/b9/b967748e67074323a73ef1586db4ef32/85e9c727c4c5a019e3135337cac7b180.pdf",
      date: "2025",
      matchedName: "上海市民办远东学校",
      rawNature: "民办",
      rawAddress: "嘉定区胜竹路1630号",
    },
  },
  {
    id: 5629,
    reviewedName: "上海市民办文绮中学（初中部）",
    district: "闵行",
    address: "江川东路980号",
    schoolNature: "私立",
    aliases: ["文琦中学", "文绮中学"],
    note: "2025闵行官方义务教育阶段学校基本情况确认全称为文绮中学（初中部），民办，地址江川东路980号；原名称“文琦”应为误字，保留为别名便于追溯。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "上海市民办文绮中学（初中部）",
      rawNature: "民办",
      rawAddress: "江川东路980号",
    },
  },
  {
    id: 5631,
    reviewedName: "上海市闵行区七宝第三中学",
    district: "闵行",
    address: "宝南路88号",
    schoolNature: "公立",
    aliases: ["七宝三中"],
    note: "2025闵行官方义务教育阶段学校基本情况确认全称、公办性质和地址；现有简称保留为别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "上海市闵行区七宝第三中学",
      rawNature: "公办",
      rawAddress: "宝南路88号",
    },
  },
  {
    id: 5632,
    reviewedName: "上海市闵行区七宝第二中学",
    district: "闵行",
    address: "民主路26号",
    schoolNature: "公立",
    aliases: ["七宝二中"],
    note: "2025闵行官方义务教育阶段学校基本情况确认全称、公办性质和地址；现有简称保留为别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "上海市闵行区七宝第二中学",
      rawNature: "公办",
      rawAddress: "民主路26号",
    },
  },
  {
    id: 5639,
    reviewedName: "上海市民办德英乐实验学校",
    district: "闵行",
    address: "星站路263号",
    schoolNature: "私立",
    aliases: ["德英乐"],
    note: "2025闵行官方义务教育阶段学校基本情况确认全称、民办性质和地址；现有简称保留为别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "上海市民办德英乐实验学校",
      rawNature: "民办",
      rawAddress: "星站路263号",
    },
  },
  {
    id: 5643,
    reviewedName: "上海市黄浦区蓬莱路第二小学",
    district: "黄浦",
    address: "蓬莱路225号",
    schoolNature: "公立",
    aliases: ["蓬莱二小"],
    note: "2025黄浦官方公办小学办学基本情况确认全称、公办性质和地址；现有简称保留为别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年黄浦区公办小学办学基本情况公示表（含对口范围）",
      url: "https://www.shanghai.gov.cn/hpqywjy/20250416/e1823c7eac2a46af9a27036dc13f3715.html",
      date: "2025-04-16",
      matchedName: "上海市黄浦区蓬莱路第二小学",
      rawNature: "公办",
      rawAddress: "蓬莱路225号",
    },
  },
  {
    id: 5670,
    reviewedName: "上海市黄浦区徽宁路第三小学",
    district: "黄浦",
    address: "徽宁路216号",
    schoolNature: "公立",
    aliases: ["徽宁路三小"],
    note: "2025黄浦官方公办小学办学基本情况确认全称、公办性质和地址；现有简称保留为别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年黄浦区公办小学办学基本情况公示表（含对口范围）",
      url: "https://www.shanghai.gov.cn/hpqywjy/20250416/e1823c7eac2a46af9a27036dc13f3715.html",
      date: "2025-04-16",
      matchedName: "上海市黄浦区徽宁路第三小学",
      rawNature: "公办",
      rawAddress: "徽宁路216号",
    },
  },
  {
    id: 5790,
    reviewedName: "上海市宝山区第三中心小学",
    district: "宝山",
    address: "呼玛路792号； 通河一村13号（东校区）",
    aliases: ["宝山三中心"],
    note: "2025宝山官方小学招生计划确认全称和校区地址；官方记录未明确公民办性质，本次不覆盖 school_nature。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年宝山区义务教育阶段学校校区范围与招生计划（小学）",
      url: "https://www.shanghai.gov.cn/bsqywjy/20250423/ac8a95f3a4494ef8bd356e112aec499c.html",
      date: "2025-04-23",
      matchedName: "上海市宝山区第三中心小学",
      rawAddress: "呼玛路792号； 通河一村13号（东校区）",
    },
  },
  {
    id: 5794,
    reviewedName: "上海市宝山区第二中心小学",
    district: "宝山",
    address: "南校区：长临路1000号 北校区：南蕰藻路259号",
    aliases: ["宝山二中心"],
    note: "2025宝山官方小学招生计划确认全称和南北校区地址；官方记录未明确公民办性质，本次不覆盖 school_nature。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年宝山区义务教育阶段学校校区范围与招生计划（小学）",
      url: "https://www.shanghai.gov.cn/bsqywjy/20250423/ac8a95f3a4494ef8bd356e112aec499c.html",
      date: "2025-04-23",
      matchedName: "上海市宝山区第二中心小学",
      rawAddress: "南校区：长临路1000号 北校区：南蕰藻路259号",
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
        operation: "reviewed_school_correction_round2",
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
