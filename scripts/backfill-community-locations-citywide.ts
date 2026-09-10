/**
 * Incrementally backfill missing community lng/lat/map fields from AMap or Tencent POI search.
 *
 * Safety rules:
 * - no truncate/delete/seed
 * - exports a JSON snapshot of target rows before any write
 * - default mode is dry-run; pass --apply to update
 * - supports --district=<name>, --after-id=<n>, --limit=<n>, --min-score=<n>, --delay-ms=<n>
 * - only fills blank/null fields; existing coords/address/POI fields are not overwritten
 * - UPDATE is guarded by id + name + district and missing fields
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const amapKeys = [
  process.env.AMAP_REST_KEY_2,
  process.env.AMAP_REST_KEY,
  process.env.NEXT_PUBLIC_AMAP_KEY,
].filter((key): key is string => Boolean(key));
const tencentKey = process.env.TENCENT_MAP_KEY;
let currentKeyIdx = 0;
const requestedProvider = valueArg("--provider") ?? process.env.MAP_PROVIDER;
if (requestedProvider && requestedProvider !== "amap" && requestedProvider !== "tencent") {
  throw new Error(`--provider must be amap or tencent (received ${requestedProvider}).`);
}
const provider: "amap" | "tencent" =
  requestedProvider === "amap" || (!requestedProvider && !tencentKey && amapKeys.length > 0) ? "amap" : "tencent";
const apply = process.argv.includes("--apply");
const missingCoordinatesOnly = process.argv.includes("--missing-coordinates-only");
const district = valueArg("--district");
const afterId = nonNegativeIntegerArg("--after-id") ?? 0;
const limit = numberArg("--limit");
const minScore = numberArg("--min-score") ?? 45;
const delayMs = nonNegativeIntegerArg("--delay-ms") ?? 600;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (provider === "amap" && amapKeys.length === 0) throw new Error("amap provider requires AMAP_REST_KEY/_2 or NEXT_PUBLIC_AMAP_KEY.");
if (provider === "tencent" && !tencentKey) throw new Error("tencent provider requires TENCENT_MAP_KEY.");
console.log(`[community-geocode] provider=${provider}; amap keys=${amapKeys.length}; tencent=${tencentKey ? "yes" : "no"}; missing-coordinates-only=${missingCoordinatesOnly}`);

type CommunityRow = {
  id: number;
  name: string;
  district: string;
  lng: number | null;
  lat: number | null;
  amap_poi_id: string | null;
  amap_type_code: string | null;
  amap_type_name: string | null;
  amap_address: string | null;
  source_committee: string | null;
};

type AmapPoi = {
  id?: string;
  name: string;
  location: string;
  address: string | unknown[];
  pname: string;
  cityname: string;
  adname: string;
  type: string;
  typecode?: string;
};

type AmapResp = {
  status: string;
  info: string;
  infocode?: string;
  pois?: AmapPoi[];
};

type TencentPoi = {
  id: string;
  title: string;
  address: string;
  category?: string;
  location: { lat: number; lng: number };
  ad_info?: { district?: string };
};

type TencentResp = {
  status: number;
  message: string;
  data?: TencentPoi[];
};

type Match = {
  poiId: string;
  poiName: string;
  poiType: string;
  poiTypeCode: string;
  address: string;
  poiDistrict: string;
  lat: number;
  lng: number;
  score: number;
  keyword: string;
};

class AmapQuotaError extends Error {}

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

function nonNegativeIntegerArg(name: string) {
  const raw = valueArg(name);
  if (raw == null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name.slice(2)} must be a non-negative integer.`);
  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value: string) {
  return value
    .replace(/[\s　]+/g, "")
    .replace(/[（）()]/g, "")
    .replace(/上海市/g, "")
    .replace(/市辖区/g, "")
    .replace(/区/g, "")
    .replace(/居委会|居民委员会|居委|社区/g, "")
    .replace(/小区|公寓|花园|家园|新村|苑|园|庭|邸|城|名邸|雅苑/g, "")
    .trim();
}

function normalizeAddress(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return "";
  if (value == null) return "";
  return String(value).trim();
}

function shanghaiInRange(lng: number, lat: number) {
  return lng >= 120.85 && lng <= 122.15 && lat >= 30.65 && lat <= 31.9;
}

function scorePoi(community: CommunityRow, poi: AmapPoi) {
  if (poi.cityname !== "上海市") return -200;

  const [lng, lat] = poi.location.split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !shanghaiInRange(lng, lat)) return -200;

  let score = 0;
  const communityName = normalize(community.name);
  const poiName = normalize(poi.name);
  const districtHit = poi.adname?.includes(community.district) ?? false;
  const text = `${poi.name}${poi.type}${normalizeAddress(poi.address)}`;

  // Civic service facilities and police/community offices are not residential POIs.
  if (/党群服务站|居委会|居民委员会|警务室|社区服务中心|工作站|服务站|消防|退役军人/.test(text)) return -200;

  if (districtHit) score += 30;
  else score -= 45;

  if (/住宅区|住宅小区|商务住宅|楼宇|小区|公寓|花园|家园|新村|苑|园|庭|邸|城/.test(text)) score += 25;
  if (/学校|幼儿园|医院|公司|政府|派出所|银行|酒店|商场/.test(text)) score -= 35;

  if (poi.name === community.name) score += 120;
  if (poi.name.includes(community.name) || community.name.includes(poi.name)) score += 80;
  if (communityName && poiName && (poiName.includes(communityName) || communityName.includes(poiName))) score += 70;

  const chars = new Set(communityName);
  for (const char of new Set(poiName)) {
    if (chars.has(char)) score += 1;
  }

  const committee = community.source_committee ? normalize(community.source_committee) : "";
  if (committee && poiName.includes(committee)) score += 12;

  return score;
}

function keywordsFor(community: CommunityRow) {
  const names = [
    community.name,
    `上海市${community.district}区${community.name}`,
    community.source_committee ? `${community.name} ${community.source_committee}` : "",
  ];
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

async function amapSearch(community: CommunityRow): Promise<Match | null> {
  const ranked: Array<{ poi: AmapPoi; score: number; keyword: string }> = [];
  for (const keyword of keywordsFor(community)) {
    let pois: AmapPoi[];
    if (provider === "tencent") {
      const url = new URL("https://apis.map.qq.com/ws/place/v1/search");
      url.searchParams.set("key", tencentKey!);
      url.searchParams.set("keyword", keyword);
      url.searchParams.set("boundary", "region(上海,1)");
      url.searchParams.set("page_size", "10");
      url.searchParams.set("page_index", "1");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as TencentResp;
      if (data.status !== 0) {
        if (data.status === 121) throw new AmapQuotaError(`Tencent daily query limit: ${data.message} (status=${data.status})`);
        throw new Error(`Tencent place/search failed: ${data.message} (status=${data.status})`);
      }
      pois = (data.data ?? []).map((poi) => ({
        id: poi.id,
        name: poi.title,
        location: `${poi.location.lng},${poi.location.lat}`,
        address: poi.address,
        pname: "上海市",
        cityname: "上海市",
        adname: poi.ad_info?.district ?? "",
        type: poi.category ?? "",
      }));
    } else {
      const url = new URL("https://restapi.amap.com/v3/place/text");
      url.searchParams.set("key", amapKeys[currentKeyIdx]);
      url.searchParams.set("keywords", keyword);
      url.searchParams.set("city", "上海");
      url.searchParams.set("citylimit", "true");
      url.searchParams.set("offset", "10");
      url.searchParams.set("page", "1");
      url.searchParams.set("extensions", "base");

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const data = (await res.json()) as AmapResp;
      if (data.status !== "1") {
        if (data.infocode === "20000" || data.info.includes("INVALID_PARAMS")) {
          console.warn(`[community-geocode] skipping invalid search keyword for id=${community.id}: ${keyword}`);
          await sleep(delayMs);
          continue;
        }
        if (
          data.infocode === "10044" ||
          data.infocode === "10021" ||
          data.info.includes("DAILY_QUERY_OVER_LIMIT") ||
          data.info.includes("CUQPS_HAS_EXCEEDED_THE_LIMIT")
        ) {
          console.warn(`[community-geocode] key #${currentKeyIdx + 1} quota/qps exhausted: ${data.info}; trying next key`);
          currentKeyIdx += 1;
          if (currentKeyIdx >= amapKeys.length) {
            throw new AmapQuotaError(`all ${amapKeys.length} AMap keys are quota exhausted`);
          }
          continue;
        }
        if (data.infocode === "10009" || data.info.includes("USERKEY_PLAT_NOMATCH")) {
          throw new Error(`AMap Web 服务 key 未开启或平台不匹配: ${data.info} (code=${data.infocode})`);
        }
        throw new Error(`AMap place/text failed: ${data.info} (code=${data.infocode ?? "unknown"})`);
      }
      pois = data.pois ?? [];
    }

    for (const poi of pois) {
      if (typeof poi.location !== "string" || !poi.location.includes(",")) continue;
      ranked.push({ poi, score: scorePoi(community, poi), keyword });
    }

    await sleep(delayMs);
  }

  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < minScore) return null;

  const [lng, lat] = best.poi.location.split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  return {
    poiId: best.poi.id ?? "",
    poiName: best.poi.name,
    poiType: best.poi.type,
    poiTypeCode: best.poi.typecode ?? "",
    address: normalizeAddress(best.poi.address) || best.poi.name,
    poiDistrict: best.poi.adname,
    lat,
    lng,
    score: best.score,
    keyword: best.keyword,
  };
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "community-location-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    snapshot: path.join(dir, "target-communities-before.json"),
    matches: path.join(dir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const params: Array<string | number> = [];
    const where: string[] = [missingCoordinatesOnly || provider === "tencent"
      ? "(lng IS NULL OR lat IS NULL)"
      : "(lng IS NULL OR lat IS NULL OR amap_address IS NULL OR btrim(amap_address) = '' OR amap_poi_id IS NULL OR btrim(amap_poi_id) = '')"];

    if (district) {
      params.push(district);
      where.push(`district = $${params.length}`);
    }

    if (afterId > 0) {
      params.push(afterId);
      where.push(`id > $${params.length}`);
    }

    let limitSql = "";
    if (limit) {
      params.push(limit);
      limitSql = `LIMIT $${params.length}`;
    }

    const target = await client.query<CommunityRow>(
      `
        SELECT id, name, district, lng, lat, amap_poi_id, amap_type_code, amap_type_name, amap_address, source_committee
        FROM communities
        WHERE ${where.join(" AND ")}
        ORDER BY CASE WHEN lng IS NULL OR lat IS NULL THEN 0 ELSE 1 END, district, id
        ${limitSql}
      `,
      params,
    );

    const paths = outputPaths();
    writeFileSync(paths.snapshot, JSON.stringify(target.rows, null, 2), "utf8");
    console.log(`Target communities: ${target.rows.length}${district ? ` (district=${district})` : ""}${afterId ? ` (after-id=${afterId})` : ""}`);
    console.log(`Snapshot: ${paths.snapshot}`);
    console.log(`Mode: ${apply ? "apply" : "dry-run"}, minScore=${minScore}, delayMs=${delayMs}`);

    const records: Array<{ community: CommunityRow; match: Match | null; action: string }> = [];
    let matched = 0;
    let updated = 0;

    await client.query("BEGIN");
    for (const community of target.rows) {
      let match: Match | null = null;
      try {
        match = await amapSearch(community);
      } catch (error) {
        if (error instanceof AmapQuotaError) {
          console.log(`STOP ${error.message}`);
          records.push({ community, match: null, action: "stop-amap-quota" });
          break;
        }
        throw error;
      }

      if (!match) {
        console.log(`MISS id=${community.id} ${community.district} ${community.name}`);
        records.push({ community, match: null, action: "miss" });
        continue;
      }

      matched++;
      console.log(
        `${apply ? "UPDATE" : "DRY"} id=${community.id} ${community.district} ${community.name} -> ${match.poiName} | ${match.address} | ${match.lat},${match.lng} | score=${match.score}`,
      );

      if (apply) {
        const result = await client.query(
          `
            UPDATE communities
            SET
              lng = CASE WHEN lng IS NULL THEN $1 ELSE lng END,
              lat = CASE WHEN lat IS NULL THEN $2 ELSE lat END,
              amap_poi_id = CASE WHEN $13::text = 'amap' AND (amap_poi_id IS NULL OR btrim(amap_poi_id) = '') THEN $3 ELSE amap_poi_id END,
              amap_type_code = CASE WHEN $13::text = 'amap' AND (amap_type_code IS NULL OR btrim(amap_type_code) = '') THEN $4 ELSE amap_type_code END,
              amap_type_name = CASE WHEN $13::text = 'amap' AND (amap_type_name IS NULL OR btrim(amap_type_name) = '') THEN $5 ELSE amap_type_name END,
              amap_address = CASE WHEN $13::text = 'amap' AND (amap_address IS NULL OR btrim(amap_address) = '') THEN $6 ELSE amap_address END,
              source_query = CASE WHEN source_query IS NULL OR btrim(source_query) = '' THEN $7 ELSE source_query END,
              source_url = CASE WHEN source_url IS NULL OR btrim(source_url) = '' THEN $8 ELSE source_url END,
              attrs = jsonb_set(
                coalesce(attrs, '{}'::jsonb),
                '{community_location_match}',
                $9::jsonb,
                true
              )
            WHERE id = $10
              AND name = $11
              AND district = $12
              AND (
                lng IS NULL
                OR lat IS NULL
                OR ($13::text = 'amap' AND (
                  amap_address IS NULL
                  OR btrim(amap_address) = ''
                  OR amap_poi_id IS NULL
                  OR btrim(amap_poi_id) = ''
                ))
              )
          `,
          [
            match.lng,
            match.lat,
            match.poiId,
            match.poiTypeCode,
            match.poiType,
            match.address,
            match.keyword,
            provider === "amap" && match.poiId ? `https://www.amap.com/place/${match.poiId}` : null,
            JSON.stringify({
              poi_id: match.poiId,
              poi_name: match.poiName,
              poi_type: match.poiType,
              poi_type_code: match.poiTypeCode,
              score: match.score,
              keyword: match.keyword,
              provider,
              source: provider === "amap" ? "amap_place_text" : "tencent_place_search",
              fetched_at: new Date().toISOString(),
            }),
            community.id,
            community.name,
            community.district,
            provider,
          ],
        );
        updated += result.rowCount ?? 0;
      }

      records.push({ community, match, action: apply ? "updated-if-still-missing" : "dry-run" });
    }

    writeFileSync(paths.matches, JSON.stringify(records, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(`Matches: ${paths.matches}`);
    console.log(`Done. matched=${matched}, updated=${updated}, apply=${apply}`);
    console.log("No deletes, resets, seeds, or coordinate overwrites were performed.");
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
