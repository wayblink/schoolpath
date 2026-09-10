/**
 * Promote uniquely matched, reviewed relation candidates into public links.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to commit
 * - only review_status=accepted candidates are eligible
 * - requires unique catalog school/community matches with legacy ids
 * - never deletes or overwrites an existing link
 * - writes source snapshots and an auditable report under .tmp/
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const year = Number(valueArg("--year") ?? "2026");
const limit = Number(valueArg("--limit") ?? "0");

if (!Number.isInteger(year) || year <= 0) throw new Error("--year must be a positive integer.");
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer.");

type CandidateRow = {
  id: number;
  district: string;
  school_name_raw: string;
  committee_name_raw: string;
  source_record_id: number;
  catalog_school_id: number | null;
  catalog_community_id: number | null;
  school_legacy_id: number | null;
  community_legacy_id: number | null;
  school_catalog_name: string | null;
  community_catalog_name: string | null;
  school_match_score: string;
  community_match_score: string;
  community_match_method: string;
  resolution_note: string | null;
  source_key: string;
  source_url: string | null;
  fetched_at: string | Date;
  raw: Record<string, unknown>;
};

type ExistingLink = { id: number; school_id: number; community_id: number; year: number; verified: boolean };

type ReportRow = {
  candidateId: number;
  sourceRecordId: number;
  district: string;
  schoolId: number | null;
  communityId: number | null;
  schoolName: string | null;
  communityName: string | null;
  action:
    | "dry-run-insert"
    | "insert"
    | "verify-existing-link"
    | "skip-existing-link"
    | "skip-incomplete-match";
  reason?: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "accepted-school-community-promotion", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    candidates: path.join(dir, "accepted-candidates.json"),
    linksBefore: path.join(dir, "public-school-communities-before.json"),
    report: path.join(dir, apply ? "promotion-applied.json" : "promotion-dry-run.json"),
  };
}

function key(schoolId: number, communityId: number, linkYear: number) {
  return `${schoolId}:${communityId}:${linkYear}`;
}

function quote(candidate: CandidateRow) {
  const raw = candidate.raw ?? {};
  const area = typeof raw.area === "string" ? raw.area : "";
  return [
    `来源记录 ${candidate.source_key}`,
    area ? `片区：${area}` : "",
    `居委/小区：${candidate.committee_name_raw}`,
    `匹配方法：${candidate.community_match_method}`,
  ]
    .filter(Boolean)
    .join("；");
}

function sourceDate(value: string | Date) {
  const iso = value instanceof Date ? value.toISOString() : value;
  return iso.slice(0, 10);
}

async function main() {
  const paths = outputPaths();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const candidateLimit = limit > 0 ? `LIMIT ${limit}` : "";
    const candidates = await client.query<CandidateRow>(
      `
        SELECT
          r.id, r.district, r.school_name_raw, r.committee_name_raw, r.source_record_id,
          r.catalog_school_id, r.catalog_community_id,
          cs.legacy_id AS school_legacy_id, cc.legacy_id AS community_legacy_id,
          cs.canonical_name AS school_catalog_name, cc.name AS community_catalog_name,
          r.school_match_score, r.community_match_score, r.community_match_method,
          r.resolution_note, e.source_key, cr.source_url, cr.fetched_at, e.raw
        FROM audit.school_community_relation_candidates r
        JOIN ingest.extracted_records e ON e.id = r.source_record_id
        JOIN ingest.crawl_runs cr ON cr.id = r.crawl_run_id
        LEFT JOIN catalog.schools cs ON cs.id = r.catalog_school_id
        LEFT JOIN catalog.communities cc ON cc.id = r.catalog_community_id
        WHERE r.review_status = 'accepted'
        ORDER BY r.id
        ${candidateLimit}
      `,
    );
    writeFileSync(paths.candidates, JSON.stringify(candidates.rows, null, 2), "utf8");

    const links = await client.query<ExistingLink>(
      `SELECT id, school_id, community_id, year, verified FROM public.school_communities WHERE year = $1 ORDER BY school_id, community_id`,
      [year],
    );
    writeFileSync(paths.linksBefore, JSON.stringify(links.rows, null, 2), "utf8");

    const existing = new Map(links.rows.map((row) => [key(row.school_id, row.community_id, row.year), row]));
    const report: ReportRow[] = [];
    let inserted = 0;
    let wouldInsert = 0;
    let verifiedExisting = 0;
    let wouldVerifyExisting = 0;
    let skippedExisting = 0;
    let skippedIncomplete = 0;

    await client.query("BEGIN");
    for (const candidate of candidates.rows) {
      const schoolId = candidate.school_legacy_id;
      const communityId = candidate.community_legacy_id;
      const base = {
        candidateId: candidate.id,
        sourceRecordId: candidate.source_record_id,
        district: candidate.district,
        schoolId,
        communityId,
        schoolName: candidate.school_catalog_name,
        communityName: candidate.community_catalog_name,
      };

      if (!schoolId || !communityId) {
        skippedIncomplete += 1;
        report.push({ ...base, action: "skip-incomplete-match", reason: "catalog match missing legacy_id" });
        continue;
      }

      const linkKey = key(schoolId, communityId, year);
      const existingLink = existing.get(linkKey);
      if (existingLink) {
        if (existingLink.verified) {
          skippedExisting += 1;
          report.push({ ...base, action: "skip-existing-link", reason: "already verified" });
          continue;
        }

        if (!apply) {
          wouldVerifyExisting += 1;
          report.push({ ...base, action: "verify-existing-link", reason: "accepted candidate matched existing unverified link" });
          continue;
        }

        const verified = await client.query(
          `
            UPDATE public.school_communities
            SET verified = true,
                notes = concat_ws(E'\\n', notes, $1::text)
            WHERE id = $2::integer AND verified = false
          `,
          [`accepted 候选 #${candidate.id} 核验通过；保留原有来源字段。`, existingLink.id],
        );
        if ((verified.rowCount ?? 0) > 0) {
          verifiedExisting += 1;
          existingLink.verified = true;
          report.push({ ...base, action: "verify-existing-link" });
        } else {
          skippedExisting += 1;
          report.push({ ...base, action: "skip-existing-link", reason: "link changed during transaction" });
        }
        continue;
      }

      if (!apply) {
        wouldInsert += 1;
        report.push({ ...base, action: "dry-run-insert" });
        continue;
      }

      const result = await client.query<{ id: number }>(
        `
          INSERT INTO public.school_communities(
            school_id, community_id, committee_name, year, source_name, source_url,
            source_quote, source_date, verified, notes
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
          ON CONFLICT (school_id, community_id, year) DO NOTHING
          RETURNING id
        `,
        [
          schoolId,
          communityId,
          candidate.committee_name_raw,
          year,
          "xuequzhushou_reviewed_accepted",
          candidate.source_url,
          quote(candidate),
          sourceDate(candidate.fetched_at),
          `accepted 候选 #${candidate.id}；学校匹配=${candidate.school_match_score}，小区匹配=${candidate.community_match_score}；${candidate.resolution_note ?? ""}`,
        ],
      );
      if (result.rows[0]) {
        inserted += 1;
        existing.set(linkKey, { id: result.rows[0].id, school_id: schoolId, community_id: communityId, year, verified: true });
        report.push({ ...base, action: "insert" });
      } else {
        skippedExisting += 1;
        report.push({ ...base, action: "skip-existing-link" });
      }
    }

    writeFileSync(paths.report, JSON.stringify(report, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(
      JSON.stringify(
        {
          mode: apply ? "apply" : "dry-run",
          year,
          candidates: candidates.rows.length,
          inserted,
          wouldInsert,
          verifiedExisting,
          wouldVerifyExisting,
          skippedExisting,
          skippedIncomplete,
          report: paths.report,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
