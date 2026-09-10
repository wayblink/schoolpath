/**
 * Apply manually reviewed school tier corrections, round 2.
 *
 * Tier is a non-official, third-party ranking field. This script reads the
 * reviewed safe-to-apply candidate file generated under data/audit and only
 * fills blank/placeholder tiers.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to write
 * - updates by school id only
 * - only fills blank/placeholder tier
 * - no deletes, no merges
 * - appends every changed row to data/audit/school-data-audit-log.jsonl
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const sourcePath =
  valueArg("--source") ??
  path.join(
    process.cwd(),
    "data",
    "audit",
    "tier-candidates",
    "20260618-baoshan-jiading-songjiang-round1",
    "safe-to-apply.json",
  );
const auditLogPath =
  valueArg("--audit-log") ?? path.join(process.cwd(), "data", "audit", "school-data-audit-log.jsonl");
const reportDir = path.join(
  process.cwd(),
  "data",
  "audit",
  "reviewed-school-tier-corrections-round2",
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

type Candidate = {
  school_id: number;
  school_name: string;
  district: string;
  type: string;
  current_tier: string | null;
  proposed_tier: "一梯队" | "二梯队" | "三梯队" | "四梯队";
  matched_alias: string;
  match_reason: string;
  source_name: string;
  source_title: string;
  source_url: string;
  confidence: "medium" | "high";
  source_note: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function isPlaceholderTier(tier: string | null) {
  return tier === null || tier.trim() === "" || tier === PLACEHOLDER_TIER || tier === "待补充";
}

function loadCandidates() {
  const candidates = JSON.parse(readFileSync(sourcePath, "utf8")) as Candidate[];
  for (const candidate of candidates) {
    if (!VALID_TIERS.has(candidate.proposed_tier)) throw new Error(`Invalid tier: ${candidate.proposed_tier}`);
    if (!candidate.school_id || !candidate.school_name || !candidate.source_url) {
      throw new Error(`Invalid candidate: ${JSON.stringify(candidate)}`);
    }
  }
  return candidates;
}

async function main() {
  mkdirSync(path.dirname(auditLogPath), { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  const candidates = loadCandidates();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const events: unknown[] = [];
  let changed = 0;
  let skipped = 0;

  try {
    await client.query("BEGIN");

    for (const candidate of candidates) {
      const currentResult = await client.query<SchoolRow>(
        `
          SELECT id, name, district, type, tier, attrs
          FROM schools
          WHERE id = $1
          FOR UPDATE
        `,
        [candidate.school_id],
      );
      const current = currentResult.rows[0];
      if (!current) {
        skipped += 1;
        continue;
      }

      if (current.name !== candidate.school_name || current.district !== candidate.district || current.type !== candidate.type) {
        skipped += 1;
        events.push({
          ts: new Date().toISOString(),
          operation: "reviewed_school_tier_correction_round2",
          mode: apply ? "apply" : "dry-run",
          school_id: current.id,
          school_name: current.name,
          action: "skip-identity-mismatch",
          expected: { name: candidate.school_name, district: candidate.district, type: candidate.type },
          actual: { name: current.name, district: current.district, type: current.type },
        });
        continue;
      }

      if (!isPlaceholderTier(current.tier)) {
        skipped += 1;
        events.push({
          ts: new Date().toISOString(),
          operation: "reviewed_school_tier_correction_round2",
          mode: apply ? "apply" : "dry-run",
          school_id: current.id,
          school_name: current.name,
          action: "skip-existing-tier",
          current_tier: current.tier,
        });
        continue;
      }

      const sourcePayload = {
        source_type: "third_party_tier",
        source_name: candidate.source_name,
        source_title: candidate.source_title,
        source_url: candidate.source_url,
        source_date: "2025",
        matched_text: candidate.source_note,
        matched_alias: candidate.matched_alias,
        match_reason: candidate.match_reason,
        confidence: candidate.confidence,
        reviewed_at: new Date().toISOString(),
        note: "梯队为第三方民间榜单字段，不是教育局官方字段；本次仅填补待补充值。",
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
        operation: "reviewed_school_tier_correction_round2",
        mode: apply ? "apply" : "dry-run",
        school_id: current.id,
        school_name: current.name,
        changes: { tier: { from: current.tier, to: candidate.proposed_tier } },
        source: {
          type: "third_party_tier",
          name: candidate.source_name,
          title: candidate.source_title,
          url: candidate.source_url,
          matchedAlias: candidate.matched_alias,
          matchReason: candidate.match_reason,
        },
        confidence: candidate.confidence,
        note: sourcePayload.note,
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
          tier: candidate.proposed_tier,
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
              AND name = $4
              AND district = $5
              AND type = $6
              AND (tier IS NULL OR btrim(tier) = '' OR tier IN ($7, '待补充'))
          `,
          [
            candidate.proposed_tier,
            JSON.stringify(attrsPatch),
            current.id,
            current.name,
            current.district,
            current.type,
            PLACEHOLDER_TIER,
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
              VALUES ($1, 'third_party_tier', $2, $3, $4, '2025', $5, $6, $7::jsonb, now(), now())
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
              candidate.source_name,
              candidate.source_url,
              candidate.source_title,
              candidate.source_note,
              candidate.confidence,
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

    const summary = { mode: apply ? "apply" : "dry-run", sourcePath, auditLogPath, reportDir, changed, skipped };
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
