/**
 * Apply manually reviewed high-confidence school corrections, round 4.
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
  "reviewed-school-corrections-round4",
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

const CORRECTIONS: Correction[] = [
  {
    id: 5362,
    reviewedName: "上海市三新学校松江思贤分校",
    district: "松江",
    address: "松江区江学路450号",
    schoolNature: "公立",
    aliases: ["三新学校"],
    note: "2025松江官方学校基本情况中存在三新学校本部、东部分校、思贤分校；现有行地址为江学路450号，和官方思贤分校地址匹配，故补全为校区全称并保留简称为别名。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年松江区义务教育阶段学校规模、招生计划、校舍场地条件、教育教学、后勤设施设备和师资配置基本情况公示",
      url: "https://www.shanghai.gov.cn/cmsres/90/901088067bed467382785e3076498c44/6a224298ebd26d6b2a03e14b75f56c5c.pdf",
      date: "2025",
      matchedName: "上海市三新学校松江思贤分校",
      rawNature: "公办九年一贯制",
      rawAddress: "松江区江学路450号",
    },
  },
  {
    id: 4655,
    reviewedName: "上海市民办桃李园实验学校",
    district: "嘉定",
    address: "嘉定区树屏路2055- 2065号",
    schoolNature: "私立",
    aliases: ["民办桃李园", "桃李园"],
    note: "2025嘉定官方民办学校基本情况确认全称、嘉定区、民办性质和树屏路地址；现有行地址已指向嘉定但 district=闵行，按官方源纠正区属并补全名称。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年嘉定区义务教育阶段民办学校基本情况",
      url: "https://www.shanghai.gov.cn/cmsres/b9/b967748e67074323a73ef1586db4ef32/85e9c727c4c5a019e3135337cac7b180.pdf",
      date: "2025",
      matchedName: "上海市民办桃李园实验学校",
      rawNature: "民办",
      rawAddress: "嘉定区树屏路2055- 2065号",
    },
  },
  {
    id: 4623,
    reviewedName: "上海市进才中学北校（羽山路校区）",
    district: "浦东",
    address: "羽山路601号",
    schoolNature: "公立",
    aliases: ["进才北校", "进才中学北校"],
    note: "2025浦东官方初中招生入学信息中进才中学北校有苗圃路、羽山路两个校区；现有地址为羽山路601弄且地图匹配进才中学北校，按官方羽山路校区补全名称和地址。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年浦东新区义务教育阶段学校招生入学信息公示（初中）",
      url: "https://www.shanghai.gov.cn/pdxqywjy/20250507/57ff6e427b4c4846b03a5d414c820531.html",
      date: "2025-05-07",
      matchedName: "上海市进才中学北校（羽山路校区）",
      rawNature: "公办",
      rawAddress: "羽山路601号",
    },
  },
  {
    id: 4675,
    reviewedName: "上海民办永昌学校",
    district: "黄浦",
    address: "绍兴路5号甲",
    schoolNature: "私立",
    aliases: ["私立永昌", "永昌学校", "上海私立永昌学校"],
    note: "2025黄浦官方小学和初中公示均确认上海民办永昌学校，地址绍兴路5号甲，性质民办；现有行地址已指向黄浦但 district=闵行，按官方源纠正。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年黄浦区初中阶段学校办学基本情况公示",
      url: "https://www.shanghai.gov.cn/hpqywjy/20250416/5f05ce5edb724d40aa297cd684e50df6.html",
      date: "2025-04-16",
      matchedName: "上海民办永昌学校",
      rawNature: "民办九年一贯制",
      rawAddress: "绍兴路5号甲",
    },
  },
  {
    id: 4818,
    reviewedName: "上海市梅陇中学",
    district: "普陀",
    address: "丹巴路1588号",
    lat: null,
    lng: null,
    schoolNature: "公立",
    aliases: ["梅陇中学"],
    note: "2025普陀官方学校基本情况确认全称、普陀区、公办初中性质和丹巴路1588号地址；现有行 district=徐汇 且地址/坐标来自公交线路POI，故按官方源纠正并清空旧错误坐标，等待后续地图反查填充。",
    source: {
      type: "official_school_info",
      name: SHANGHAI_GOV,
      title: "2025年普陀区义务教育阶段学校教育教学、后勤设施设备和师资配置基本情况表",
      url: "https://www.shanghai.gov.cn/ptqywjy/20251110/d17caa0f4c8c41d4ba91f0516f53ef12.html",
      date: "2025",
      matchedName: "上海市梅陇中学",
      rawNature: "公办初中",
      rawAddress: "丹巴路1588号",
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
        operation: "reviewed_school_correction_round4",
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
