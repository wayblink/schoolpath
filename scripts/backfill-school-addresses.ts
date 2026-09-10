/**
 * Incrementally backfill missing school address/lat/lng from AMap POI search.
 *
 * Safe by design:
 * - no truncate/delete/seed
 * - only updates schools whose address is currently null/blank
 * - wraps DB writes in one transaction
 * - use --dry-run to inspect matched rows without writing
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const amapKey = process.env.AMAP_REST_KEY ?? process.env.NEXT_PUBLIC_AMAP_KEY;
const dryRun = process.argv.includes("--dry-run");
const districtArg = process.argv.find((arg) => arg.startsWith("--district="));
const district = districtArg?.split("=", 2)[1];

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!amapKey) throw new Error("AMAP_REST_KEY or NEXT_PUBLIC_AMAP_KEY is required.");

type SchoolRow = {
  id: number;
  name: string;
  district: string;
};

type AmapResp = {
  status: string;
  info: string;
  infocode?: string;
  pois?: Array<{
    name: string;
    location: string;
    address: string | unknown[];
    pname: string;
    cityname: string;
    adname: string;
    type: string;
  }>;
};

function normalizeText(value: string) {
  return value
    .replace(/[（）()]/g, "")
    .replace(/\s+/g, "")
    .replace(/上海市|市|区|学校|小学|中学|实验|附属/g, "")
    .trim();
}

function scorePoi(school: SchoolRow, poi: NonNullable<AmapResp["pois"]>[number]) {
  if (poi.cityname !== "上海市") return -100;
  if (!poi.adname.includes(school.district)) return -30;
  if (!/学校|小学|中学|教育/.test(`${poi.name}${poi.type}`)) return -10;

  const schoolName = normalizeText(school.name);
  const poiName = normalizeText(poi.name);
  let score = 0;
  if (poi.name === school.name) score += 100;
  if (poi.name.includes(school.name) || school.name.includes(poi.name)) score += 80;
  if (schoolName && poiName && (poiName.includes(schoolName) || schoolName.includes(poiName))) score += 60;

  const schoolChars = new Set(schoolName);
  for (const char of new Set(poiName)) {
    if (schoolChars.has(char)) score += 1;
  }

  if (poi.adname.includes(school.district)) score += 20;
  return score;
}

async function amapSearch(school: SchoolRow) {
  const url = new URL("https://restapi.amap.com/v3/place/text");
  url.searchParams.set("key", amapKey!);
  url.searchParams.set("keywords", school.name);
  url.searchParams.set("city", "上海");
  url.searchParams.set("citylimit", "true");
  url.searchParams.set("offset", "10");
  url.searchParams.set("page", "1");
  url.searchParams.set("extensions", "base");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = (await res.json()) as AmapResp;
  if (data.status !== "1") {
    throw new Error(`AMap place/text failed: ${data.info} (code=${data.infocode ?? "unknown"})`);
  }

  const pois = data.pois ?? [];
  const ranked = pois
    .filter((poi) => typeof poi.location === "string" && poi.location.includes(","))
    .map((poi) => ({ poi, score: scorePoi(school, poi) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 35) return null;

  const [lng, lat] = best.poi.location.split(",").map(Number);
  const addressValue = Array.isArray(best.poi.address) ? "" : best.poi.address;
  return {
    name: best.poi.name,
    address: addressValue || best.poi.name,
    lat,
    lng,
    score: best.score,
  };
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const params: string[] = [];
    let districtSql = "";
    if (district) {
      params.push(district);
      districtSql = `AND district = $${params.length}`;
    }

    const result = await client.query<SchoolRow>(
      `
        SELECT id, name, district
        FROM schools
        WHERE (address IS NULL OR btrim(address) = '')
        ${districtSql}
        ORDER BY district, id
      `,
      params,
    );

    console.log(`Missing school addresses: ${result.rows.length}${district ? ` (district=${district})` : ""}`);
    let matched = 0;
    let updated = 0;

    await client.query("BEGIN");
    for (const school of result.rows) {
      const match = await amapSearch(school);
      if (!match) {
        console.log(`MISS ${school.id} ${school.district} ${school.name}`);
        await new Promise((resolve) => setTimeout(resolve, 120));
        continue;
      }

      matched++;
      console.log(
        `${dryRun ? "DRY" : "UPDATE"} ${school.id} ${school.district} ${school.name} -> ${match.name} | ${match.address} | ${match.lat},${match.lng} | score=${match.score}`,
      );

      if (!dryRun) {
        const update = await client.query(
          `
            UPDATE schools
            SET address = $1, lat = $2, lng = $3, updated_at = now()
            WHERE id = $4
              AND (address IS NULL OR btrim(address) = '')
          `,
          [match.address, match.lat, match.lng, school.id],
        );
        updated += update.rowCount ?? 0;
      }

      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    console.log(`Done. matched=${matched}, updated=${updated}, dryRun=${dryRun}`);
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
