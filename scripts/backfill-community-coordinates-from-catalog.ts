/**
 * Fill missing public community coordinates from unique catalog name matches.
 *
 * This is deliberately narrower than POI fuzzy matching: both rows must be in
 * the same district and their names must be equal after removing only common
 * residential suffixes. Dry-run is the default; pass --apply to commit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
const apply = process.argv.includes("--apply");
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

type DistrictBounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };
type MatchRow = {
  id: number;
  name: string;
  district: string;
  c_id: number;
  c_name: string;
  c_lat: number;
  c_lng: number;
  c_address: string | null;
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

function normalizedName(value: string) {
  return value
    .replace(/[\s　]/g, "")
    .replace(/[（）()]/g, "")
    .replace(/(小区|社区|花园|公寓)$/g, "")
    .trim();
}

function inDistrictBounds(row: MatchRow) {
  const bounds = DISTRICT_BOUNDS[row.district];
  return Boolean(
    bounds &&
      row.c_lat >= bounds.minLat &&
      row.c_lat <= bounds.maxLat &&
      row.c_lng >= bounds.minLng &&
      row.c_lng <= bounds.maxLng,
  );
}

function outputDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "community-catalog-coordinate-backfill", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const dir = outputDir();
  const matches = (
    await client.query<MatchRow>(
      `
        WITH candidates AS (
          SELECT p.id, p.name, p.district,
                 c.id AS c_id, c.name AS c_name, c.lat AS c_lat, c.lng AS c_lng,
                 c.address AS c_address,
                 row_number() OVER (PARTITION BY p.id ORDER BY c.id) AS rn,
                 count(*) OVER (PARTITION BY p.id) AS match_count
            FROM public.communities p
            JOIN catalog.communities c ON c.name IS NOT NULL
            JOIN catalog.districts d ON d.id = c.district_id AND d.canonical_name = p.district
           WHERE (p.lat IS NULL OR p.lng IS NULL)
             AND c.lat IS NOT NULL AND c.lng IS NOT NULL
             AND regexp_replace(regexp_replace(c.name, '(小区|社区|花园|公寓)$', '', 'g'), '[（）()[:space:]]', '', 'g') =
                 regexp_replace(regexp_replace(p.name, '(小区|社区|花园|公寓)$', '', 'g'), '[（）()[:space:]]', '', 'g')
        )
        SELECT id, name, district, c_id, c_name, c_lat, c_lng, c_address
          FROM candidates
         WHERE rn = 1 AND match_count = 1
         ORDER BY district, id
      `,
    )
  ).rows;
  const accepted = matches.filter(inDistrictBounds);
  const rejected = matches.filter((row) => !inDistrictBounds(row));
  writeFileSync(path.join(dir, "matches-before-apply.json"), JSON.stringify({ matches, accepted, rejected }, null, 2), "utf8");

  let updated = 0;
  try {
    await client.query("BEGIN");
    for (const row of accepted) {
      if (apply) {
        const result = await client.query(
          `
            UPDATE public.communities
               SET lat = $1,
                   lng = $2,
                   amap_address = CASE WHEN NULLIF(btrim(amap_address), '') IS NULL THEN $3 ELSE amap_address END,
                   attrs = jsonb_set(coalesce(attrs, '{}'::jsonb), '{catalog_coordinate_backfill}', $4::jsonb, true)
             WHERE id = $5 AND name = $6 AND district = $7
               AND (lat IS NULL OR lng IS NULL)
          `,
          [
            row.c_lat,
            row.c_lng,
            row.c_address,
            JSON.stringify({
              source: "catalog_community_coordinate_backfill",
              catalog_community_id: row.c_id,
              catalog_name: row.c_name,
              catalog_address: row.c_address,
              match_rule: "same district + unique normalized residential name",
              recorded_at: new Date().toISOString(),
            }),
            row.id,
            row.name,
            row.district,
          ],
        );
        updated += result.rowCount ?? 0;
      }
    }
    writeFileSync(path.join(dir, apply ? "backfill-applied.json" : "backfill-dry-run.json"), JSON.stringify({ mode: apply ? "apply" : "dry-run", accepted, rejected, updated }, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", uniqueMatches: matches.length, accepted: accepted.length, rejected: rejected.length, updated, report: dir }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
