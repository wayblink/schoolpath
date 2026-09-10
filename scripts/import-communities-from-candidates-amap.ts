/**
 * Backfill communities from unmatched official school-community candidates via AMap.
 *
 * Safety rules:
 * - dry-run by default; pass --apply to insert/update
 * - never deletes, truncates, resets, or overwrites non-empty fields
 * - only targets candidates that do not currently match communities.source_committee
 * - writes source snapshots and reports under .tmp before any commit
 * - creates/updates only communities; formal school_communities links are left to
 *   scripts/promote-school-community-candidates.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const amapKey = process.env.AMAP_REST_KEY ?? process.env.NEXT_PUBLIC_AMAP_KEY ?? process.env.AMAP_KEY;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!amapKey) throw new Error("AMAP_REST_KEY or NEXT_PUBLIC_AMAP_KEY is required.");

const apply = process.argv.includes("--apply");
const fillExistingSourceCommittee = process.argv.includes("--fill-existing-source-committee");
const district = valueArg("--district");
const year = Number(valueArg("--year") ?? "2026");
const statuses = listArg("--status", ["pending"]);
const confidences = listArg("--confidence", ["high"]);
const includeBoundaryOnly = process.argv.includes("--include-boundary-only");
const allowContainedSourceCommittee = process.argv.includes("--allow-contained-source-committee");
const maxCandidateCoreLength = Number(valueArg("--max-candidate-core-length") ?? "1");
const radius = Number(valueArg("--radius") ?? "600");
const maxPois = Number(valueArg("--max-pois") ?? "8");
const limitGroups = Number(valueArg("--limit-groups") ?? "0");
const today = new Date().toISOString().slice(0, 10);

if (!district) throw new Error("--district is required.");
const targetDistrict = district;
if (!Number.isInteger(year)) throw new Error("--year must be an integer.");
if (!Number.isInteger(maxCandidateCoreLength) || maxCandidateCoreLength < 0) {
  throw new Error("--max-candidate-core-length must be a non-negative integer.");
}
if (!Number.isInteger(radius) || radius <= 0) throw new Error("--radius must be a positive integer.");
if (!Number.isInteger(maxPois) || maxPois <= 0) throw new Error("--max-pois must be a positive integer.");
if (!Number.isInteger(limitGroups) || limitGroups < 0) throw new Error("--limit-groups must be a non-negative integer.");

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

type AmapResp = {
  status: string;
  info: string;
  infocode?: string;
  tips?: Array<{ name?: string; location?: string | unknown; district?: string; address?: string | unknown }>;
  pois?: AmapPoi[];
  geocodes?: Array<{ location: string; formatted_address: string }>;
};

type AmapPoi = {
  id?: string;
  name: string;
  type?: string;
  typecode?: string;
  address?: string | unknown[];
  location: string;
  adname?: string;
  cityname?: string;
};

type GeoHit = {
  lat: number;
  lng: number;
  address: string;
  via: string;
};

type CandidateGroup = {
  candidateName: string;
  candidateCore: string;
  candidateIds: number[];
  schoolIds: number[];
  schoolNames: string[];
  sourceTitle: string;
  sourceUrl: string | null;
  sourceDate: string | null;
  sourceQuotes: string[];
};

type PlannedAction = {
  group: CandidateGroup;
  poi?: AmapPoi;
  action:
    | "dry-run-insert-community"
    | "insert-community"
    | "dry-run-fill-existing-source-committee"
    | "fill-existing-source-committee"
    | "skip-existing-community"
    | "skip-existing-community-has-source-committee"
    | "skip-invalid-poi"
    | "skip-no-geocode"
    | "skip-no-pois"
    | "skip-amap-error";
  communityId?: number;
  reason?: string;
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
  const dir = path.join(process.cwd(), ".tmp", "candidate-community-amap-import", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    candidatesSnapshot: path.join(dir, "candidates-source.json"),
    communitiesSnapshot: path.join(dir, "communities-source.json"),
    groupsSnapshot: path.join(dir, "unmatched-candidate-groups.json"),
    report: path.join(dir, apply ? "import-applied.json" : "import-dry-run.json"),
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value) || value == null) return "";
  return String(value).trim();
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

function sourceName() {
  return "amap_placesearch_from_school_community_candidates";
}

function candidateMatchesExisting(candidate: CandidateRow, communities: CommunityRow[]) {
  const core = committeeCore(candidateName(candidate));
  if (core.length <= maxCandidateCoreLength) return true;
  return communities.some((community) => {
    if (!community.source_committee) return false;
    const sourceCore = committeeCore(community.source_committee);
    if (!sourceCore) return false;
    return sourceCore === core || (allowContainedSourceCommittee && sourceCore.includes(core));
  });
}

function buildGroups(candidates: CandidateRow[], communities: CommunityRow[]) {
  const groups = new Map<string, CandidateGroup>();
  for (const candidate of candidates) {
    const name = candidateName(candidate);
    const core = committeeCore(name);
    if (core.length <= maxCandidateCoreLength) continue;
    if (candidateMatchesExisting(candidate, communities)) continue;

    const key = core;
    const existing = groups.get(key) ?? {
      candidateName: name,
      candidateCore: core,
      candidateIds: [],
      schoolIds: [],
      schoolNames: [],
      sourceTitle: candidate.source_title,
      sourceUrl: candidate.source_url,
      sourceDate: candidate.source_date,
      sourceQuotes: [],
    };
    existing.candidateIds.push(candidate.id);
    if (candidate.school_id != null && !existing.schoolIds.includes(candidate.school_id)) existing.schoolIds.push(candidate.school_id);
    if (!existing.schoolNames.includes(candidate.school_name_raw)) existing.schoolNames.push(candidate.school_name_raw);
    if (!existing.sourceQuotes.includes(candidate.source_quote)) existing.sourceQuotes.push(candidate.source_quote);
    groups.set(key, existing);
  }
  const result = [...groups.values()].sort((a, b) => a.candidateCore.localeCompare(b.candidateCore, "zh-Hans-CN"));
  return limitGroups > 0 ? result.slice(0, limitGroups) : result;
}

async function callAmap(endpoint: string, params: Record<string, string>): Promise<AmapResp> {
  const url = new URL(`https://restapi.amap.com/v3/${endpoint}`);
  url.searchParams.set("key", amapKey!);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url.toString());
  const data = (await response.json()) as AmapResp;
  if (data.status !== "1") {
    const code = data.infocode ?? "unknown";
    const info = data.info ?? "unknown";
    if (code === "10044" || info.includes("USER_DAILY_QUERY_OVER_LIMIT")) {
      throw new AmapLimitError(`AMap daily query limit reached: ${info} (code=${code})`);
    }
    if (code === "10009" || info.includes("USERKEY_PLAT_NOMATCH")) {
      throw new AmapLimitError("AMap REST API key is not enabled for Web Service platform.");
    }
    throw new Error(`AMap ${endpoint} failed: ${info} (code=${code})`);
  }
  return data;
}

class AmapLimitError extends Error {}

async function geocodeCommittee(group: CandidateGroup): Promise<GeoHit | null> {
  const queries = [
    `${targetDistrict}${group.candidateName}`,
    `${targetDistrict}${group.candidateCore}居委会`,
    `${targetDistrict}${group.candidateCore}居民委员会`,
    `${targetDistrict}${group.candidateCore}社区`,
  ];

  for (const query of queries) {
    const data = await callAmap("assistant/inputtips", {
      keywords: query,
      city: "021",
      citylimit: "true",
      datatype: "poi",
    });
    const tips = data.tips ?? [];
    const valid = tips.filter((tip) => typeof tip.location === "string" && tip.location.length > 0);
    const hit = valid.find((tip) => tip.district?.includes(targetDistrict)) ?? valid[0];
    if (hit && typeof hit.location === "string") {
      const [lng, lat] = hit.location.split(",").map(Number);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        return { lat, lng, address: stringValue(hit.address) || hit.name || "", via: `inputtips:${query}` };
      }
    }
    await sleep(120);
  }

  for (const query of queries) {
    const data = await callAmap("place/text", {
      keywords: query,
      city: "021",
      citylimit: "true",
      offset: "5",
      page: "1",
      extensions: "base",
    });
    const pois = data.pois ?? [];
    const hit = pois.find((poi) => poi.adname?.includes(targetDistrict)) ?? pois[0];
    if (hit?.location) {
      const [lng, lat] = hit.location.split(",").map(Number);
      if (Number.isFinite(lng) && Number.isFinite(lat)) {
        return { lat, lng, address: stringValue(hit.address) || hit.name, via: `place_text:${query}` };
      }
    }
    await sleep(120);
  }

  const data = await callAmap("geocode/geo", {
    address: `上海市${targetDistrict}区${group.candidateName}`,
    city: "上海",
  });
  const geocode = data.geocodes?.[0];
  if (!geocode) return null;
  const [lng, lat] = geocode.location.split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lat, lng, address: geocode.formatted_address, via: "geocode_fallback" };
}

async function searchCommunitiesAround(geo: GeoHit) {
  const data = await callAmap("place/around", {
    location: `${geo.lng},${geo.lat}`,
    radius: String(radius),
    types: "120300|120301|120302|120303",
    offset: "25",
    page: "1",
    extensions: "base",
  });
  return (data.pois ?? [])
    .filter((poi) => poi.typecode?.startsWith("12030"))
    .filter((poi) => poi.adname?.includes(targetDistrict) ?? true)
    .slice(0, maxPois);
}

function validPoi(poi: AmapPoi) {
  if (!poi.name || !poi.location) return false;
  const [lng, lat] = poi.location.split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat);
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

    const groups = buildGroups(candidates.rows, communities.rows);
    writeFileSync(paths.groupsSnapshot, JSON.stringify(groups, null, 2), "utf8");

    const existingByName = new Map(communities.rows.map((row) => [`${row.district}::${normalizeText(row.name)}`, row]));
    const report: PlannedAction[] = [];
    let insertedCommunities = 0;
    let filledExistingSourceCommittees = 0;
    let skippedExistingCommunities = 0;
    let skippedExistingCommunitiesWithSourceCommittee = 0;
    let skippedInvalidPois = 0;
    let skippedNoGeocode = 0;
    let skippedNoPois = 0;
    let skippedAmapErrors = 0;
    let fatalAmapError: string | null = null;

    console.log(`Mode: ${apply ? "apply" : "dry-run"}`);
    console.log(`District: ${district}`);
    console.log(`Year: ${year}`);
    console.log(`Statuses: ${statuses.join(",")}`);
    console.log(`Confidences: ${confidences.join(",")}`);
    console.log(`Include boundary-only: ${includeBoundaryOnly ? "yes" : "no"}`);
    console.log(`Fill existing source_committee when empty: ${fillExistingSourceCommittee ? "yes" : "no"}`);
    console.log(`Candidates: ${candidates.rows.length}`);
    console.log(`Existing ${district} communities: ${communities.rows.length}`);
    console.log(`Unmatched candidate groups: ${groups.length}`);
    console.log(`Radius: ${radius}m`);
    console.log(`Max POIs per group: ${maxPois}`);
    console.log(`Output: ${paths.dir}`);

    await client.query("BEGIN");
    for (const group of groups) {
      let geo: GeoHit | null = null;
      try {
        geo = await geocodeCommittee(group);
      } catch (error) {
        const message = (error as Error).message;
        skippedAmapErrors += 1;
        report.push({ group, action: "skip-amap-error", reason: message });
        if (error instanceof AmapLimitError) {
          fatalAmapError = message;
          break;
        }
        continue;
      }
      if (!geo) {
        skippedNoGeocode += 1;
        report.push({ group, action: "skip-no-geocode" });
        continue;
      }

      let pois: AmapPoi[] = [];
      try {
        pois = await searchCommunitiesAround(geo);
      } catch (error) {
        const message = (error as Error).message;
        skippedAmapErrors += 1;
        report.push({ group, action: "skip-amap-error", reason: message });
        if (error instanceof AmapLimitError) {
          fatalAmapError = message;
          break;
        }
        continue;
      }
      if (pois.length === 0) {
        skippedNoPois += 1;
        report.push({ group, action: "skip-no-pois", reason: `${geo.via} ${geo.address}` });
        continue;
      }

      for (const poi of pois) {
        if (!validPoi(poi)) {
          skippedInvalidPois += 1;
          report.push({ group, poi, action: "skip-invalid-poi" });
          continue;
        }

        const key = `${targetDistrict}::${normalizeText(poi.name)}`;
        const existing = existingByName.get(key);
        const [lng, lat] = poi.location.split(",").map(Number);

        if (existing) {
          if (existing.source_committee?.trim()) {
            skippedExistingCommunitiesWithSourceCommittee += 1;
            report.push({
              group,
              poi,
              action: "skip-existing-community-has-source-committee",
              communityId: existing.id,
            });
            continue;
          }

          if (!fillExistingSourceCommittee) {
            skippedExistingCommunities += 1;
            report.push({ group, poi, action: "skip-existing-community", communityId: existing.id });
            continue;
          }

          if (!apply) {
            report.push({
              group,
              poi,
              action: "dry-run-fill-existing-source-committee",
              communityId: existing.id,
            });
            continue;
          }

          await client.query(
            `
              UPDATE communities
              SET source_committee = $1,
                  source_query = COALESCE(NULLIF(source_query, ''), $2),
                  source_url = COALESCE(NULLIF(source_url, ''), $3),
                  source_name = COALESCE(NULLIF(source_name, ''), $4),
                  source_date = COALESCE(NULLIF(source_date, ''), $5),
                  notes = concat_ws(E'\n', notes, $6::text)
              WHERE id = $7
                AND district = $8
                AND (source_committee IS NULL OR btrim(source_committee) = '')
            `,
            [
              group.candidateName,
              `${targetDistrict} ${group.candidateName} ${geo.via}`,
              poi.id ? `https://www.amap.com/place/${poi.id}` : group.sourceUrl,
              sourceName(),
              today,
              `由 school_community_candidates#${group.candidateIds.join(",")} 反查补 source_committee；需人工抽检。`,
              existing.id,
              targetDistrict,
            ],
          );
          filledExistingSourceCommittees += 1;
          existing.source_committee = group.candidateName;
          report.push({ group, poi, action: "fill-existing-source-committee", communityId: existing.id });
          continue;
        }

        if (!apply) {
          report.push({ group, poi, action: "dry-run-insert-community" });
          continue;
        }

        const inserted = await client.query<{ id: number; name: string; district: string; source_committee: string | null }>(
          `
            INSERT INTO communities (
              name, district, lng, lat, amap_poi_id, amap_type_code, amap_type_name, amap_address,
              source_committee, source_query, source_url, source_name, source_date, verified, notes, attrs
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, $14, $15::jsonb)
            ON CONFLICT (name, district) DO NOTHING
            RETURNING id, name, district, source_committee
          `,
          [
            poi.name,
            targetDistrict,
            lng,
            lat,
            poi.id ?? null,
            poi.typecode ?? null,
            poi.type ?? null,
            stringValue(poi.address),
            group.candidateName,
            `${targetDistrict} ${group.candidateName} ${geo.via}`,
            poi.id ? `https://www.amap.com/place/${poi.id}` : group.sourceUrl,
            sourceName(),
            today,
            "由官方招生候选居委经高德 PlaceSearch 反查得到；未人工核验，可能漏小区或多挂小区。",
            JSON.stringify({
              source_candidate_ids: group.candidateIds,
              source_school_ids: group.schoolIds,
              source_school_names: group.schoolNames,
              source_title: group.sourceTitle,
              source_url: group.sourceUrl,
              source_date: group.sourceDate,
              source_quotes: group.sourceQuotes,
              geocode: geo,
              raw_typecode: poi.typecode ?? null,
              raw_type: poi.type ?? null,
            }),
          ],
        );

        const row = inserted.rows[0];
        if (row) {
          insertedCommunities += 1;
          existingByName.set(key, row);
          report.push({ group, poi, action: "insert-community", communityId: row.id });
        } else {
          skippedExistingCommunities += 1;
          report.push({ group, poi, action: "skip-existing-community" });
        }
      }

      await sleep(180);
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
      fillExistingSourceCommittee,
      radius,
      maxPois,
      candidates: candidates.rows.length,
      existingCommunities: communities.rows.length,
      unmatchedGroups: groups.length,
      dryRunInsertCommunities: report.filter((row) => row.action === "dry-run-insert-community").length,
      dryRunFillExistingSourceCommittees: report.filter((row) => row.action === "dry-run-fill-existing-source-committee").length,
      insertedCommunities,
      filledExistingSourceCommittees,
      skippedExistingCommunities,
      skippedExistingCommunitiesWithSourceCommittee,
      skippedInvalidPois,
      skippedNoGeocode,
      skippedNoPois,
      skippedAmapErrors,
      fatalAmapError,
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
