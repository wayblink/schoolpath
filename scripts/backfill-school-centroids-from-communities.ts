/**
 * Fill missing school lat/lng from already-linked community coordinates.
 *
 * This is not an address backfill. It gives the map a usable school-level
 * center point when official school coordinates are missing, using the median
 * of linked residential community points already in the database.
 *
 * Safety rules:
 * - no truncate/delete/seed
 * - exports target rows before writing
 * - default mode is dry-run; pass --apply to write
 * - supports --district=<name>, --year=<year>, --min-points=<n>
 * - only fills lat/lng when they are null; never overwrites existing coords
 * - UPDATE is guarded by id + name + district
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const apply = process.argv.includes("--apply");
const district = valueArg("--district");
const requestedYear = numberArg("--year");
const minPoints = numberArg("--min-points") ?? 5;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");

type TargetRow = {
  id: number;
  name: string;
  district: string;
  point_count: number;
  lat: number;
  lng: number;
};

type DistrictBounds = {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
};

const DISTRICT_BOUNDS: Record<string, DistrictBounds> = {
  黄浦: { minLat: 31.17, maxLat: 31.27, minLng: 121.45, maxLng: 121.53 },
  徐汇: { minLat: 31.10, maxLat: 31.22, minLng: 121.39, maxLng: 121.48 },
  长宁: { minLat: 31.17, maxLat: 31.25, minLng: 121.33, maxLng: 121.45 },
  静安: { minLat: 31.20, maxLat: 31.34, minLng: 121.40, maxLng: 121.49 },
  虹口: { minLat: 31.23, maxLat: 31.32, minLng: 121.46, maxLng: 121.52 },
  杨浦: { minLat: 31.23, maxLat: 31.34, minLng: 121.48, maxLng: 121.58 },
  普陀: { minLat: 31.22, maxLat: 31.32, minLng: 121.35, maxLng: 121.45 },
  闵行: { minLat: 30.98, maxLat: 31.25, minLng: 121.25, maxLng: 121.56 },
  宝山: { minLat: 31.25, maxLat: 31.52, minLng: 121.32, maxLng: 121.55 },
  嘉定: { minLat: 31.18, maxLat: 31.50, minLng: 121.12, maxLng: 121.36 },
  浦东: { minLat: 30.82, maxLat: 31.40, minLng: 121.45, maxLng: 122.00 },
  金山: { minLat: 30.68, maxLat: 30.95, minLng: 120.95, maxLng: 121.40 },
  松江: { minLat: 30.90, maxLat: 31.20, minLng: 121.00, maxLng: 121.40 },
  青浦: { minLat: 30.95, maxLat: 31.25, minLng: 120.85, maxLng: 121.25 },
  奉贤: { minLat: 30.75, maxLat: 31.10, minLng: 121.35, maxLng: 121.75 },
  崇明: { minLat: 31.25, maxLat: 31.90, minLng: 121.10, maxLng: 122.00 },
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

function isInsideDistrictBounds(row: TargetRow) {
  const bounds = DISTRICT_BOUNDS[row.district];
  if (!bounds) return false;
  return (
    row.lat >= bounds.minLat &&
    row.lat <= bounds.maxLat &&
    row.lng >= bounds.minLng &&
    row.lng <= bounds.maxLng
  );
}

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-centroid-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "target-schools-before.json"),
    applied: path.join(dir, !apply ? "centroids-dry-run.json" : "centroids-applied.json"),
  };
}

async function latestAvailableYear(client: pg.Client) {
  const result = await client.query<{ year: number }>(
    "SELECT coalesce(max(year), extract(year from current_date)::int)::int AS year FROM school_communities",
  );
  return Number(result.rows[0]?.year);
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const year = requestedYear ?? await latestAvailableYear(client);
    if (!Number.isFinite(year)) throw new Error("Could not resolve centroid backfill year.");

    const params: Array<string | number> = [minPoints, year];
    const districtSql = district ? `AND s.district = $${params.push(district)}` : "";
    const result = await client.query<TargetRow>(
      `
        WITH linked_points AS (
          SELECT
            s.id,
            s.name,
            s.district,
            c.lat,
            c.lng
          FROM schools s
          JOIN school_communities sc ON sc.school_id = s.id AND sc.year = $2
          JOIN communities c ON c.id = sc.community_id AND c.district = s.district
          WHERE s.lat IS NULL
            AND s.lng IS NULL
            AND c.lat IS NOT NULL
            AND c.lng IS NOT NULL
            ${districtSql}
        ),
        ranked AS (
          SELECT
            *,
            row_number() OVER (PARTITION BY id ORDER BY lat) AS rn_lat,
            row_number() OVER (PARTITION BY id ORDER BY lng) AS rn_lng,
            count(*) OVER (PARTITION BY id) AS point_count
          FROM linked_points
        )
        SELECT
          id,
          name,
          district,
          max(point_count)::int AS point_count,
          avg(lat) FILTER (WHERE rn_lat IN ((point_count + 1) / 2, (point_count + 2) / 2))::float8 AS lat,
          avg(lng) FILTER (WHERE rn_lng IN ((point_count + 1) / 2, (point_count + 2) / 2))::float8 AS lng
        FROM ranked
        WHERE point_count >= $1
        GROUP BY id, name, district
        ORDER BY district, id
      `,
      params,
    );

    const candidates = result.rows.filter(isInsideDistrictBounds);
    const rejected = result.rows.filter((row) => !isInsideDistrictBounds(row));
    const paths = outputPaths();
    writeFileSync(paths.snapshot, JSON.stringify(result.rows, null, 2), "utf8");
    console.log(`Target schools with linked community centroids: ${result.rows.length}${district ? ` (district=${district})` : ""}`);
    console.log(`Accepted by district bounds: ${candidates.length}, rejected: ${rejected.length}`);
    console.log(`Snapshot: ${paths.snapshot}`);
    console.log(`Mode: ${!apply ? "dry-run" : "apply"}, year=${year}, minPoints=${minPoints}`);

    let updated = 0;
    await client.query("BEGIN");
    for (const row of candidates) {
      console.log(
        `${!apply ? "DRY" : "UPDATE"} id=${row.id} ${row.district} ${row.name} -> ${row.lat},${row.lng} (${row.point_count} points)`,
      );

      if (apply) {
        const update = await client.query(
          `
            UPDATE schools
            SET
              lat = $1,
              lng = $2,
              attrs = jsonb_set(
                coalesce(attrs, '{}'::jsonb),
                '{location_centroid_source}',
                $3::jsonb,
                true
              ),
              updated_at = now()
            WHERE id = $4
              AND name = $5
              AND district = $6
              AND lat IS NULL
              AND lng IS NULL
          `,
          [
            row.lat,
            row.lng,
            JSON.stringify({
              source: "linked_community_median",
              point_count: row.point_count,
              generated_at: new Date().toISOString(),
              year,
              district_bounds_checked: true,
              note: "Map center derived from linked residential communities; not the official school gate coordinate.",
            }),
            row.id,
            row.name,
            row.district,
          ],
        );
        updated += update.rowCount ?? 0;
      }
    }

    writeFileSync(paths.applied, JSON.stringify({ candidates, rejected }, null, 2), "utf8");
    if (!apply) await client.query("ROLLBACK");
    else await client.query("COMMIT");

    console.log(`Output: ${paths.applied}`);
    console.log(`Done. candidates=${candidates.length}, rejected=${rejected.length}, updated=${updated}, dryRun=${!apply}`);
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
