/**
 * Incrementally backfill missing school address/lat/lng from Baidu's public
 * mobile detail page.
 *
 * The desktop Baidu search endpoint is frequently protected by a captcha. The
 * mobile detail page still exposes a structured `var data = {...}` payload,
 * but this script accepts it only when the POI name is exactly the school name,
 * the address is in the same Shanghai district, and the school stage matches.
 * Dry-run is the default; pass --apply to commit guarded updates.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const apply = process.argv.includes("--apply");
const district = valueArg("--district");
const afterId = nonNegativeIntegerArg("--after-id") ?? 0;
const limit = positiveIntegerArg("--limit");
const delayMs = nonNegativeIntegerArg("--delay-ms") ?? 500;
const FETCH_TIMEOUT_MS = 15_000;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

export type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  address: string | null;
  lat: number | null;
  lng: number | null;
};

export type BaiduMobileDetail = {
  uid: string;
  name: string;
  address: string;
  cityName: string;
  poiType: string;
  diPointX: number;
  diPointY: number;
};

type BaiduSuggestion = {
  raw: string;
  city: string;
  district: string;
  name: string;
  uid: string;
};

export type SchoolLocationMatch = {
  provider: "baidu_mobile";
  uid: string;
  poiName: string;
  poiType: string;
  address: string;
  lat: number;
  lng: number;
  bd09Lat: number;
  bd09Lng: number;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function nonNegativeIntegerArg(name: string) {
  const raw = valueArg(name);
  if (raw == null || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function positiveIntegerArg(name: string) {
  const raw = valueArg(name);
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJsonObject(html: string) {
  const marker = "var data = ";
  const start = html.indexOf(marker);
  if (start < 0) return null;

  let index = start + marker.length;
  while (/\s/.test(html[index] ?? "")) index++;
  if (html[index] !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = index; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}") {
      depth--;
      if (depth === 0) return html.slice(index, i + 1);
    }
  }
  return null;
}

export function extractBaiduMobileDetail(html: string): BaiduMobileDetail | null {
  const raw = extractJsonObject(html);
  if (!raw) return null;

  let parsed: {
    content?: {
      uid?: string;
      name?: string;
      addr?: string;
      city_name?: string;
      std_tag?: string;
      diPointX?: number;
      diPointY?: number;
    };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return null;
  }

  const content = parsed.content;
  const uid = content?.uid?.trim();
  const name = content?.name?.trim();
  const address = content?.addr?.trim();
  const cityName = content?.city_name?.trim();
  const diPointX = Number(content?.diPointX);
  const diPointY = Number(content?.diPointY);
  if (!uid || !name || !address || !cityName || !Number.isFinite(diPointX) || !Number.isFinite(diPointY)) return null;

  return {
    uid,
    name,
    address,
    cityName,
    poiType: content?.std_tag?.trim() ?? "",
    diPointX,
    diPointY,
  };
}

function districtToken(districtName: string) {
  return districtName === "浦东" ? "浦东新区" : `${districtName}区`;
}

function inShanghai(lat: number, lng: number) {
  return lat >= 30.65 && lat <= 31.9 && lng >= 120.85 && lng <= 122.15;
}

function stageMatches(school: SchoolRow, detail: BaiduMobileDetail) {
  const text = `${detail.name}${detail.poiType}`;
  if (school.type === "primary") return /小学/.test(text) && !/中学|初级中学|高中/.test(text);
  if (school.type === "middle") return /中学|初级中学|初中/.test(text) && !/小学部|小学$/.test(text);
  return /学校|小学|中学|初中|初级/.test(text);
}

/** Strict evidence gate used before a mobile POI can be written to schools. */
export function isStrictBaiduMobileSchoolMatch(school: SchoolRow, detail: BaiduMobileDetail) {
  if (detail.name !== school.name) return false;
  if (detail.cityName !== "上海市") return false;
  if (!detail.address.includes(districtToken(school.district))) return false;
  if (!stageMatches(school, detail)) return false;
  const coordinate = baiduMercatorToGcj02(detail.diPointX, detail.diPointY);
  return inShanghai(coordinate.lat, coordinate.lng);
}

const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL = [
  [1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 17337981.2],
  [-7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 10260144.86],
  [-3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6856817.37],
  [-1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4482777.06],
  [3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2555164.4],
  [2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8, 7.47137025468032, -0.00000353937994, -0.02145144808637, -0.00001234426596, 0.00010322952773, -0.00000323890364, 826088.5],
] as const;

function baiduMercatorToBd09(x: number, y: number) {
  const absY = Math.abs(y);
  const factor = MC2LL[MCBAND.findIndex((band) => absY >= band)] ?? MC2LL[MC2LL.length - 1];
  const lng = factor[0] + factor[1] * Math.abs(x);
  const c = Math.abs(y) / factor[9];
  const lat = factor[2] + factor[3] * c + factor[4] * c ** 2 + factor[5] * c ** 3 + factor[6] * c ** 4 + factor[7] * c ** 5 + factor[8] * c ** 6;
  return { lng: x < 0 ? -lng : lng, lat: y < 0 ? -lat : lat };
}

export function baiduMercatorToGcj02(diPointX: number, diPointY: number) {
  const bd09 = baiduMercatorToBd09(diPointX / 100, diPointY / 100);
  const x = bd09.lng - 0.0065;
  const y = bd09.lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * Math.PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * Math.PI);
  return { lng: z * Math.cos(theta), lat: z * Math.sin(theta) };
}

function parseSuggestion(raw: string): BaiduSuggestion | null {
  const parts = raw.split("$");
  const name = parts[3]?.trim();
  const uid = parts[5]?.trim();
  if (!name || !uid) return null;
  return {
    raw,
    city: parts[0]?.trim() ?? "",
    district: (parts[1] || parts[7] || "").trim(),
    name,
    uid,
  };
}

async function fetchText(url: URL | string) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.6",
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchSuggestions(query: string) {
  const url = new URL("https://map.baidu.com/su");
  url.searchParams.set("wd", query);
  url.searchParams.set("cid", "289");
  url.searchParams.set("type", "0");
  url.searchParams.set("newmap", "1");
  url.searchParams.set("pc_ver", "2");
  const payload = JSON.parse(await fetchText(url)) as { s?: string[] };
  return (payload.s ?? []).map(parseSuggestion).filter((item): item is BaiduSuggestion => Boolean(item));
}

async function fetchDetail(uid: string) {
  const url = `https://map.baidu.com/mobile/webapp/place/detail/qt=inf&uid=${encodeURIComponent(uid)}/vt=map`;
  const html = await fetchText(url);
  return extractBaiduMobileDetail(html);
}

async function searchSchool(school: SchoolRow): Promise<SchoolLocationMatch | null> {
  const queries = [
    `上海市${school.district === "浦东" ? "浦东新区" : `${school.district}区`}${school.name}`,
    school.name,
  ];
  const suggestionsByUid = new Map<string, BaiduSuggestion>();
  for (const query of queries) {
    for (const suggestion of (await fetchSuggestions(query)).slice(0, 10)) suggestionsByUid.set(suggestion.uid, suggestion);
    await sleep(Math.min(delayMs, 300));
  }

  for (const suggestion of suggestionsByUid.values()) {
    const detail = await fetchDetail(suggestion.uid);
    if (detail && isStrictBaiduMobileSchoolMatch(school, detail)) {
      const coordinate = baiduMercatorToGcj02(detail.diPointX, detail.diPointY);
      const bd09 = baiduMercatorToBd09(detail.diPointX / 100, detail.diPointY / 100);
      return {
        provider: "baidu_mobile",
        uid: detail.uid,
        poiName: detail.name,
        poiType: detail.poiType,
        address: detail.address,
        lat: coordinate.lat,
        lng: coordinate.lng,
        bd09Lat: bd09.lat,
        bd09Lng: bd09.lng,
      };
    }
    await sleep(delayMs);
  }
  return null;
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-location-baidu-mobile", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "target-schools-before.json"),
    report: path.join(dir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const paths = outputPaths();
  try {
    const params: Array<string | number> = [];
    const where = ["(address IS NULL OR btrim(address) = '' OR lat IS NULL OR lng IS NULL)"];
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
      `SELECT id, name, district, type, address, lat, lng FROM schools WHERE ${where.join(" AND ")} ORDER BY district, id ${limitSql}`,
      params,
    );
    writeFileSync(paths.snapshot, JSON.stringify(target.rows, null, 2), "utf8");
    console.log(`Target schools: ${target.rows.length}${district ? ` (district=${district})` : ""}${afterId ? ` (after-id=${afterId})` : ""}`);
    console.log(`Mode: ${apply ? "apply" : "dry-run"}, delayMs=${delayMs}`);

    const records: Array<{ school: SchoolRow; match: SchoolLocationMatch | null; action: string; error?: string }> = [];
    let updated = 0;
    await client.query("BEGIN");
    for (const school of target.rows) {
      try {
        const match = await searchSchool(school);
        if (!match) {
          records.push({ school, match: null, action: "miss" });
          console.log(`MISS id=${school.id} ${school.district} ${school.name}`);
          continue;
        }
        const needsAddress = !school.address?.trim();
        const needsLat = school.lat == null;
        const needsLng = school.lng == null;
        console.log(`${apply ? "UPDATE" : "DRY"} id=${school.id} ${school.district} ${school.name} -> ${match.poiName} | ${match.address} | ${match.lat},${match.lng}`);
        if (apply) {
          const result = await client.query(
            `UPDATE schools
             SET address = CASE WHEN address IS NULL OR btrim(address) = '' THEN $1 ELSE address END,
                 lat = CASE WHEN lat IS NULL THEN $2 ELSE lat END,
                 lng = CASE WHEN lng IS NULL THEN $3 ELSE lng END,
                 attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{baidu_mobile_school_location_match}', $4::jsonb, true),
                 updated_at = now()
             WHERE id = $5 AND name = $6 AND district = $7
               AND (address IS NULL OR btrim(address) = '' OR lat IS NULL OR lng IS NULL)`,
            [
              match.address,
              match.lat,
              match.lng,
              JSON.stringify({ ...match, source: "baidu_mobile_detail_page", coordinate_source: "baidu_diPoint_bd09mc_converted_to_gcj02", fetched_at: new Date().toISOString(), filled: { address: needsAddress, lat: needsLat, lng: needsLng } }),
              school.id,
              school.name,
              school.district,
            ],
          );
          updated += result.rowCount ?? 0;
        }
        records.push({ school, match, action: apply ? "updated-if-still-missing" : "dry-run" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        records.push({ school, match: null, action: "error", error: message });
        console.log(`ERROR id=${school.id} ${school.district} ${school.name}: ${message}`);
      }
      await sleep(delayMs);
    }
    writeFileSync(paths.report, JSON.stringify({ mode: apply ? "apply" : "dry-run", targetCount: target.rows.length, updated, records }, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", targetCount: target.rows.length, matched: records.filter((record) => record.match).length, updated, report: paths.report }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("backfill-school-locations-baidu-mobile.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
