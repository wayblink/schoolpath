/**
 * Apply manually reviewed school tier corrections, round 1.
 *
 * Tier is a non-official, third-party ranking field. This script only applies
 * explicitly reviewed candidates and records the source and confidence.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to write
 * - updates by school id only
 * - only fills blank/placeholder tier
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
  "reviewed-school-tier-corrections-round1",
  new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-"),
);

const PLACEHOLDER_TIER = "未入榜/待补充";
const VALID_TIERS = new Set(["一梯队", "二梯队", "三梯队", "四梯队"]);

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: string;
  tier: string | null;
  attrs: Record<string, unknown> | null;
};

type Correction = {
  id: number;
  reviewedTier: "一梯队" | "二梯队" | "三梯队" | "四梯队";
  matchedAlias: string;
  confidence: "medium" | "high";
  note: string;
  source: {
    type: string;
    name: string;
    title: string;
    url: string;
    date?: string;
    matchedText: string;
  };
};

const CORRECTIONS: Correction[] = [
  {
    id: 3903,
    reviewedTier: "四梯队",
    matchedAlias: "鹤北初级中学",
    confidence: "medium",
    note: "梯队为第三方民间榜单字段，不是教育局官方字段；本次试点仅填补待补充值。来源列出闵行区初中四梯队包含鹤北初级中学，当前行上海市闵行区鹤北初级中学为同区同学段且名称直接包含匹配。",
    source: {
      type: "third_party_tier",
      name: "上海择校升学转学",
      title: "上海各区初中梯队排名",
      url: "https://www.vsxue.com/2083.html",
      date: "2025",
      matchedText: "闵行区初中四梯队：七宝实验中学、龙茗中学、康城实验、闵行三中、闵行四中、鹤北初级中学等。",
    },
  },
  {
    id: 3904,
    reviewedTier: "四梯队",
    matchedAlias: "龙茗中学",
    confidence: "medium",
    note: "梯队为第三方民间榜单字段，不是教育局官方字段；本次试点仅填补待补充值。来源列出闵行区初中四梯队包含龙茗中学，当前行上海市闵行区龙茗中学为同区同学段且名称直接包含匹配。",
    source: {
      type: "third_party_tier",
      name: "上海择校升学转学",
      title: "上海各区初中梯队排名",
      url: "https://www.vsxue.com/2083.html",
      date: "2025",
      matchedText: "闵行区初中四梯队：七宝实验中学、龙茗中学、康城实验、闵行三中、闵行四中、鹤北初级中学等。",
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

function isPlaceholderTier(tier: string | null) {
  return tier === null || tier.trim() === "" || tier === PLACEHOLDER_TIER;
}

async function main() {
  mkdirSync(path.dirname(auditLogPath), { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  for (const correction of CORRECTIONS) {
    if (!VALID_TIERS.has(correction.reviewedTier)) throw new Error(`Invalid tier: ${correction.reviewedTier}`);
  }

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
          SELECT id, name, district, type, tier, attrs
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

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (current.tier !== correction.reviewedTier) changes.tier = { from: current.tier, to: correction.reviewedTier };

      if (!isPlaceholderTier(current.tier)) {
        skipped += 1;
        events.push({
          ts: new Date().toISOString(),
          operation: "reviewed_school_tier_correction_round1",
          mode: apply ? "apply" : "dry-run",
          school_id: current.id,
          school_name: current.name,
          action: "skip-existing-tier",
          current_tier: current.tier,
          source: correction.source,
          note: correction.note,
        });
        continue;
      }

      const sourcePayload = {
        source_type: correction.source.type,
        source_name: correction.source.name,
        source_title: correction.source.title,
        source_url: correction.source.url,
        source_date: correction.source.date,
        matched_text: correction.source.matchedText,
        matched_alias: correction.matchedAlias,
        confidence: correction.confidence,
        reviewed_at: new Date().toISOString(),
        note: correction.note,
      };
      const attrsPatch = {
        ...(current.attrs ?? {}),
        reviewed_school_tier_source: sourcePayload,
        reviewed_school_tier_sources: [
          ...(((current.attrs?.reviewed_school_tier_sources as unknown[]) ?? []).filter(Boolean)),
          sourcePayload,
        ].slice(-20),
      };
      const event = {
        ts: new Date().toISOString(),
        operation: "reviewed_school_tier_correction_round1",
        mode: apply ? "apply" : "dry-run",
        school_id: current.id,
        school_name: current.name,
        changes,
        source: correction.source,
        confidence: correction.confidence,
        note: correction.note,
        before: {
          id: current.id,
          name: current.name,
          district: current.district,
          type: current.type,
          tier: current.tier,
        },
        after: {
          id: current.id,
          name: current.name,
          district: current.district,
          type: current.type,
          tier: correction.reviewedTier,
        },
      };

      events.push(event);
      console.log(JSON.stringify(event));

      if (apply) {
        const result = await client.query(
          `
            UPDATE schools
            SET
              tier = $1,
              attrs = $2::jsonb,
              updated_at = now()
            WHERE id = $3
              AND (tier IS NULL OR btrim(tier) = '' OR tier = $4)
          `,
          [correction.reviewedTier, JSON.stringify(attrsPatch), current.id, PLACEHOLDER_TIER],
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
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), now())
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
              correction.confidence,
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
