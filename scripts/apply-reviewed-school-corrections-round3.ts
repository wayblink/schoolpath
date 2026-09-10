/**
 * Apply manually reviewed high-confidence school corrections, round 3.
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
  "reviewed-school-corrections-round3",
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
    id: 4663,
    reviewedName: "交大附中附属嘉定德富中学",
    district: "嘉定",
    address: "上海市嘉定区洪德路618号",
    schoolNature: "公立",
    aliases: ["德富中学"],
    note: "2025嘉定官方公办学校基本情况确认全称、嘉定区、公办性质和地址；现有行 district=浦东 且名称为简称，本次按官方源覆盖。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年嘉定区义务教育阶段公办学校基本情况",
      url: "https://www.shanghai.gov.cn/cmsres/36/363881f703f146b6b50547142c3255e4/0e579ab9fa85681dd7fc712bc74f99a6.pdf",
      date: "2025",
      matchedName: "交大附中附属嘉定德富中学",
      rawNature: "公办",
      rawAddress: "上海市嘉定区洪德路618号",
    },
  },
  {
    id: 4781,
    reviewedName: "上海市松江九峰实验学校",
    district: "松江",
    address: "松江区方塔北路319号",
    schoolNature: "私立",
    aliases: ["九峰实验", "九峰实验学校"],
    note: "2025松江官方学校基本情况 PDF 确认全称、松江区、民办完全中学性质和地址；现有简称保留为别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年松江区义务教育阶段学校规模、招生计划、校舍场地条件、教育教学、后勤设施设备和师资配置基本情况公示",
      url: "https://www.shanghai.gov.cn/cmsres/90/901088067bed467382785e3076498c44/6a224298ebd26d6b2a03e14b75f56c5c.pdf",
      date: "2025",
      matchedName: "上海市松江九峰实验学校",
      rawNature: "民办完全中学",
      rawAddress: "松江区方塔北路319号",
    },
  },
  {
    id: 4792,
    reviewedName: "上海民办浦东交中初级中学",
    district: "浦东",
    address: "东方路420号",
    schoolNature: "私立",
    aliases: ["交中初级"],
    note: "2025浦东官方初中招生入学信息确认全称、浦东新区、民办性质和地址；现有行 district=徐汇 为跨区错误，本次按官方源覆盖。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年浦东新区义务教育阶段学校招生入学信息公示（初中）",
      url: "https://www.shanghai.gov.cn/pdxqywjy/20250507/57ff6e427b4c4846b03a5d414c820531.html",
      date: "2025-05-07",
      matchedName: "上海民办浦东交中初级中学",
      rawNature: "民办",
      rawAddress: "东方路420号",
    },
  },
  {
    id: 4899,
    reviewedName: "上海市卢湾中学",
    district: "黄浦",
    address: "斜土路855号",
    schoolNature: "公立",
    aliases: ["卢湾中学"],
    note: "2025黄浦官方初中办学基本情况确认全称、公办初中性质和地址；现有简称保留为别名，并用官方地址覆盖地图误匹配地址。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年黄浦区初中阶段学校办学基本情况公示",
      url: "https://www.shanghai.gov.cn/hpqywjy/20250416/5f05ce5edb724d40aa297cd684e50df6.html",
      date: "2025-04-16",
      matchedName: "上海市卢湾中学",
      rawNature: "公办初中",
      rawAddress: "斜土路855号",
    },
  },
  {
    id: 5539,
    reviewedName: "上海市崇明区实验中学（西园校区）",
    district: "崇明",
    address: "城桥镇西园路237号",
    schoolNature: "公立",
    aliases: ["崇明实验", "崇明区实验中学"],
    note: "2025崇明官方初中基本情况中多个实验中学校区并列；现有地址西园路237号与西园校区匹配，故更新为西园校区全称、公办性质和官方地址。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年崇明区义务教育招生学校基本情况（初中）",
      url: "https://www.shanghai.gov.cn/cmqywjy/20250417/b52947a33336407185e4622bb0793dca.html",
      date: "2025-04-17",
      matchedName: "上海市崇明区实验中学 （西园校区）",
      rawNature: "公办",
      rawAddress: "城桥镇西园路237号",
    },
  },
  {
    id: 5634,
    reviewedName: "上海市莘城学校",
    district: "闵行",
    address: "普洱路158号",
    schoolNature: "公立",
    aliases: ["莘城学校"],
    note: "2025闵行官方义务教育阶段学校基本情况确认全称、公办性质和地址；现有简称保留为别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年闵行区义务教育阶段学校（初中和一贯制学校）教育教学、校舍场地条件、后勤设施设备和师资配置基本情况",
      url: "https://www.shanghai.gov.cn/mhqywjy/20250407/ff191ff43156426081990035cf99e39d.html",
      date: "2025-04-07",
      matchedName: "上海市莘城学校",
      rawNature: "公办",
      rawAddress: "普洱路158号",
    },
  },
  {
    id: 5803,
    reviewedName: "上海世外教育附属宝山中环实验小学",
    district: "宝山",
    address: "华和路255弄11号",
    aliases: ["世外小学", "宝山世外小学"],
    note: "2025宝山官方小学招生计划确认全称和地址；官方记录未明确公民办性质，本次不覆盖 school_nature。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年宝山区义务教育阶段学校校区范围与招生计划（小学）",
      url: "https://www.shanghai.gov.cn/bsqywjy/20250423/ac8a95f3a4494ef8bd356e112aec499c.html",
      date: "2025-04-23",
      matchedName: "上海世外教育附属宝山中环实验小学",
      rawAddress: "华和路255弄11号",
    },
  },
  {
    id: 4634,
    reviewedName: "上海市宝山区淞谊实验学校",
    district: "宝山",
    address: "（密山校区） 密山路100号；（东林校区） 东林路125号",
    aliases: ["淞谊中学", "淞谊实验学校"],
    note: "2025宝山官方初中招生计划确认全称及密山、东林两个校区地址；官方记录未明确公民办性质，本次保留现有 school_nature。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年宝山区义务教育阶段学校校区范围与招生计划（初中）",
      url: "https://www.shanghai.gov.cn/bsqywjy/20250423/497250a7552b43c59fca0a904b1eee82.html",
      date: "2025-04-23",
      matchedName: "上海市宝山区淞谊实验学校",
      rawAddress: "（密山校区） 密山路100号；（东林校区） 东林路125号",
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
        operation: "reviewed_school_correction_round3",
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
