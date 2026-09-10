/**
 * Fill missing public.school coordinates from a one-to-one catalog snapshot.
 *
 * The catalog row is accepted only when its Baidu browser evidence contains an
 * exact school name, a high-confidence score, and a same-district address. The
 * operation is dry-run by default; --apply commits guarded updates and records
 * the evidence in public.schools.attrs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const minScore = Number(valueArg("--min-score") ?? "300");
if (!Number.isFinite(minScore) || minScore < 300) {
  throw new Error("--min-score must be at least 300.");
}

type MatchEvidence = {
  provider?: string;
  poi_name?: string;
  poi_type?: string;
  address?: string;
  score?: number;
  uid?: string;
  coordinate_source?: string;
  fetched_at?: string;
};

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  catalog_id: number;
  catalog_name: string;
  catalog_district: string;
  catalog_address: string | null;
  catalog_lat: number | null;
  catalog_lng: number | null;
  catalog_attrs: Record<string, unknown> | null;
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

function shanghaiInRange(lng: number, lat: number) {
  return lng >= 120.85 && lng <= 122.15 && lat >= 30.65 && lat <= 31.9;
}

export function eligibleCatalogCoordinate(row: SchoolRow, match: MatchEvidence | null) {
  if (row.catalog_name !== row.name || row.catalog_district !== row.district) return false;
  if (row.catalog_lat == null || row.catalog_lng == null) return false;
  if (row.lat != null || row.lng != null) return false;
  if (!match || match.provider !== "baidu_browser") return false;
  if (match.poi_name !== row.name || Number(match.score) < minScore) return false;
  if (!match.address?.includes(districtAddressToken(row.district))) return false;
  return shanghaiInRange(row.catalog_lng, row.catalog_lat);
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "catalog-school-coordinate-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const dir = outputDir();
  const rows = await client.query<SchoolRow>(
    `SELECT s.id, s.name, s.district, s.address, s.lat, s.lng,
            cs.id AS catalog_id, cs.canonical_name AS catalog_name,
            d.canonical_name AS catalog_district, cs.address AS catalog_address,
            cs.lat AS catalog_lat, cs.lng AS catalog_lng, cs.attrs AS catalog_attrs
       FROM public.schools s
       JOIN catalog.schools cs ON cs.legacy_id = s.id
       JOIN catalog.districts d ON d.id = cs.district_id
      WHERE s.lat IS NULL OR s.lng IS NULL
      ORDER BY s.district, s.id`,
  );

  const candidates = rows.rows.filter((row) => {
    const match = (row.catalog_attrs?.baidu_browser_school_location_match as MatchEvidence | undefined) ?? null;
    return eligibleCatalogCoordinate(row, match);
  });
  const snapshot = path.join(dir, "candidates.json");
  writeFileSync(snapshot, JSON.stringify(candidates, null, 2), "utf8");
  let updated = 0;
  const actions: Array<Record<string, unknown>> = [];

  try {
    await client.query("BEGIN");
    for (const row of candidates) {
      const match = row.catalog_attrs!.baidu_browser_school_location_match as MatchEvidence;
      const source = {
        source: "catalog_coordinate_backfill",
        catalog_school_id: row.catalog_id,
        catalog_legacy_id: row.id,
        provider: match.provider,
        poi_uid: match.uid,
        poi_name: match.poi_name,
        poi_type: match.poi_type,
        poi_address: match.address,
        score: match.score,
        coordinate_source: match.coordinate_source,
        catalog_address: row.catalog_address,
        official_source: (row.catalog_attrs?.reviewed_school_correction_source as Record<string, unknown> | undefined)?.source_url ?? null,
        fetched_at: match.fetched_at ?? null,
        recorded_at: new Date().toISOString(),
      };
      if (apply) {
        const result = await client.query(
          `UPDATE public.schools
              SET lat = $1, lng = $2,
                  attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{catalog_coordinate_backfill}', $3::jsonb, true),
                  updated_at = now()
            WHERE id = $4 AND name = $5 AND district = $6
              AND lat IS NULL AND lng IS NULL`,
          [row.catalog_lat, row.catalog_lng, JSON.stringify(source), row.id, row.name, row.district],
        );
        updated += result.rowCount ?? 0;
      }
      actions.push({ id: row.id, name: row.name, district: row.district, lat: row.catalog_lat, lng: row.catalog_lng, action: apply ? "updated" : "dry-run", source });
    }
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  const report = path.join(dir, apply ? "applied-report.json" : "dry-run-report.json");
  writeFileSync(report, JSON.stringify({ mode: apply ? "apply" : "dry-run", minScore, candidates: candidates.length, updated, actions }, null, 2), "utf8");
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", minScore, candidates: candidates.length, updated, report }, null, 2));
}

if (process.argv[1]?.endsWith("backfill-school-coordinates-from-catalog.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
