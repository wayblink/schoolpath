/** Backfill school ids for official school-community candidates with unique matches. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";
import { findUniqueSchoolMatch, type SchoolNameStage, type SchoolNameRow } from "../lib/school-name-matching";

const { Client } = pg;
loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const year = Number(valueArg("--year") ?? "2026");
const district = valueArg("--district");
const limit = Number(valueArg("--limit") ?? "0");
if (!Number.isInteger(year) || year < 2000) throw new Error("--year must be a valid year.");
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer.");

type CandidateRow = {
  id: number;
  school_name_raw: string;
  district: string;
  confidence: string;
  raw: Record<string, unknown> | null;
};

type Action = {
  candidateId: number;
  district: string;
  schoolNameRaw: string;
  oldSchoolId: null;
  schoolId: number | null;
  matchKind: string | null;
  action: "backfill" | "skip-no-unique-match";
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function stageFromRaw(raw: Record<string, unknown> | null): SchoolNameStage {
  const stage = raw?.stage;
  if (stage === "primary" || stage === "middle") return stage;
  const category = raw?.sourceCategory;
  if (category === "primary-scope") return "primary";
  if (category === "middle-scope") return "middle";
  return "unknown";
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "candidate-school-id-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const dir = outputDir();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const candidates = await client.query<CandidateRow>(
      `SELECT id, school_name_raw, district, confidence, raw
       FROM school_community_candidates
       WHERE year = $1 AND school_id IS NULL
         AND ($2::text IS NULL OR district = $2)
       ORDER BY district, id
       ${limit > 0 ? `LIMIT ${limit}` : ""}`,
      [year, district ?? null],
    );
    writeFileSync(path.join(dir, "candidates-source.json"), JSON.stringify(candidates.rows, null, 2), "utf8");

    const districtNames = [...new Set(candidates.rows.map((row) => row.district))];
    const schools = await client.query<SchoolNameRow & { district: string }>(
      `SELECT id, name, aliases, type, district
       FROM schools WHERE district = ANY($1) ORDER BY district, id`,
      [districtNames],
    );
    const schoolsByDistrict = new Map<string, SchoolNameRow[]>();
    for (const school of schools.rows) {
      const list = schoolsByDistrict.get(school.district) ?? [];
      list.push(school);
      schoolsByDistrict.set(school.district, list);
    }

    const actions: Action[] = [];
    for (const candidate of candidates.rows) {
      const match = findUniqueSchoolMatch(
        { name: candidate.school_name_raw, stage: stageFromRaw(candidate.raw) },
        schoolsByDistrict.get(candidate.district) ?? [],
      );
      if (candidate.raw?.boundaryOnly === true) {
        actions.push({
          candidateId: candidate.id,
          district: candidate.district,
          schoolNameRaw: candidate.school_name_raw,
          oldSchoolId: null,
          schoolId: null,
          matchKind: null,
          action: "skip-no-unique-match",
        });
        continue;
      }
      if (!match) {
        actions.push({
          candidateId: candidate.id,
          district: candidate.district,
          schoolNameRaw: candidate.school_name_raw,
          oldSchoolId: null,
          schoolId: null,
          matchKind: null,
          action: "skip-no-unique-match",
        });
        continue;
      }
      actions.push({
        candidateId: candidate.id,
        district: candidate.district,
        schoolNameRaw: candidate.school_name_raw,
        oldSchoolId: null,
        schoolId: match.schoolId,
        matchKind: match.matchKind,
        action: "backfill",
      });
    }

    let updated = 0;
    if (apply) {
      await client.query("BEGIN");
      try {
        for (const action of actions.filter((item) => item.action === "backfill")) {
          const result = await client.query(
            `UPDATE school_community_candidates
             SET school_id = $2,
                 confidence = CASE WHEN confidence = 'low' THEN 'medium' ELSE confidence END,
                 review_notes = concat_ws(E'\\n', review_notes, $3::text),
                 updated_at = now()
             WHERE id = $1 AND school_id IS NULL`,
            [
              action.candidateId,
              action.schoolId,
              `school_id backfilled ${new Date().toISOString()} by scripts/backfill-candidate-school-ids.ts (${action.matchKind}); relation still requires review.`,
            ],
          );
          updated += result.rowCount ?? 0;
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const reportPath = path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json");
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          mode: apply ? "apply" : "dry-run",
          year,
          district: district ?? null,
          candidates: candidates.rows.length,
          matched: actions.filter((item) => item.action === "backfill").length,
          skipped: actions.filter((item) => item.action === "skip-no-unique-match").length,
          updated,
          report: reportPath,
          actions,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", year, district: district ?? null, candidates: candidates.rows.length, matched: actions.filter((item) => item.action === "backfill").length, skipped: actions.filter((item) => item.action === "skip-no-unique-match").length, updated, report: reportPath }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
