/** Apply only strictly reviewed, exact community-coordinate matches from a dry-run report. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { communityLocationAuditRunName, isResidentialCommunityPoiType } from "../lib/community-location-review";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const sourceReport = valueArg("--source");
const minScore = Number(valueArg("--min-score") ?? "300");
const provider = valueArg("--provider") ?? "tencent";
if (!sourceReport || !existsSync(sourceReport)) throw new Error("--source must point to an existing dry-run report.");
if (!Number.isFinite(minScore) || minScore < 300) throw new Error("--min-score must be at least 300.");
if (!new Set(["amap", "tencent"]).has(provider)) throw new Error("--provider must be amap or tencent.");

type Community = {
  id: number;
  name: string;
  district: string;
  lng: number | null;
  lat: number | null;
};

type Match = {
  poiId: string;
  poiName: string;
  poiType: string;
  address: string;
  poiDistrict?: string;
  lat: number;
  lng: number;
  score: number;
  keyword: string;
};

type SourceRecord = { community: Community; match: Match | null; action: string };
type Action = {
  communityId: number;
  name: string;
  district: string;
  score: number | null;
  action: "dry-run" | "updated" | "skip";
  reason?: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function districtAddressToken(district: string) {
  return district === "浦东" ? "上海市浦东新区" : `上海市${district}区`;
}

function normalizeDistrict(value: string) {
  return value.replace(/上海市/g, "").replace(/新区$/g, "").replace(/区$/g, "").trim();
}

function shanghaiInRange(lng: number, lat: number) {
  return lng >= 120.85 && lng <= 122.15 && lat >= 30.65 && lat <= 31.9;
}

function eligibility(record: SourceRecord) {
  const { community, match } = record;
  if (!match) return "missing POI match";
  if (match.score < minScore) return `score ${match.score} is below ${minScore}`;
  if (match.poiName !== community.name) return "POI name is not an exact match";
  if (!isResidentialCommunityPoiType(match.poiType)) return `POI type is not an explicit residential community: ${match.poiType || "missing"}`;
  if (normalizeDistrict(match.poiDistrict ?? "") !== normalizeDistrict(community.district) && !match.address.includes(districtAddressToken(community.district))) {
    return "POI address is outside the target district";
  }
  if (!shanghaiInRange(match.lng, match.lat)) return "coordinates are outside Shanghai bounds";
  return null;
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "").replace("T", "-");
  const runName = communityLocationAuditRunName(stamp, provider, sourceReport!);
  const dir = path.join(process.cwd(), ".tmp", "reviewed-community-location-apply", runName);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "target-communities-before.json"),
    report: path.join(dir, apply ? "apply-report.json" : "dry-run-report.json"),
  };
}

async function main() {
  const parsed = JSON.parse(readFileSync(sourceReport!, "utf8")) as SourceRecord[];
  const uniqueRecords = [...new Map(parsed.map((record) => [record.community.id, record])).values()];
  const eligible = uniqueRecords.filter((record) => eligibility(record) === null);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const paths = outputPaths();

  try {
    const ids = eligible.map((record) => record.community.id);
    const current = ids.length
      ? await client.query<Community>(
          "SELECT id,name,district,lng,lat FROM communities WHERE id = ANY($1::int[]) ORDER BY id",
          [ids],
        )
      : { rows: [] as Community[] };
    writeFileSync(paths.snapshot, JSON.stringify(current.rows, null, 2), "utf8");
    const currentById = new Map(current.rows.map((row) => [row.id, row]));
    const actions: Action[] = [];
    let updated = 0;

    await client.query("BEGIN");
    for (const record of uniqueRecords) {
      const reason = eligibility(record);
      if (reason) {
        actions.push({ communityId: record.community.id, name: record.community.name, district: record.community.district, score: record.match?.score ?? null, action: "skip", reason });
        continue;
      }
      const match = record.match!;
      const row = currentById.get(record.community.id);
      if (!row || row.name !== record.community.name || row.district !== record.community.district) {
        actions.push({ communityId: record.community.id, name: record.community.name, district: record.community.district, score: match.score, action: "skip", reason: "database identity does not match report" });
        continue;
      }
      if (row.lng != null && row.lat != null) {
        actions.push({ communityId: row.id, name: row.name, district: row.district, score: match.score, action: "skip", reason: "coordinates already complete" });
        continue;
      }
      if (apply) {
        const evidence = JSON.stringify({
          provider,
          source: provider === "amap" ? "amap_place_text" : "tencent_place_search",
          source_report: path.resolve(sourceReport!),
          poi_id: match.poiId,
          poi_name: match.poiName,
          poi_type: match.poiType,
          address: match.address,
          poi_district: match.poiDistrict ?? null,
          score: match.score,
          keyword: match.keyword,
          fetched_at: new Date().toISOString(),
        });
        const result = await client.query(
          `UPDATE communities
           SET lng = CASE WHEN lng IS NULL THEN $1 ELSE lng END,
               lat = CASE WHEN lat IS NULL THEN $2 ELSE lat END,
               attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{community_location_match}', $3::jsonb, true)
           WHERE id = $4 AND name = $5 AND district = $6 AND (lng IS NULL OR lat IS NULL)`,
          [match.lng, match.lat, evidence, row.id, row.name, row.district],
        );
        updated += result.rowCount ?? 0;
      }
      actions.push({ communityId: row.id, name: row.name, district: row.district, score: match.score, action: apply ? "updated" : "dry-run" });
    }

    writeFileSync(paths.report, JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceReport: path.resolve(sourceReport!), provider, minScore, eligible: eligible.length, updated, actions }, null, 2), "utf8");
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", sourceReport: path.resolve(sourceReport!), provider, minScore, candidates: uniqueRecords.length, eligible: eligible.length, planned: actions.filter((action) => action.action === "dry-run").length, updated, skipped: actions.filter((action) => action.action === "skip").length, report: paths.report }, null, 2));
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
