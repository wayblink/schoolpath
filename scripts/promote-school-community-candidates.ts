/**
 * Promote reviewed school-community candidates into formal school_communities links.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to COMMIT
 * - never deletes, truncates, resets, or overwrites communities
 * - maps candidate committee names to existing communities.source_committee
 * - skips boundary-only and low/medium confidence candidates unless explicitly selected
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const district = valueArg("--district");
const year = Number(valueArg("--year") ?? "2026");
const statuses = listArg("--status", ["pending"]);
const confidences = listArg("--confidence", ["high"]);
const includeBoundaryOnly = process.argv.includes("--include-boundary-only");
const allowContainedSourceCommittee = process.argv.includes("--allow-contained-source-committee");
const maxCandidateCoreLength = Number(valueArg("--max-candidate-core-length") ?? "1");
const limit = Number(valueArg("--limit") ?? "0");

if (!district) throw new Error("--district is required.");
if (!Number.isInteger(year)) throw new Error("--year must be an integer.");
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer.");
if (!Number.isInteger(maxCandidateCoreLength) || maxCandidateCoreLength < 0) {
  throw new Error("--max-candidate-core-length must be a non-negative integer.");
}

type CandidateRow = {
  id: number;
  school_id: number | null;
  school_name_raw: string;
  district: string;
  year: number;
  community_name_raw: string;
  committee_name_raw: string | null;
  source_url: string | null;
  source_title: string;
  source_date: string | null;
  source_quote: string;
  confidence: string;
  status: string;
  raw: Record<string, unknown> | null;
};

type CommunityRow = {
  id: number;
  name: string;
  district: string;
  source_committee: string | null;
};

type ExistingLinkRow = {
  school_id: number;
  community_id: number;
  year: number;
};

type PlannedAction = {
  candidateId: number;
  schoolId: number | null;
  schoolNameRaw: string;
  candidateName: string;
  candidateCore: string;
  action:
    | "dry-run-insert"
    | "insert"
    | "skip-existing-link"
    | "skip-no-school-id"
    | "skip-short-candidate-name"
    | "skip-unmatched-committee";
  matchedCommunityIds: number[];
  matchedCommunityNames: string[];
  sourceTitle: string;
  sourceUrl: string | null;
  sourceQuote: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1]?.trim();
  return undefined;
}

function listArg(name: string, fallback: string[]) {
  const value = valueArg(name);
  if (!value) return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-community-candidate-promotion", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    candidatesSnapshot: path.join(dir, "candidates-source.json"),
    communitiesSnapshot: path.join(dir, "communities-source.json"),
    linksSnapshot: path.join(dir, "school-community-links-before.json"),
    report: path.join(dir, apply ? "promotion-applied.json" : "promotion-dry-run.json"),
  };
}

function normalizeText(value: string) {
  return value
    .replace(/[（）]/g, (char) => (char === "（" ? "(" : ")"))
    .replace(/\([^)]*\)/g, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\s+/g, "")
    .replace(/[，,、;；:：。.!！?？"'“”‘’]/g, "")
    .trim();
}

function committeeCore(value: string) {
  return normalizeText(value)
    .replace(/居民委员会$/g, "")
    .replace(/社区居委会$/g, "")
    .replace(/居委会$/g, "")
    .replace(/居委$/g, "")
    .replace(/村委会$/g, "")
    .replace(/村委$/g, "")
    .replace(/社区$/g, "")
    .replace(/居民区$/g, "")
    .trim();
}

function isBoundaryOnly(candidate: CandidateRow) {
  return candidate.raw?.boundaryOnly === true;
}

function candidateName(candidate: CandidateRow) {
  return candidate.committee_name_raw || candidate.community_name_raw;
}

function linkKey(schoolId: number, communityId: number, linkYear: number) {
  return `${schoolId}::${communityId}::${linkYear}`;
}

function sourceName(candidate: CandidateRow) {
  const extraction = typeof candidate.raw?.extraction === "string" ? candidate.raw.extraction : "candidate";
  return `official_school_community_candidates:${extraction}`;
}

function matchCommunities(candidate: CandidateRow, communities: CommunityRow[]) {
  const name = candidateName(candidate);
  const core = committeeCore(name);
  if (core.length <= maxCandidateCoreLength) return { core, matches: [] };

  const matches = communities.filter((community) => {
    if (!community.source_committee) return false;
    const sourceCore = committeeCore(community.source_committee);
    if (!sourceCore) return false;
    return sourceCore === core || (allowContainedSourceCommittee && sourceCore.includes(core));
  });

  return { core, matches };
}

async function main() {
  const paths = outputPaths();
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const candidates = await client.query<CandidateRow>(
      `
        SELECT id, school_id, school_name_raw, district, year, community_name_raw, committee_name_raw,
               source_url, source_title, source_date, source_quote, confidence, status, raw
        FROM school_community_candidates
        WHERE district = $1
          AND year = $2
          AND status = ANY($3)
          AND confidence = ANY($4)
          AND ($5 OR COALESCE((raw->>'boundaryOnly')::boolean, false) = false)
        ORDER BY id
        ${limit > 0 ? `LIMIT ${limit}` : ""}
      `,
      [district, year, statuses, confidences, includeBoundaryOnly],
    );
    writeFileSync(paths.candidatesSnapshot, JSON.stringify(candidates.rows, null, 2), "utf8");

    const communities = await client.query<CommunityRow>(
      `
        SELECT id, name, district, source_committee
        FROM communities
        WHERE district = $1
        ORDER BY id
      `,
      [district],
    );
    writeFileSync(paths.communitiesSnapshot, JSON.stringify(communities.rows, null, 2), "utf8");

    const links = await client.query<ExistingLinkRow>(
      `
        SELECT sc.school_id, sc.community_id, sc.year
        FROM school_communities sc
        JOIN schools s ON s.id = sc.school_id
        WHERE s.district = $1 AND sc.year = $2
        ORDER BY sc.school_id, sc.community_id
      `,
      [district, year],
    );
    writeFileSync(paths.linksSnapshot, JSON.stringify(links.rows, null, 2), "utf8");

    const existingLinks = new Set(links.rows.map((row) => linkKey(row.school_id, row.community_id, row.year)));
    const report: PlannedAction[] = [];
    const promotedCandidateIds = new Set<number>();

    let insertedLinks = 0;
    let dryRunLinks = 0;
    let skippedExistingLinks = 0;
    let skippedNoSchoolId = 0;
    let skippedShortCandidateName = 0;
    let skippedUnmatchedCommittee = 0;

    console.log(`Mode: ${apply ? "APPLY (COMMIT)" : "dry-run (ROLLBACK)"}`);
    console.log(`District: ${district}`);
    console.log(`Year: ${year}`);
    console.log(`Statuses: ${statuses.join(",")}`);
    console.log(`Confidences: ${confidences.join(",")}`);
    console.log(`Include boundary-only: ${includeBoundaryOnly ? "yes" : "no"}`);
    console.log(`Allow contained source_committee match: ${allowContainedSourceCommittee ? "yes" : "no"}`);
    console.log(`Candidates: ${candidates.rows.length}`);
    console.log(`Existing ${district} communities: ${communities.rows.length}`);
    console.log(`Existing ${district} links for ${year}: ${links.rows.length}`);
    console.log(`Output: ${paths.dir}`);

    await client.query("BEGIN");
    for (const candidate of candidates.rows) {
      const name = candidateName(candidate);
      const { core, matches } = matchCommunities(candidate, communities.rows);
      const matchedCommunityIds = matches.map((community) => community.id);
      const matchedCommunityNames = matches.map((community) => community.name);
      const baseAction = {
        candidateId: candidate.id,
        schoolId: candidate.school_id,
        schoolNameRaw: candidate.school_name_raw,
        candidateName: name,
        candidateCore: core,
        matchedCommunityIds,
        matchedCommunityNames,
        sourceTitle: candidate.source_title,
        sourceUrl: candidate.source_url,
        sourceQuote: candidate.source_quote,
      };

      if (!candidate.school_id) {
        skippedNoSchoolId += 1;
        report.push({ ...baseAction, action: "skip-no-school-id" });
        continue;
      }

      if (core.length <= maxCandidateCoreLength) {
        skippedShortCandidateName += 1;
        report.push({ ...baseAction, action: "skip-short-candidate-name" });
        continue;
      }

      if (matches.length === 0) {
        skippedUnmatchedCommittee += 1;
        report.push({ ...baseAction, action: "skip-unmatched-committee" });
        continue;
      }

      let candidateHadLink = false;
      for (const community of matches) {
        const key = linkKey(candidate.school_id, community.id, year);
        if (existingLinks.has(key)) {
          skippedExistingLinks += 1;
          candidateHadLink = true;
          report.push({
            ...baseAction,
            action: "skip-existing-link",
            matchedCommunityIds: [community.id],
            matchedCommunityNames: [community.name],
          });
          continue;
        }

        if (!apply) {
          dryRunLinks += 1;
          candidateHadLink = true;
          report.push({
            ...baseAction,
            action: "dry-run-insert",
            matchedCommunityIds: [community.id],
            matchedCommunityNames: [community.name],
          });
          continue;
        }

        const result = await client.query<{ id: number }>(
          `
            INSERT INTO school_communities (
              school_id, community_id, committee_name, year, source_name, source_url, source_quote,
              source_date, verified, notes
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9)
            ON CONFLICT (school_id, community_id, year) DO NOTHING
            RETURNING id
          `,
          [
            candidate.school_id,
            community.id,
            name,
            year,
            sourceName(candidate),
            candidate.source_url,
            candidate.source_quote,
            candidate.source_date ?? String(year),
            `由 school_community_candidates#${candidate.id} 按居委匹配到既有小区 source_committee；需人工抽检。`,
          ],
        );
        existingLinks.add(key);
        candidateHadLink = true;
        if (result.rows[0]) insertedLinks += 1;
        else skippedExistingLinks += 1;
        report.push({
          ...baseAction,
          action: result.rows[0] ? "insert" : "skip-existing-link",
          matchedCommunityIds: [community.id],
          matchedCommunityNames: [community.name],
        });
      }

      if (candidateHadLink) promotedCandidateIds.add(candidate.id);
    }

    if (apply && promotedCandidateIds.size > 0) {
      await client.query(
        `
          UPDATE school_community_candidates
          SET status = 'promoted',
              review_notes = concat_ws(E'\n', review_notes, $2::text),
              updated_at = now()
          WHERE id = ANY($1)
        `,
        [
          [...promotedCandidateIds],
          `promoted ${new Date().toISOString()} by scripts/promote-school-community-candidates.ts`,
        ],
      );
    }

    writeFileSync(paths.report, JSON.stringify(report, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    const summary = {
      mode: apply ? "apply" : "dry-run",
      district,
      year,
      statuses,
      confidences,
      includeBoundaryOnly,
      allowContainedSourceCommittee,
      candidates: candidates.rows.length,
      existingCommunities: communities.rows.length,
      existingLinks: links.rows.length,
      promotedCandidates: promotedCandidateIds.size,
      insertedLinks,
      dryRunLinks,
      skippedExistingLinks,
      skippedNoSchoolId,
      skippedShortCandidateName,
      skippedUnmatchedCommittee,
      report: paths.report,
    };

    console.log(`Report: ${paths.report}`);
    console.log(JSON.stringify(summary, null, 2));
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
