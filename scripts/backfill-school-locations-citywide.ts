/**
 * Incrementally backfill missing school address/lat/lng from AMap POI search.
 *
 * Safety rules:
 * - no truncate/delete/seed
 * - exports a JSON snapshot of target rows before any write
 * - default mode is dry-run; pass --apply to update
 * - supports --provider=<amap|tencent>, --district=<name>, --after-id=<n>,
 *   --limit=<n>, --min-score=<n>, --delay-ms=<n>
 * - only fills blank/null fields; existing nonblank address/coords are not overwritten
 * - UPDATE is guarded by id + name + district
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
].filter((k): k is string => Boolean(k));
const tencentKey = process.env.TENCENT_MAP_KEY;
let currentKeyIdx = 0;
const providerArg = valueArg("--provider");
const cliProvider = providerArg === "amap" || providerArg === "tencent" ? providerArg : undefined;
if (providerArg && !cliProvider) {
  throw new Error("--provider must be amap or tencent.");
}
const provider: "amap" | "tencent" = cliProvider
  ?? (process.env.MAP_PROVIDER === "amap" || (!tencentKey && amapKeys.length > 0) ? "amap" : "tencent");
const apply = process.argv.includes("--apply");
const district = valueArg("--district");
const afterId = nonNegativeIntegerArg("--after-id") ?? 0;
const limit = numberArg("--limit");
const minScore = numberArg("--min-score") ?? 35;
const delayMs = nonNegativeIntegerArg("--delay-ms") ?? 600;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (provider === "amap" && amapKeys.length === 0) throw new Error("amap provider requires AMAP_REST_KEY/_2/NEXT_PUBLIC_AMAP_KEY.");
if (provider === "tencent" && !tencentKey) throw new Error("tencent provider requires TENCENT_MAP_KEY.");
console.log(`[geocode] provider=${provider}; amap keys=${amapKeys.length}; tencent=${tencentKey ? "yes" : "no"}`);

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  address: string | null;
  lat: number | null;
  lng: number | null;
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

type Match = {
  poiId: string;
  poiName: string;
  poiType: string;
  address: string;
  lat: number;
  lng: number;
  score: number;
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
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSchoolName(value: string) {
  return value
    .replace(/[\s　]+/g, "")
    .replace(/[（）()]/g, "")
    .replace(/^上海市/, "")
    .replace(/区/g, "")
    .replace(/学校名称/g, "")
    .replace(/学校|小学|中学|实验|附属|校区|总部|分部|公办|民办/g, "")
    .trim();
}

function normalizeAddress(value: unknown) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return "";
  if (value == null) return "";
  return String(value).trim();
}

function scorePoi(school: SchoolRow, poi: AmapPoi) {
  if (poi.cityname !== "上海市") return -100;

  let score = 0;
  const schoolName = normalizeSchoolName(school.name);
  const poiName = normalizeSchoolName(poi.name);
  const districtHit = poi.adname?.includes(school.district) ?? false;
  const looksLikeSchool = /学校|小学|中学|教育/.test(`${poi.name}${poi.type}`);

  if (districtHit) score += 25;
  else score -= 35;

  if (looksLikeSchool) score += 20;
  else score -= 20;

  if (poi.name === school.name) score += 110;
  if (poi.name.includes(school.name) || school.name.includes(poi.name)) score += 80;
  if (schoolName && poiName && (poiName.includes(schoolName) || schoolName.includes(poiName))) score += 70;

  const schoolChars = new Set(schoolName);
  for (const char of new Set(poiName)) {
    if (schoolChars.has(char)) score += 1;
  }

  if (school.type === "primary" && /小学/.test(poi.name)) score += 10;
  if (school.type === "middle" && /中学|初级中学|初中/.test(poi.name)) score += 10;
  if (/幼儿园|培训|驾校|大学|学院/.test(`${poi.name}${poi.type}`)) score -= 25;

  return score;
}

async function fetchAmap(url: URL): Promise<AmapResp> {
  // 尝试当前 key；遇到 10044 顺序切下一个 key
  while (true) {
    url.searchParams.set("key", amapKeys[currentKeyIdx]);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = (await res.json()) as AmapResp;
    if (data.status === "1") return data;
    if (data.infocode === "10044" || (data.info ?? "").includes("DAILY_QUERY_OVER_LIMIT")) {
      console.warn(`[geocode] key #${currentKeyIdx + 1} 配额满 → 尝试下一个`);
      currentKeyIdx += 1;
      if (currentKeyIdx >= amapKeys.length) {
        throw new AmapQuotaError(`所有 ${amapKeys.length} 个 AMap key 配额都满了`);
      }
      continue;
    }
    throw new Error(`AMap place/text failed: ${data.info} (code=${data.infocode ?? "unknown"})`);
  }
}

// 腾讯 POI 返回 → AmapPoi 形状（兼容下游 scorePoi）
type TencentPoi = {
  id: string;
  title: string;
  address: string;
  category?: string;
  location: { lat: number; lng: number };
  ad_info?: { adcode?: number; district?: string };
};
type TencentResp = { status: number; message: string; count?: number; data?: TencentPoi[] };

async function fetchTencent(keyword: string): Promise<AmapPoi[]> {
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
    if (data.status === 121) {
      throw new AmapQuotaError(`Tencent daily query limit: ${data.message} (status=${data.status})`);
    }
    throw new Error(`Tencent place/search failed: ${data.message} (status=${data.status})`);
  }
  // adapter: 腾讯 → AmapPoi
  return (data.data ?? []).map((p) => ({
    id: p.id,
    name: p.title,
    location: `${p.location.lng},${p.location.lat}`,
    address: p.address,
    pname: "上海市",
    cityname: "上海市",
    adname: p.ad_info?.district ?? "",
    type: p.category ?? "",
  } as AmapPoi));
}

async function amapSearch(school: SchoolRow): Promise<Match | null> {
  const keywords = [school.name.replace(/\s+/g, ""), school.name];
  if (school.address?.trim()) keywords.push(`${school.name} ${school.address}`);

  const ranked: Array<{ poi: AmapPoi; score: number }> = [];
  for (const keyword of new Set(keywords)) {
    let pois: AmapPoi[];
    if (provider === "tencent") {
      pois = await fetchTencent(keyword);
    } else {
      const url = new URL("https://restapi.amap.com/v3/place/text");
      url.searchParams.set("keywords", keyword);
      url.searchParams.set("city", "上海");
      url.searchParams.set("citylimit", "true");
      url.searchParams.set("offset", "10");
      url.searchParams.set("page", "1");
      url.searchParams.set("extensions", "base");

      const data = await fetchAmap(url);
      pois = data.pois ?? [];
    }

    for (const poi of pois) {
      if (typeof poi.location !== "string" || !poi.location.includes(",")) continue;
      ranked.push({ poi, score: scorePoi(school, poi) });
    }

    await sleep(delayMs);
  }

  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best || best.score < minScore) return null;

  const [lng, lat] = best.poi.location.split(",").map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  const address = normalizeAddress(best.poi.address) || best.poi.name;
  return {
    poiId: best.poi.id ?? "",
    poiName: best.poi.name,
    poiType: best.poi.type,
    address,
    lat,
    lng,
    score: best.score,
  };
}

function backupPath() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-location-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    snapshot: path.join(dir, "target-schools-before.json"),
    matches: path.join(dir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const params: Array<string | number> = [];
    const where: string[] = ["(address IS NULL OR btrim(address) = '' OR lat IS NULL OR lng IS NULL)"];

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

    const target = await client.query<SchoolRow>(
      `
        SELECT id, name, district, type, address, lat, lng
        FROM schools
        WHERE ${where.join(" AND ")}
        ORDER BY district, id
        ${limitSql}
      `,
      params,
    );

    const paths = backupPath();
    writeFileSync(paths.snapshot, JSON.stringify(target.rows, null, 2), "utf8");
    console.log(`Target schools: ${target.rows.length}${district ? ` (district=${district})` : ""}${afterId ? ` (after-id=${afterId})` : ""}`);
    console.log(`Snapshot: ${paths.snapshot}`);
    console.log(`Mode: ${apply ? "apply" : "dry-run"}, minScore=${minScore}, delayMs=${delayMs}`);

    const records: Array<{ school: SchoolRow; match: Match | null; action: string }> = [];
    let matched = 0;
    let updated = 0;

    await client.query("BEGIN");
    for (const school of target.rows) {
      if (school.name.trim() === "学校名称") {
        console.log(`SKIP invalid placeholder id=${school.id} ${school.district} ${school.name}`);
        records.push({ school, match: null, action: "skip-placeholder-name" });
        continue;
      }

      let match: Match | null = null;
      try {
        match = await amapSearch(school);
      } catch (error) {
        if (error instanceof AmapQuotaError) {
          console.log(`STOP ${error.message}`);
          records.push({ school, match: null, action: "stop-amap-quota" });
          break;
        }
        throw error;
      }
      if (!match) {
        console.log(`MISS id=${school.id} ${school.district} ${school.name}`);
        records.push({ school, match: null, action: "miss" });
        continue;
      }

      matched++;
      const needsAddress = school.address == null || school.address.trim() === "";
      const needsLat = school.lat == null;
      const needsLng = school.lng == null;
      console.log(
        `${apply ? "UPDATE" : "DRY"} id=${school.id} ${school.district} ${school.name} -> ${match.poiName} | ${match.address} | ${match.lat},${match.lng} | score=${match.score}`,
      );

      if (apply) {
        const update = await client.query(
          `
            UPDATE schools
            SET
              address = CASE WHEN address IS NULL OR btrim(address) = '' THEN $1 ELSE address END,
              lat = CASE WHEN lat IS NULL THEN $2 ELSE lat END,
              lng = CASE WHEN lng IS NULL THEN $3 ELSE lng END,
              attrs = jsonb_set(
                coalesce(attrs, '{}'::jsonb),
                '{amap_school_location_match}',
                $4::jsonb,
                true
              ),
              updated_at = now()
            WHERE id = $5
              AND name = $6
              AND district = $7
              AND (
                address IS NULL
                OR btrim(address) = ''
                OR lat IS NULL
                OR lng IS NULL
              )
          `,
          [
            match.address,
            match.lat,
            match.lng,
            JSON.stringify({
              poi_id: match.poiId,
              poi_name: match.poiName,
              poi_type: match.poiType,
              score: match.score,
              source: "amap_place_text",
              fetched_at: new Date().toISOString(),
              filled: { address: needsAddress, lat: needsLat, lng: needsLng },
            }),
            school.id,
            school.name,
            school.district,
          ],
        );
        updated += update.rowCount ?? 0;
      }

      records.push({ school, match, action: apply ? "updated-if-still-missing" : "dry-run" });
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
