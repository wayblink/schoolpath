/**
 * Incrementally backfill blank/placeholder school tiers from curated source JSON.
 *
 * Safety rules:
 * - default mode is dry-run; pass --apply to write
 * - exports target snapshot and match report
 * - only fills blank/placeholder tier unless --overwrite is explicitly passed
 * - UPDATE is guarded by id + name + district
 * - never deletes or truncates data
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const overwrite = process.argv.includes("--overwrite");
const sourcePath = valueArg("--source") ?? path.join(process.cwd(), "data", "school-tiers.json");
const district = valueArg("--district");
const minScore = numberArg("--min-score") ?? 220;

const PLACEHOLDER_TIER = "未入榜/待补充";
const VALID_TIERS = new Set(["一梯队", "二梯队", "三梯队", "四梯队", PLACEHOLDER_TIER]);

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  tier: string | null;
  attrs: Record<string, unknown> | null;
};

type TierItem = {
  district: string;
  names: string[];
  tier: string;
  sourceName?: string;
  sourceUrl?: string;
  sourceNote?: string;
  verified?: boolean;
  stage?: "primary" | "middle" | "unknown";
};

type TierFile = {
  items?: TierItem[];
};

type SourceRecord = TierItem & {
  sourceAlias: string;
};

type MatchReport = {
  school: SchoolRow;
  match: SourceRecord | null;
  score: number;
  rankScore?: number;
  action: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function numberArg(name: string) {
  const raw = valueArg(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number.`);
  return parsed;
}

function isPlaceholderTier(tier: string | null) {
  return tier === null || tier.trim() === "" || tier === PLACEHOLDER_TIER;
}

function normalizeName(value: string) {
  return value
    .replace(/（[^）]*校区）|\([^)]*校区\)/g, "")
    .replace(/（[^）]*部）|\([^)]*部\)/g, "")
    .replace(/[\s　·•\-—]+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市/, "")
    .replace(/^(民办|私立|公办)/, "")
    .replace(/教育集团/g, "")
    .replace(/集团校/g, "")
    .replace(/初级中学/g, "中学")
    .replace(/实验学校/g, "实验")
    .replace(/附属/g, "附")
    .replace(/区/g, "")
    .replace(/等$/, "")
    .trim();
}

function compactName(value: string) {
  return value
    .replace(/[\s　·•\-—]+/g, "")
    .replace(/^上海市/, "")
    .replace(/[()（）]/g, "")
    .replace(/^(民办|私立|公办)/, "")
    .replace(/等$/, "")
    .trim();
}

function typeMatches(school: SchoolRow, record: SourceRecord) {
  if (!record.stage || record.stage === "unknown") return true;
  if (record.stage === "middle" && /小学部/.test(school.name)) return false;
  if (record.stage === "primary" && /初中部/.test(school.name)) return false;
  if (school.type === "nine_year") return true;
  return school.type === record.stage;
}

function hasOnlyCampusSuffix(schoolNorm: string, aliasNorm: string) {
  if (!schoolNorm.startsWith(aliasNorm)) return false;
  const suffix = schoolNorm.slice(aliasNorm.length);
  if (!suffix) return true;
  if (/分校/.test(suffix)) return false;
  return /^(本部|总校|[东西南北]校|.*校区)$/.test(suffix);
}

function scoreRecord(school: SchoolRow, record: SourceRecord) {
  if (school.district !== record.district) return -100;
  if (!typeMatches(school, record)) return -20;

  const schoolStrict = compactName(school.name);
  const aliasStrict = compactName(record.sourceAlias);
  const schoolNorm = normalizeName(school.name);
  const aliasNorm = normalizeName(record.sourceAlias);
  if (!schoolNorm || !aliasNorm) return -100;
  if (schoolStrict === aliasStrict) return 300;
  if (schoolNorm === aliasNorm) return 260;

  let score = 0;
  if (hasOnlyCampusSuffix(schoolNorm, aliasNorm) || hasOnlyCampusSuffix(schoolStrict, aliasStrict)) score += 230;
  else if (aliasNorm.includes(schoolNorm)) score += 110;
  else if (aliasStrict.includes(schoolStrict)) score += 90;

  const schoolChars = new Set(schoolNorm);
  const aliasChars = new Set(aliasNorm);
  let overlap = 0;
  for (const char of aliasChars) {
    if (schoolChars.has(char)) overlap += 1;
  }
  score += Math.round((overlap / Math.max(schoolChars.size, aliasChars.size)) * 80);
  if (typeMatches(school, record)) score += 10;
  return score;
}

function stagePreference(school: SchoolRow, record: SourceRecord) {
  if (!record.stage || record.stage === "unknown") return 0;
  if (school.type === record.stage) return 30;
  // The current schema has one school-level tier. For nine-year schools,
  // prefer middle-school tier sources when primary and middle aliases tie.
  if (school.type === "nine_year" && record.stage === "middle") return 20;
  if (school.type === "nine_year" && record.stage === "primary") return 10;
  return 0;
}

function loadSourceRecords() {
  if (!existsSync(sourcePath)) throw new Error(`Source JSON not found: ${sourcePath}`);
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as TierFile;
  const records: SourceRecord[] = [];
  for (const item of source.items ?? []) {
    if (!VALID_TIERS.has(item.tier)) throw new Error(`Unsupported tier: ${item.tier}`);
    for (const name of item.names ?? []) {
      records.push({ ...item, sourceAlias: name });
    }
  }
  return records.filter((record) => record.tier !== PLACEHOLDER_TIER);
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-").replace("Z", "");
  const dir = path.join(process.cwd(), ".tmp", "school-tier-backfill", stamp);
  let uniqueDir = dir;
  let suffix = 0;
  while (existsSync(uniqueDir)) {
    suffix += 1;
    uniqueDir = `${dir}-${process.pid}-${suffix}`;
  }
  mkdirSync(uniqueDir, { recursive: true });
  return {
    snapshot: path.join(uniqueDir, "target-schools-before.json"),
    report: path.join(uniqueDir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

async function main() {
  const sourceRecords = loadSourceRecords();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const params: string[] = [];
    const where = overwrite ? ["TRUE"] : ["(tier IS NULL OR btrim(tier) = '' OR tier = '未入榜/待补充')"];
    if (district) {
      params.push(district);
      where.push(`district = $${params.length}`);
    }

    const target = await client.query<SchoolRow>(
      `
        SELECT id, name, district, type, tier, attrs
        FROM schools
        WHERE ${where.join(" AND ")}
        ORDER BY district, type, id
      `,
      params,
    );

    const paths = outputPaths();
    writeFileSync(paths.snapshot, JSON.stringify(target.rows, null, 2), "utf8");
    console.log(`Source aliases: ${sourceRecords.length} (${sourcePath})`);
    console.log(`Target schools: ${target.rows.length}${district ? ` (district=${district})` : ""}`);
    console.log(`Snapshot: ${paths.snapshot}`);
    console.log(`Mode: ${apply ? "apply" : "dry-run"}, minScore=${minScore}, overwrite=${overwrite}`);

    const reports: MatchReport[] = [];
    let matched = 0;
    let updated = 0;

    await client.query("BEGIN");
    for (const school of target.rows) {
      const ranked = sourceRecords
        .filter((record) => record.district === school.district)
        .map((record, index) => {
          const score = scoreRecord(school, record);
          return { record, score, rankScore: score + stagePreference(school, record), index };
        })
        .sort((a, b) => b.rankScore - a.rankScore || b.score - a.score || a.index - b.index);
      const best = ranked[0];

      if (!best || best.score < minScore) {
        reports.push({
          school,
          match: best?.record ?? null,
          score: best?.score ?? 0,
          rankScore: best?.rankScore ?? 0,
          action: "skip-low-score",
        });
        continue;
      }

      matched += 1;
      reports.push({
        school,
        match: best.record,
        score: best.score,
        rankScore: best.rankScore,
        action: apply ? "update" : "dry-run",
      });
      console.log(
        `${apply ? "UPDATE" : "DRY"} id=${school.id} ${school.district} ${school.name} -> ${best.record.tier} (${best.record.sourceAlias}) score=${best.score} rank=${best.rankScore}`,
      );

      if (apply) {
        const result = await client.query(
          `
            UPDATE schools
            SET
              tier = $1,
              attrs = jsonb_set(
                coalesce(attrs, '{}'::jsonb),
                '{schoolTierSource}',
                $2::jsonb,
                true
              ),
              updated_at = now()
            WHERE id = $3
              AND name = $4
              AND district = $5
              AND ($6::boolean OR tier IS NULL OR btrim(tier) = '' OR tier = '未入榜/待补充')
          `,
          [
            best.record.tier,
            JSON.stringify({
              name: best.record.sourceName,
              url: best.record.sourceUrl,
              note: best.record.sourceNote,
              verified: best.record.verified ?? false,
              matched_name: best.record.sourceAlias,
              match_score: best.score,
              stage: best.record.stage ?? null,
              collected_at: new Date().toISOString(),
            }),
            school.id,
            school.name,
            school.district,
            overwrite,
          ],
        );
        updated += result.rowCount ?? 0;
      }
    }

    if (!apply) await client.query("ROLLBACK");
    else await client.query("COMMIT");

    writeFileSync(paths.report, JSON.stringify(reports, null, 2), "utf8");
    console.log(`Matched: ${matched}`);
    console.log(`Updated: ${updated}`);
    console.log(`Report: ${paths.report}`);
    if (!apply) console.log("Dry-run complete. No database changes were written.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
