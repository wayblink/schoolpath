/**
 * Fill missing school coordinates from an exact AMap address geocode.
 *
 * This is intentionally narrower than POI search: the database address is
 * the query anchor, and a result is accepted only when its formatted address
 * contains the same district, road token, and house number. Dry-run is the
 * default; pass --apply to commit guarded updates.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const amapKeys = [process.env.AMAP_REST_KEY_2, process.env.AMAP_REST_KEY, process.env.NEXT_PUBLIC_AMAP_KEY].filter(
  (value): value is string => Boolean(value),
);
const apply = process.argv.includes("--apply");
const limit = numberArg("--limit");
const schoolId = numberArg("--school-id");
const district = valueArg("--district");
const sourceKeyPrefix = valueArg("--source-key-prefix");
const minScore = numberArg("--min-score") ?? 100;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (amapKeys.length === 0) throw new Error("AMap REST key is required.");

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  address: string;
  lat: number | null;
  lng: number | null;
};

type Geocode = {
  formatted_address?: string;
  province?: string;
  city?: string | string[];
  district?: string;
  township?: string;
  street?: string;
  number?: string;
  location?: string;
};

type AmapResponse = { status: string; info: string; infocode?: string; geocodes?: Geocode[] };

export type AddressMatch = {
  formattedAddress: string;
  lat: number;
  lng: number;
  score: number;
  query: string;
};

function valueArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1).trim();
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1]?.trim() : undefined;
}

function numberArg(name: string) {
  const raw = valueArg(name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
  return value;
}

function compact(value: unknown) {
  return String(value ?? "").replace(/[\s　,，。．号#-]/g, "").replace(/^上海市/, "");
}

function districtToken(district: string) {
  return district === "浦东" ? "浦东新区" : `${district}区`;
}

function addressTokens(address: string) {
  const value = compact(address);
  const street = value.match(/([^区县市路街道弄巷]+(?:路|街|道|弄|巷))/)?.[1] ?? "";
  const number = value.match(/(\d+(?:号|弄|室)?)/)?.[1] ?? "";
  return { value, street, number };
}

export function scoreAddressMatch(school: Pick<SchoolRow, "district" | "address">, geocode: Geocode) {
  const formatted = geocode.formatted_address?.trim() ?? "";
  const location = geocode.location?.split(",").map(Number) ?? [];
  if (!formatted || location.length !== 2 || !location.every(Number.isFinite)) return -1;
  const text = compact(formatted);
  const districtHit = text.includes(compact(districtToken(school.district)));
  const source = addressTokens(school.address);
  const streetHit = Boolean(source.street && text.includes(compact(source.street)));
  const numberHit = Boolean(source.number && text.includes(compact(source.number)));
  if (!districtHit || !streetHit || !numberHit) return 0;
  let score = 100;
  if (geocode.district && compact(geocode.district).includes(compact(school.district))) score += 20;
  if (geocode.street && source.street && compact(geocode.street).includes(compact(source.street))) score += 20;
  if (geocode.number && source.number && compact(geocode.number).includes(compact(source.number))) score += 20;
  return score;
}

function queryFor(school: Pick<SchoolRow, "district" | "address">) {
  const prefix = school.district === "浦东" ? "上海市浦东新区" : `上海市${school.district}区`;
  return `${prefix}${school.address}`;
}

async function geocodeAddress(school: SchoolRow): Promise<AddressMatch | null> {
  const query = queryFor(school);
  for (let index = 0; index < amapKeys.length; index += 1) {
    const url = new URL("https://restapi.amap.com/v3/geocode/geo");
    url.searchParams.set("key", amapKeys[index]);
    url.searchParams.set("address", query);
    url.searchParams.set("city", "上海");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`AMap HTTP ${response.status}`);
    const data = (await response.json()) as AmapResponse;
    if (data.status !== "1") {
      if (data.infocode === "10009" || data.infocode === "10044" || /LIMIT|OVER_LIMIT|CUQPS|PLAT_NOMATCH/i.test(data.info ?? "")) continue;
      throw new Error(`AMap geocode failed: ${data.info} (${data.infocode ?? "unknown"})`);
    }
    const ranked = (data.geocodes ?? [])
      .map((geocode) => ({ geocode, score: scoreAddressMatch(school, geocode) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score < minScore) return null;
    const [lng, lat] = best.geocode.location!.split(",").map(Number);
    return { formattedAddress: best.geocode.formatted_address!, lat, lng, score: best.score, query };
  }
  throw new Error("All AMap keys are over quota.");
}

function reportDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-address-coordinate-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const dir = reportDir();
  try {
    const params: Array<number | string> = [];
    const where = ["(lat IS NULL OR lng IS NULL)", "NULLIF(btrim(address), '') IS NOT NULL"];
    if (schoolId) {
      params.push(schoolId);
      where.push(`id = $${params.length}`);
    }
    if (district) {
      params.push(district);
      where.push(`district = $${params.length}`);
    }
    if (sourceKeyPrefix) {
      params.push(sourceKeyPrefix);
      where.push(`source_key LIKE $${params.length} || '%'`);
    }
    let limitSql = "";
    if (limit) {
      params.push(limit);
      limitSql = `LIMIT $${params.length}`;
    }
    const target = await client.query<SchoolRow>(
      `SELECT id,name,district,address,lat,lng FROM public.schools WHERE ${where.join(" AND ")} ORDER BY id ${limitSql}`,
      params,
    );
    writeFileSync(path.join(dir, "target-before.json"), JSON.stringify(target.rows, null, 2), "utf8");
    const actions: Array<Record<string, unknown>> = [];
    let updated = 0;
    await client.query("BEGIN");
    for (const school of target.rows) {
      // The farm school address is outside Shanghai and must not be geocoded
      // through the Shanghai endpoint under its administrative source district.
      if (/江苏省|盐城市|大丰区/.test(school.address)) {
        actions.push({ id: school.id, action: "skip-non-shanghai-address", address: school.address });
        continue;
      }
      const match = await geocodeAddress(school);
      if (!match) {
        actions.push({ id: school.id, name: school.name, action: "miss" });
        continue;
      }
      if (apply) {
        const result = await client.query(
          `UPDATE public.schools
              SET lat=$1,lng=$2,
                  attrs=jsonb_set(coalesce(attrs,'{}'::jsonb),'{amap_address_geocode_match}',$3::jsonb,true),
                  updated_at=now()
            WHERE id=$4 AND name=$5 AND district=$6 AND lat IS NULL AND lng IS NULL`,
          [match.lat, match.lng, JSON.stringify({ provider: "amap_geocode", ...match, recorded_at: new Date().toISOString() }), school.id, school.name, school.district],
        );
        updated += result.rowCount ?? 0;
      }
      actions.push({ id: school.id, name: school.name, action: apply ? "updated" : "dry-run", match });
    }
    if (apply) await client.query("COMMIT"); else await client.query("ROLLBACK");
    const report = path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json");
    writeFileSync(report, JSON.stringify({ mode: apply ? "apply" : "dry-run", minScore, targets: target.rows.length, updated, actions }, null, 2), "utf8");
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", targets: target.rows.length, updated, report }, null, 2));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.endsWith("backfill-school-coordinates-from-address.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
