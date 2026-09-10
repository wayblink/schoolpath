/**
 * Incrementally backfill missing school address/lat/lng via Baidu Maps in a real browser.
 *
 * This is a fallback for cases where official map REST keys are quota-limited or not enabled.
 *
 * Safety rules:
 * - no truncate/delete/seed
 * - exports a JSON snapshot of target rows before any write
 * - default mode is dry-run; pass --apply to update
 * - only fills blank/null fields; existing nonblank address/coords are not overwritten
 * - UPDATE is guarded by id + name + district
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Page, type Response } from "playwright";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const apply = process.argv.includes("--apply");
const headed = process.argv.includes("--headed");
const district = valueArg("--district");
const limit = numberArg("--limit");
const schoolId = numberArg("--school-id");
const minScore = numberArg("--min-score") ?? 70;
const skipIds = parseIdList(valueArg("--skip-ids"));

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  address: string | null;
  lat: number | null;
  lng: number | null;
};

type BaiduContent = {
  uid?: string;
  name?: string;
  addr?: string;
  di_tag?: string;
  area_name?: string;
  admin_info?: {
    area_name?: string;
    city_name?: string;
  };
  diPointX?: number;
  diPointY?: number;
};

type BaiduSearchResp = {
  content?: BaiduContent[] | unknown[][];
  result?: {
    anti_session?: { need_recaptcha?: boolean };
  };
};

type Match = {
  provider: "baidu_browser";
  uid: string;
  poiName: string;
  poiType: string;
  address: string;
  lat: number;
  lng: number;
  bd09Lat: number;
  bd09Lng: number;
  score: number;
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

function parseIdList(raw: string | undefined) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
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

function normalizeAddress(value: string | null | undefined) {
  return (value ?? "")
    .replace(/[\s　]+/g, "")
    .replace(/[（）()].*?[（）()]/g, "")
    .replace(/^上海市/, "")
    .replace(/^[^区]+区/, "")
    .trim();
}

function scorePoi(school: SchoolRow, poi: BaiduContent) {
  const poiName = poi.name?.trim() ?? "";
  const address = poi.addr?.trim() ?? "";
  const areaName = poi.admin_info?.area_name ?? poi.area_name ?? "";
  const tag = poi.di_tag ?? "";

  if (!poiName) return -100;

  const poiText = `${poiName}${tag}`;
  const looksLikeK12School = /学校|小学|中学|九年一贯/.test(poiText);
  const looksLikeSchool = looksLikeK12School || /教育/.test(poiText);
  if (/幼儿园|驾校/.test(poiText)) return -40;
  if (!looksLikeK12School && /大学|学院/.test(poiText)) return -40;
  if (!looksLikeSchool && /培训/.test(poiText)) return -40;
  if (/停车场|公交站|地铁站/.test(poiText)) return -60;

  const schoolName = normalizeSchoolName(school.name);
  const normalizedPoi = normalizeSchoolName(poiName);
  const schoolAddress = normalizeAddress(school.address);
  const poiAddress = normalizeAddress(address);
  const exactNameHit = poiName === school.name;
  const nameContainsHit = poiName.includes(school.name) || school.name.includes(poiName);
  const normalizedNameHit = Boolean(
    schoolName && normalizedPoi && (normalizedPoi.includes(schoolName) || schoolName.includes(normalizedPoi)),
  );
  const strongNameHit = exactNameHit || nameContainsHit || normalizedNameHit;
  const entrancePoi = /出入口|[东南西北]门|门卫/.test(poiText);
  if (entrancePoi && !strongNameHit) return -60;

  const districtHit = areaName.includes(school.district) || address.includes(school.district);
  let score = 0;
  if (districtHit) score += 25;
  else score -= 45;

  if (looksLikeSchool) score += 20;
  else score -= 20;

  if (exactNameHit) score += 110;
  if (nameContainsHit) score += 80;
  if (normalizedNameHit) score += 70;
  if (entrancePoi) score -= 35;

  if (schoolAddress && poiAddress && (poiAddress.includes(schoolAddress) || schoolAddress.includes(poiAddress))) {
    score += 80;
  } else if (schoolAddress && poiAddress) {
    if (!strongNameHit) return -80;
    score -= 20;
  }

  const schoolChars = new Set(schoolName);
  for (const char of new Set(normalizedPoi)) {
    if (schoolChars.has(char)) score += 1;
  }

  if (school.type === "primary" && /小学/.test(poiName)) score += 10;
  if (school.type === "middle" && /中学|初级中学|初中/.test(poiName)) score += 10;

  return score;
}

function normalizeBaiduContent(data: BaiduSearchResp): BaiduContent[] {
  if (!Array.isArray(data.content)) return [];
  return data.content.filter((item): item is BaiduContent => Boolean(item && !Array.isArray(item)));
}

function isBaiduSearchResponse(response: Response) {
  if (response.status() !== 200) return false;
  const url = new URL(response.url());
  if (url.hostname !== "map.baidu.com") return false;
  return url.searchParams.get("qt") === "s";
}

async function waitForSearchResponse(page: Page, keyword: string) {
  const responsePromise = page.waitForResponse(
    (response: Response) => isBaiduSearchResponse(response),
    { timeout: 15000 },
  );

  const input = page.locator("#sole-input");
  await input.click();
  await input.fill(keyword);
  await page.keyboard.press("Enter");

  const response = await responsePromise;
  return (await response.json()) as BaiduSearchResp;
}

async function searchBaidu(page: Page, school: SchoolRow): Promise<Match | null> {
  const compactName = school.name.replace(/\s+/g, "");
  const keywords = compactName.startsWith("上海市")
    ? [compactName, school.name, `${school.name} ${school.address ?? ""}`.trim()]
    : [`上海市${school.district}区${compactName}`, `上海市${school.district}${compactName}`, compactName];
  const ranked: Array<{ poi: BaiduContent; score: number }> = [];

  for (const keyword of new Set(keywords)) {
    const data = await waitForSearchResponse(page, keyword);
    if (data.result?.anti_session?.need_recaptcha) {
      throw new Error("Baidu Maps requested recaptcha; rerun with --headed or slow down the batch.");
    }

    for (const poi of normalizeBaiduContent(data)) {
      if (!Number.isFinite(poi.diPointX) || !Number.isFinite(poi.diPointY)) continue;
      ranked.push({ poi, score: scorePoi(school, poi) });
    }

    await sleep(500);
  }

  ranked.sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) {
    console.log(`NO_CANDIDATES id=${school.id} ${school.district} ${school.name}`);
    return null;
  }
  if (best.score < minScore) {
    console.log(
      `LOW_SCORE id=${school.id} ${school.district} ${school.name} -> ${best.poi.name ?? ""} | ${best.poi.addr ?? ""} | score=${best.score}`,
    );
    return null;
  }

  const bd09 = baiduMercatorToBd09(best.poi.diPointX! / 100, best.poi.diPointY! / 100);
  const gcj = bd09ToGcj02(bd09.lng, bd09.lat);
  return {
    provider: "baidu_browser",
    uid: best.poi.uid ?? "",
    poiName: best.poi.name ?? "",
    poiType: best.poi.di_tag ?? "",
    address: best.poi.addr ?? "",
    lat: gcj.lat,
    lng: gcj.lng,
    bd09Lat: bd09.lat,
    bd09Lng: bd09.lng,
    score: best.score,
  };
}

const MCBAND = [12890594.86, 8362377.87, 5591021, 3481989.83, 1678043.12, 0];
const MC2LL = [
  [1.410526172116255e-8, 0.00000898305509648872, -1.9939833816331, 200.9824383106796, -187.2403703815547, 91.6087516669843, -23.38765649603339, 2.57121317296198, -0.03801003308653, 17337981.2],
  [-7.435856389565537e-9, 0.000008983055097726239, -0.78625201886289, 96.32687599759846, -1.85204757529826, -59.36935905485877, 47.40033549296737, -16.50741931063887, 2.28786674699375, 10260144.86],
  [-3.030883460898826e-8, 0.00000898305509983578, 0.30071316287616, 59.74293618442277, 7.357984074871, -25.38371002664745, 13.45380521110908, -3.29883767235584, 0.32710905363475, 6856817.37],
  [-1.981981304930552e-8, 0.000008983055099779535, 0.03278182852591, 40.31678527705744, 0.65659298677277, -4.44255534477492, 0.85341911805263, 0.12923347998204, -0.04625736007561, 4482777.06],
  [3.09191371068437e-9, 0.000008983055096812155, 0.00006995724062, 23.10934304144901, -0.00023663490511, -0.6321817810242, -0.00663494467273, 0.03430082397953, -0.00466043876332, 2555164.4],
  [2.890871144776878e-9, 0.000008983055095805407, -3.068298e-8, 7.47137025468032, -0.00000353937994, -0.02145144861037, -0.00001234426596, 0.00010322952773, -0.00000323890364, 826088.5],
] as const;

function baiduMercatorToBd09(x: number, y: number) {
  const absY = Math.abs(y);
  const factor = MC2LL[MCBAND.findIndex((band) => absY >= band)] ?? MC2LL[MC2LL.length - 1];
  const lng = factor[0] + factor[1] * Math.abs(x);
  const c = Math.abs(y) / factor[9];
  const lat =
    factor[2] +
    factor[3] * c +
    factor[4] * c ** 2 +
    factor[5] * c ** 3 +
    factor[6] * c ** 4 +
    factor[7] * c ** 5 +
    factor[8] * c ** 6;
  return { lng: x < 0 ? -lng : lng, lat: y < 0 ? -lat : lat };
}

function bd09ToGcj02(bdLng: number, bdLat: number) {
  const x = bdLng - 0.0065;
  const y = bdLat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * Math.PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * Math.PI);
  return { lng: z * Math.cos(theta), lat: z * Math.sin(theta) };
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-location-baidu-browser", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    stamp,
    snapshot: path.join(dir, "target-schools-before.json"),
    matches: path.join(dir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: DESKTOP_CHROME_UA,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    extraHTTPHeaders: {
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Upgrade-Insecure-Requests": "1",
      Referer: "https://map.baidu.com/",
    },
  });
  const page = await context.newPage();

  try {
    await page.goto("https://map.baidu.com/", { waitUntil: "domcontentloaded" });
    await page.locator("#sole-input").waitFor({ timeout: 20000 });
    await sleep(3000);

    const params: Array<string | number | number[]> = [];
    const where: string[] = ["(address IS NULL OR btrim(address) = '' OR lat IS NULL OR lng IS NULL)"];
    if (district) {
      params.push(district);
      where.push(`district = $${params.length}`);
    }
    if (schoolId) {
      params.push(schoolId);
      where.push(`id = $${params.length}`);
    }
    if (skipIds.length > 0) {
      params.push(skipIds);
      where.push(`NOT (id = ANY($${params.length}::int[]))`);
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

    const paths = outputPaths();
    writeFileSync(paths.snapshot, JSON.stringify(target.rows, null, 2), "utf8");
    console.log(`Target schools: ${target.rows.length}${district ? ` (district=${district})` : ""}`);
    console.log(`Snapshot: ${paths.snapshot}`);
    console.log(`Mode: ${apply ? "apply" : "dry-run"}, minScore=${minScore}, headed=${headed}`);

    const records: Array<{ school: SchoolRow; match: Match | null; action: string; error?: string }> = [];
    const attemptedIds: number[] = [];
    let matched = 0;
    let updated = 0;

    await client.query("BEGIN");
    for (const school of target.rows) {
      attemptedIds.push(school.id);
      if (/^(学校名称|初中学区|小学学区|公办\s*[（(])/.test(school.name.trim())) {
        console.log(`SKIP invalid placeholder id=${school.id} ${school.district} ${school.name}`);
        records.push({ school, match: null, action: "skip-placeholder-name" });
        continue;
      }

      let match: Match | null = null;
      try {
        match = await searchBaidu(page, school);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(`ERROR id=${school.id} ${school.district} ${school.name}: ${message}`);
        records.push({ school, match: null, action: "error", error: message });
        break;
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
                '{baidu_browser_school_location_match}',
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
              provider: match.provider,
              uid: match.uid,
              poi_name: match.poiName,
              poi_type: match.poiType,
              address: match.address,
              score: match.score,
              source: "baidu_map_browser_search",
              coordinate_source: "baidu_diPoint_bd09mc_converted_to_gcj02",
              bd09: { lat: match.bd09Lat, lng: match.bd09Lng },
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
      await sleep(1000);
    }

    writeFileSync(paths.matches, JSON.stringify(records, null, 2), "utf8");

    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(`Matches: ${paths.matches}`);
    console.log(`Attempted school ids: ${attemptedIds.join(",") || "none"}`);
    console.log(`Done. matched=${matched}, updated=${updated}, apply=${apply}`);
    console.log("No deletes, resets, seeds, or coordinate overwrites were performed.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await browser.close().catch(() => undefined);
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
