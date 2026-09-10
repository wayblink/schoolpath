/**
 * Fill a blank community source_committee from its existing official
 * school-community relations for one year.
 *
 * This stores an official enrollment-area label, not a geocoded address. A
 * community is eligible only when every relation for that year is same-
 * district, official, has a government URL, and supplies one identical
 * non-empty committee_name. Dry-run is the default; pass --apply to commit.
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
const year = Number(valueArg("--year") ?? "2026");
const limit = Number(valueArg("--limit") ?? "0");

if (!Number.isInteger(year) || year < 2000) throw new Error("--year must be a valid year.");
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer.");

type JsonRecord = Record<string, unknown>;

export type CommitteeEvidence = {
  relationId: number;
  schoolDistrict: string;
  committeeName: string | null;
  sourceName: string | null;
  sourceUrl: string | null;
  sourceQuote: string | null;
};

type CommunityRow = {
  id: number;
  name: string;
  district: string;
  amap_address: string | null;
  source_committee: string | null;
  attrs: JsonRecord | null;
};

type RelationRow = {
  community_id: number;
  relation_id: number;
  school_district: string;
  committee_name: string | null;
  source_name: string;
  source_url: string | null;
  source_quote: string | null;
};

type Selection =
  | { eligible: true; committeeName: string }
  | { eligible: false; reason: string };

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function isGovernmentUrl(value: string | null) {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "gov.cn" || hostname.endsWith(".gov.cn");
  } catch {
    return false;
  }
}

function isOfficialEvidence(evidence: CommitteeEvidence) {
  return Boolean(evidence.sourceName?.startsWith("official_") && isGovernmentUrl(evidence.sourceUrl));
}

export function selectUniqueOfficialCommittee(
  communityDistrict: string,
  evidenceRows: CommitteeEvidence[],
): Selection {
  if (evidenceRows.length === 0) return { eligible: false, reason: "no-relations" };
  if (evidenceRows.some((row) => row.schoolDistrict !== communityDistrict)) {
    return { eligible: false, reason: "district-mismatch" };
  }
  if (evidenceRows.some((row) => !isOfficialEvidence(row))) {
    return { eligible: false, reason: "non-official-or-missing-source" };
  }
  const values = evidenceRows.map((row) => row.committeeName?.trim() ?? "");
  if (values.some((value) => !value)) return { eligible: false, reason: "missing-committee-name" };
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length !== 1) return { eligible: false, reason: "conflicting-committee-names" };
  return { eligible: true, committeeName: uniqueValues[0] };
}

function reportDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "official-relation-committee-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function relationEvidence(row: RelationRow): CommitteeEvidence {
  return {
    relationId: row.relation_id,
    schoolDistrict: row.school_district,
    committeeName: row.committee_name,
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    sourceQuote: row.source_quote,
  };
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  const dir = reportDir();
  await client.connect();

  let updated = 0;
  const actions: Array<Record<string, unknown>> = [];

  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '60s'");

    const communities = (
      await client.query<CommunityRow>(
        `SELECT c.id,c.name,c.district,c.amap_address,c.source_committee,c.attrs
           FROM public.communities c
          WHERE (c.source_committee IS NULL OR btrim(c.source_committee) = '')
            AND (c.amap_address IS NULL OR btrim(c.amap_address) = '')
            AND EXISTS (
              SELECT 1 FROM public.school_communities sc
               WHERE sc.community_id = c.id AND sc.year = $1
            )
          ORDER BY c.district,c.id
          ${limit > 0 ? `LIMIT ${limit}` : ""}
          FOR UPDATE OF c`,
        [year],
      )
    ).rows;
    const communityIds = communities.map((community) => community.id);
    const relations = communityIds.length
      ? (
          await client.query<RelationRow>(
            `SELECT sc.community_id,sc.id AS relation_id,s.district AS school_district,
                    sc.committee_name,sc.source_name,sc.source_url,sc.source_quote
               FROM public.school_communities sc
               JOIN public.schools s ON s.id = sc.school_id
              WHERE sc.year = $1 AND sc.community_id = ANY($2::int[])
              ORDER BY sc.community_id,sc.id`,
            [year, communityIds],
          )
        ).rows
      : [];

    writeFileSync(path.join(dir, "communities-before.json"), JSON.stringify(communities, null, 2), "utf8");
    writeFileSync(path.join(dir, "relations-evidence.json"), JSON.stringify(relations, null, 2), "utf8");

    const relationsByCommunity = new Map<number, RelationRow[]>();
    for (const relation of relations) {
      relationsByCommunity.set(relation.community_id, [
        ...(relationsByCommunity.get(relation.community_id) ?? []),
        relation,
      ]);
    }

    for (const community of communities) {
      const communityRelations = relationsByCommunity.get(community.id) ?? [];
      const evidence = communityRelations.map(relationEvidence);
      const selection = selectUniqueOfficialCommittee(community.district, evidence);
      if (!selection.eligible) {
        actions.push({
          communityId: community.id,
          communityName: community.name,
          district: community.district,
          action: "skip",
          reason: selection.reason,
          relationIds: evidence.map((row) => row.relationId),
        });
        continue;
      }

      const provenance = {
        source: "official_relation_committee_backfill",
        year,
        committee_name: selection.committeeName,
        relation_ids: evidence.map((row) => row.relationId),
        source_names: [...new Set(evidence.map((row) => row.sourceName))],
        source_urls: [...new Set(evidence.map((row) => row.sourceUrl))],
        source_quotes: [...new Set(evidence.map((row) => row.sourceQuote).filter(Boolean))],
        evidence_rule: "all same-year relations are same-district official sources with one identical non-empty committee_name",
        recorded_at: new Date().toISOString(),
      };
      const attrs = {
        ...(community.attrs ?? {}),
        official_relation_committee_backfill: provenance,
      };

      if (apply) {
        const result = await client.query(
          `UPDATE public.communities
              SET source_committee = $1,
                  attrs = $2::jsonb
            WHERE id = $3
              AND district = $4
              AND (source_committee IS NULL OR btrim(source_committee) = '')
              AND (amap_address IS NULL OR btrim(amap_address) = '')
          RETURNING id`,
          [selection.committeeName, JSON.stringify(attrs), community.id, community.district],
        );
        updated += result.rowCount ?? 0;
        if (result.rowCount !== 1) {
          throw new Error(`guarded update failed for community ${community.id}`);
        }
      }

      actions.push({
        communityId: community.id,
        communityName: community.name,
        district: community.district,
        committeeName: selection.committeeName,
        relationIds: provenance.relation_ids,
        sourceUrls: provenance.source_urls,
        action: apply ? "updated" : "dry-run",
        provenance,
      });
    }

    const planned = actions.filter((action) => action.action === "updated" || action.action === "dry-run").length;
    const report = path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json");
    writeFileSync(
      report,
      JSON.stringify({ mode: apply ? "apply" : "dry-run", year, scanned: communities.length, planned, updated, actions }, null, 2),
      "utf8",
    );

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", year, scanned: communities.length, planned, updated, report }, null, 2));
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
