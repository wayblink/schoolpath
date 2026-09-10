/**
 * Incrementally backfill blank school address/nature from official review JSON.
 *
 * Safety rules:
 * - default mode is dry-run; pass --apply to write
 * - exports target snapshot and match report
 * - only fills blank address; never overwrites existing address
 * - only fills missing/invalid school_nature; never overwrites valid nature
 * - UPDATE is guarded by id + name + district
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
const sourcePath =
  valueArg("--source") ?? path.join(process.cwd(), ".tmp", "official-school-info", "latest.json");
const district = valueArg("--district");
const minScore = numberArg("--min-score") ?? 78;

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  address: string | null;
  school_nature: "公立" | "私立" | null;
  attrs: Record<string, unknown> | null;
};

type SourceRecord = {
  district: string;
  stage: "primary" | "middle" | "unknown";
  name: string;
  nature: string;
  address: string;
  sourceTitle: string;
  sourceUrl: string;
};

type SourceFile = {
  generatedAt: string;
  records: SourceRecord[];
};

type FilledFields = {
  address: boolean;
  schoolNature: boolean;
};

type MatchReport = {
  school: SchoolRow;
  match: SourceRecord | null;
  score: number;
  action: string;
  filledFields?: FilledFields;
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

function normalizeName(value: string) {
  return value
    .replace(/[\s　·•\-—]+/g, "")
    .replace(/[()（）]/g, "")
    .replace(/^上海市/, "")
    .replace(/区/g, "")
    .replace(/教育集团|集团校|小学部|初中部|（.*?）|\(.*?\)/g, "")
    .replace(/学校名称/g, "")
    .trim();
}

function compactName(value: string) {
  return value
    .replace(/[\s　·•\-—]+/g, "")
    .replace(/^上海市/, "")
    .replace(/[()（）]/g, "")
    .replace(/（.*?）|\(.*?\)/g, "")
    .trim();
}

function branchTokens(value: string) {
  const compact = compactName(value);
  const tokens = new Set<string>();
  const patterns = [
    /[^市区县镇路街弄号（）()\s　·•\-—]*(?:东部|西部|南部|北部|东|西|南|北)?分校/g,
    /[^市区县镇路街弄号（）()\s　·•\-—]*(?:东|西|南|北)?校区/g,
    /[^市区县镇路街弄号（）()\s　·•\-—]*(?:东校|西校|南校|北校|东校区|西校区|南校区|北校区)/g,
    /总部|本部|白银路|北水湾|古猗|海波|花园|平原|思贤/g,
  ];
  for (const pattern of patterns) {
    for (const match of compact.matchAll(pattern)) {
      const token = match[0]?.replace(/校区|分校/g, "");
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

function branchPenalty(school: SchoolRow, record: SourceRecord) {
  const schoolTokens = branchTokens(school.name);
  const recordTokens = branchTokens(record.name);
  if (recordTokens.size === 0) return 0;
  let missing = 0;
  for (const token of recordTokens) {
    if (!schoolTokens.has(token)) missing += 1;
  }
  return missing * 80;
}

function typeMatches(school: SchoolRow, record: SourceRecord) {
  if (record.stage === "unknown") return true;
  if (school.type === "nine_year") return true;
  return school.type === record.stage;
}

function scoreRecord(school: SchoolRow, record: SourceRecord) {
  if (school.district !== record.district) return -100;
  if (!typeMatches(school, record)) return -20;

  const a = normalizeName(school.name);
  const b = normalizeName(record.name);
  const strictA = compactName(school.name);
  const strictB = compactName(record.name);
  if (!a || !b) return -100;
  if (strictA === strictB) return 260;
  if (a === b) return 220 - branchPenalty(school, record);
  let score = 0;
  if (a.includes(b) || b.includes(a)) score += 90;
  const aChars = new Set(a);
  const bChars = new Set(b);
  let overlap = 0;
  for (const char of aChars) {
    if (bChars.has(char)) overlap += 1;
  }
  score += Math.round((overlap / Math.max(aChars.size, bChars.size)) * 80);
  if (typeMatches(school, record)) score += 12;
  if (/校区|分校|本部|总部/.test(school.name) && /校区|分校|本部|总部/.test(record.name)) score += 8;
  return score - branchPenalty(school, record);
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-school-info-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "target-schools-before.json"),
    report: path.join(dir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

function schoolNatureToEnum(nature: string): "公立" | "私立" | "" {
  if (nature.includes("民办")) return "私立";
  if (nature.includes("公办")) return "公立";
  return "";
}

function effectiveNature(record: SourceRecord) {
  const explicit = record.nature.trim();
  if (hasValidSchoolNatureValue(explicit)) return explicit;
  if (/民办/.test(record.sourceTitle)) return "民办";
  if (/公办/.test(record.sourceTitle)) return "公办";
  return explicit;
}

function hasValidSchoolNatureValue(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const normalized = text.toLowerCase();
  return (
    normalized.includes("公办") ||
    normalized.includes("民办") ||
    normalized.includes("public") ||
    normalized.includes("private")
  );
}

function hasValidSchoolNature(value: "公立" | "私立" | null) {
  return value === "公立" || value === "私立";
}

async function main() {
  if (!existsSync(sourcePath)) throw new Error(`Source JSON not found: ${sourcePath}`);
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as SourceFile;
  const sourceRecords = source.records
    .map((record) => ({ ...record, nature: effectiveNature(record) }))
    .filter((record) => record.address.trim() || record.nature.trim());
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const params: string[] = [];
    const where = [
      `(
        address IS NULL
        OR btrim(address) = ''
        OR school_nature IS NULL
      )`,
    ];
    if (district) {
      params.push(district);
      where.push(`district = $${params.length}`);
    }
    const target = await client.query<SchoolRow>(
      `
        SELECT id, name, district, type, address, school_nature, attrs
        FROM schools
        WHERE ${where.join(" AND ")}
        ORDER BY district, id
      `,
      params,
    );

    const paths = outputPaths();
    writeFileSync(paths.snapshot, JSON.stringify(target.rows, null, 2), "utf8");
    console.log(`Source records: ${sourceRecords.length} (${sourcePath})`);
    console.log(`Target schools: ${target.rows.length}${district ? ` (district=${district})` : ""}`);
    console.log(`Snapshot: ${paths.snapshot}`);
    console.log(`Mode: ${apply ? "apply" : "dry-run"}, minScore=${minScore}`);

    const reports: MatchReport[] = [];
    let matched = 0;
    let updated = 0;

    await client.query("BEGIN");
    for (const school of target.rows) {
      const ranked = sourceRecords
        .filter((record) => record.district === school.district)
        .map((record) => ({ record, score: scoreRecord(school, record) }))
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];

      if (!best || best.score < minScore) {
        reports.push({ school, match: best?.record ?? null, score: best?.score ?? 0, action: "skip-low-score" });
        continue;
      }

      const publicPrivateType = schoolNatureToEnum(best.record.nature);
      const needsAddress = school.address == null || school.address.trim() === "";
      const needsSchoolNature = !hasValidSchoolNature(school.school_nature);
      const filledFields = {
        address: needsAddress && best.record.address.trim() !== "",
        schoolNature: needsSchoolNature && hasValidSchoolNatureValue(best.record.nature),
      };

      if (!filledFields.address && !filledFields.schoolNature) {
        reports.push({
          school,
          match: best.record,
          score: best.score,
          action: "skip-no-fillable-fields",
          filledFields,
        });
        continue;
      }

      matched += 1;
      reports.push({
        school,
        match: best.record,
        score: best.score,
        action: apply ? "update" : "dry-run",
        filledFields,
      });
      console.log(
        `${apply ? "UPDATE" : "DRY"} id=${school.id} ${school.district} ${school.name} -> ${best.record.address || "(address unchanged)"} nature=${best.record.nature || "(nature unchanged)"} score=${best.score} filled=${JSON.stringify(filledFields)}`,
      );

      if (apply) {
        const result = await client.query(
          `
            UPDATE schools
            SET
              address = CASE
                WHEN (address IS NULL OR btrim(address) = '') AND nullif(btrim($1), '') IS NOT NULL THEN $1
                ELSE address
              END,
              school_nature = CASE
                WHEN school_nature IS NULL AND $3::jsonb IS NOT NULL
                  THEN nullif($3::jsonb->>'normalized', '')::school_nature
                ELSE school_nature
              END,
              attrs = CASE
                WHEN $3::jsonb IS NULL THEN jsonb_set(
                  coalesce(attrs, '{}'::jsonb),
                  '{official_school_info_source}',
                  $2::jsonb,
                  true
                )
                ELSE jsonb_set(
                  jsonb_set(
                    coalesce(attrs, '{}'::jsonb),
                    '{official_school_info_source}',
                    $2::jsonb,
                    true
                  ),
                  '{school_nature}',
                  $3::jsonb,
                  true
                )
              END,
              updated_at = now()
            WHERE id = $4
              AND name = $5
              AND district = $6
              AND (
                address IS NULL
                OR btrim(address) = ''
                OR school_nature IS NULL
              )
          `,
          [
            filledFields.address ? best.record.address : "",
            JSON.stringify({
              source_title: best.record.sourceTitle,
              source_url: best.record.sourceUrl,
              source_generated_at: source.generatedAt,
              matched_name: best.record.name,
              match_score: best.score,
              collected_at: new Date().toISOString(),
              filled: filledFields,
            }),
            filledFields.schoolNature
              ? JSON.stringify({
                  value: best.record.nature,
                  normalized: publicPrivateType,
                })
              : null,
            school.id,
            school.name,
            school.district,
          ],
        );
        updated += result.rowCount ?? 0;
      }
    }

    writeFileSync(paths.report, JSON.stringify(reports, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(`Report: ${paths.report}`);
    console.log(`Done. matched=${matched}, updated=${updated}, dryRun=${!apply}`);
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
