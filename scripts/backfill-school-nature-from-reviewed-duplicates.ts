/**
 * Fill school_nature on four explicitly reviewed duplicate rows.
 *
 * The duplicate review established a one-to-one identity match with a
 * canonical row in the same district and stage. Nature is copied only from
 * that canonical row when its official provenance is still present. This is
 * an allowlist migration, not a general duplicate/name inference.
 *
 * Dry-run is the default; pass --apply to commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
const reportDir = path.join(process.cwd(), ".tmp", "reviewed-duplicate-nature-backfill", stamp);

type SchoolType = "primary" | "middle" | "nine_year";
type Nature = "公立" | "私立";
type JsonRecord = Record<string, unknown>;

export type ReviewedNatureDuplicate = {
  sourceId: number;
  sourceName: string;
  targetId: number;
  targetName: string;
  district: string;
  type: SchoolType;
  reason: string;
};

/** Reviewed in the duplicate audit; do not broaden without a new review. */
export const REVIEWED_DUPLICATES: ReviewedNatureDuplicate[] = [
  {
    sourceId: 5790,
    sourceName: "上海市宝山区第三中心小学",
    targetId: 4317,
    targetName: "上海市宝山区第三中心小学",
    district: "宝山",
    type: "primary",
    reason: "官方全称、区属和学段与 canonical 行一一对应；canonical 性质有宝山官方招生表证据。",
  },
  {
    sourceId: 5793,
    sourceName: "上海市宝山区虎林路第三小学",
    targetId: 4350,
    targetName: "上海市宝山区虎林路第三小学",
    district: "宝山",
    type: "primary",
    reason: "官方全称、区属和学段与 canonical 行一一对应；canonical 性质有宝山官方招生表证据。",
  },
  {
    sourceId: 5794,
    sourceName: "上海市宝山区第二中心小学",
    targetId: 4347,
    targetName: "上海市宝山区第二中心小学",
    district: "宝山",
    type: "primary",
    reason: "官方全称、区属和学段与 canonical 行一一对应；canonical 性质有宝山官方招生表证据。",
  },
  {
    sourceId: 5803,
    sourceName: "上海世外教育附属宝山中环实验小学",
    targetId: 4346,
    targetName: "上海世外教育附属宝山中环实验小学",
    district: "宝山",
    type: "primary",
    reason: "官方全称、区属和学段与 canonical 行一一对应；canonical 性质有宝山官方招生表证据。",
  },
];

type DbSchool = {
  id: number;
  name: string;
  district: string;
  type: SchoolType;
  school_nature: Nature | null;
  attrs: JsonRecord | null;
};

function officialSource(attrs: JsonRecord | null) {
  const source = attrs?.school_nature_source;
  const officialBoundary = attrs?.official_boundary_source;
  const officialInfo = attrs?.official_school_info_source;
  const url =
    source && typeof source === "object" && typeof (source as JsonRecord).policy_url === "string"
      ? (source as JsonRecord).policy_url
      : typeof officialBoundary === "string"
        ? officialBoundary
        : officialInfo && typeof officialInfo === "object" && typeof (officialInfo as JsonRecord).url === "string"
          ? (officialInfo as JsonRecord).url
          : null;
  const hasOfficialMarker = Boolean(
    source && typeof source === "object" && (source as JsonRecord).source === "official_catchment_area",
  ) || Boolean(officialBoundary) || Boolean(officialInfo);
  return typeof url === "string" && /^https?:\/\/(?:[^/]+\.)?gov\.cn\//.test(url) && hasOfficialMarker
    ? url
    : null;
}

export function eligibleNatureCopy(source: DbSchool, target: DbSchool) {
  return Boolean(
    source.school_nature === null &&
      target.school_nature &&
      source.district === target.district &&
      source.type === target.type &&
      officialSource(target.attrs),
  );
}

async function main() {
  mkdirSync(reportDir, { recursive: true });
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const actions: Array<Record<string, unknown>> = [];
  let updated = 0;

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '30s'");

    for (const review of REVIEWED_DUPLICATES) {
      const rows = (
        await client.query<DbSchool>(
          `SELECT id,name,district,type,school_nature,attrs
             FROM public.schools
            WHERE id = ANY($1::int[])
            ORDER BY id
            FOR UPDATE`,
          [[review.sourceId, review.targetId]],
        )
      ).rows;
      const source = rows.find((row) => row.id === review.sourceId) ?? null;
      const target = rows.find((row) => row.id === review.targetId) ?? null;
      const sourceIdentity = source && source.name === review.sourceName && source.district === review.district && source.type === review.type;
      const targetIdentity = target && target.name === review.targetName && target.district === review.district && target.type === review.type;
      const sourceUrl = target ? officialSource(target.attrs) : null;
      const eligible = Boolean(source && target && sourceIdentity && targetIdentity && eligibleNatureCopy(source, target) && sourceUrl);
      const before = { source, target };
      if (!eligible) {
        actions.push({ ...review, action: "skip", reason: !source || !target ? "missing-row" : !sourceIdentity || !targetIdentity ? "identity-drift" : !sourceUrl ? "canonical-official-provenance-missing" : "nature-not-copyable", before });
        continue;
      }
      if (!source || !target || !sourceUrl) {
        throw new Error(`eligible duplicate mapping lost required rows: ${review.sourceId}->${review.targetId}`);
      }

      const evidence = {
        migration: "reviewed_duplicate_nature_backfill",
        source_school_id: review.sourceId,
        canonical_school_id: review.targetId,
        source_school_name: review.sourceName,
        canonical_school_name: review.targetName,
        district: review.district,
        type: review.type,
        normalized_nature: target.school_nature,
        canonical_source_url: sourceUrl,
        review_reason: review.reason,
        evidence: "仅从已审阅的一一对应 canonical 学校复制性质；canonical 行保留官方 gov.cn 来源。",
        copied_at: new Date().toISOString(),
      };
      const attrs = {
        ...(source.attrs ?? {}),
        reviewed_duplicate_nature_source: evidence,
      };
      const result = await client.query(
        `UPDATE public.schools
            SET school_nature = $1::school_nature,
                attrs = $2::jsonb,
                updated_at = now()
          WHERE id = $3
            AND name = $4
            AND district = $5
            AND type = $6
            AND school_nature IS NULL
          RETURNING id`,
        [target.school_nature, JSON.stringify(attrs), source.id, review.sourceName, review.district, review.type],
      );
      updated += result.rowCount ?? 0;
      if (result.rowCount) {
        await client.query(
          `INSERT INTO public.web_data_source(
             school_id,source_type,source_name,source_url,source_title,source_date,
             evidence,confidence,raw,fetched_at,created_at,updated_at
           ) VALUES ($1,'official_school_info','上海市人民政府/宝山区教育局',$2,$3,'2025',$4,'high',$5::jsonb,now(),now(),now())
           ON CONFLICT (school_id,source_url,source_type)
           DO UPDATE SET source_title=excluded.source_title,evidence=excluded.evidence,
                         confidence=excluded.confidence,raw=excluded.raw,fetched_at=now(),updated_at=now()`,
          [review.sourceId, sourceUrl, `canonical ${review.targetName} 官方性质证据`, `canonical 行 ${review.targetId} 的官方宝山来源经已审阅重复映射复制${target.school_nature}性质；源行不改变其他字段。`, JSON.stringify(evidence)],
        );
      }
      actions.push({ ...review, action: apply ? "update" : "dry-run", sourceUrl, nature: target.school_nature, before, after: { ...source, school_nature: target.school_nature, attrs } });
    }

    const report = path.join(reportDir, apply ? "backfill-applied.json" : "backfill-dry-run.json");
    writeFileSync(report, JSON.stringify({ mode: apply ? "apply" : "dry-run", reviewedMappings: REVIEWED_DUPLICATES.length, updated, actions }, null, 2));
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", reviewedMappings: REVIEWED_DUPLICATES.length, planned: actions.filter((action) => action.action === "update" || action.action === "dry-run").length, updated, reportDir }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
