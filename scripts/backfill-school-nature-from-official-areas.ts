/**
 * Incrementally backfill public school nature for schools that already have
 * official 2025 catchment-area evidence in attrs.
 *
 * Safety rules:
 * - default mode is dry-run; pass --apply to write
 * - only fills missing/invalid attrs.school_nature
 * - requires official boundary/source evidence already stored on the school row
 * - skips school names containing 民办; use an explicit reviewed source for private schools
 * - UPDATE is guarded by id + name + district
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");
const district = valueArg("--district");
const sourcePattern = valueArg("--source-pattern") ?? "校区范围";
const limit = numberArg("--limit");

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  address: string | null;
  data_source: string | null;
  policy_url: string | null;
  official_boundary_source: string | null;
  official_area_count: number;
  official_boundary_text: string | null;
  current_school_nature: unknown;
};

type ReportRow = {
  school: SchoolRow;
  action: string;
  fill: {
    value: "公办";
    normalized: "public";
    confidence: "official-catchment-area";
  };
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

function outputPaths() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-nature-official-areas", stamp);
  mkdirSync(dir, { recursive: true });
  return {
    snapshot: path.join(dir, "target-schools-before.json"),
    report: path.join(dir, apply ? "matches-applied.json" : "matches-dry-run.json"),
  };
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const params: Array<string | number> = [sourcePattern];
    const where = [
      `NOT (
        lower(coalesce(attrs->>'school_nature', '')) LIKE '%公办%'
        OR lower(coalesce(attrs->>'school_nature', '')) LIKE '%民办%'
        OR lower(coalesce(attrs->>'school_nature', '')) LIKE '%public%'
        OR lower(coalesce(attrs->>'school_nature', '')) LIKE '%private%'
      )`,
      `name NOT LIKE '%民办%'`,
      `(attrs->>'official_boundary_source' IS NOT NULL OR attrs->>'policy_url' IS NOT NULL)`,
      `(
        coalesce(attrs->>'official_boundary_text', '') <> ''
        OR jsonb_array_length(coalesce(attrs->'official_area_items', '[]'::jsonb)) > 0
      )`,
      `coalesce(attrs->>'data_source', '') ILIKE '%' || $1 || '%'`,
    ];

    if (district) {
      params.push(district);
      where.push(`district = $${params.length}`);
    }

    let limitSql = "";
    if (limit) {
      params.push(limit);
      limitSql = `LIMIT $${params.length}`;
    }

    const target = await client.query<SchoolRow>(
      `
        SELECT
          id,
          name,
          district,
          type,
          address,
          attrs->>'data_source' AS data_source,
          attrs->>'policy_url' AS policy_url,
          attrs->>'official_boundary_source' AS official_boundary_source,
          jsonb_array_length(coalesce(attrs->'official_area_items', '[]'::jsonb))::int AS official_area_count,
          attrs->>'official_boundary_text' AS official_boundary_text,
          attrs->'school_nature' AS current_school_nature
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
    console.log(`Mode: ${apply ? "apply" : "dry-run"}, sourcePattern=${sourcePattern}`);

    const reports: ReportRow[] = [];
    let updated = 0;
    await client.query("BEGIN");

    for (const school of target.rows) {
      const fill = {
        value: "公办" as const,
        normalized: "public" as const,
        confidence: "official-catchment-area" as const,
      };
      reports.push({ school, action: apply ? "update" : "dry-run", fill });
      console.log(
        `${apply ? "UPDATE" : "DRY"} id=${school.id} ${school.district} ${school.name} -> 公办/public source=${school.official_boundary_source ?? school.policy_url}`,
      );

      if (!apply) continue;

      const result = await client.query(
        `
          UPDATE schools
          SET
            attrs = jsonb_set(
              jsonb_set(
                coalesce(attrs, '{}'::jsonb),
                '{school_nature}',
                $1::jsonb,
                true
              ),
              '{school_nature_source}',
              $2::jsonb,
              true
            ),
            updated_at = now()
          WHERE id = $3
            AND name = $4
            AND district = $5
            AND NOT (
              lower(coalesce(attrs->>'school_nature', '')) LIKE '%公办%'
              OR lower(coalesce(attrs->>'school_nature', '')) LIKE '%民办%'
              OR lower(coalesce(attrs->>'school_nature', '')) LIKE '%public%'
              OR lower(coalesce(attrs->>'school_nature', '')) LIKE '%private%'
            )
        `,
        [
          JSON.stringify(fill),
          JSON.stringify({
            source: "official_catchment_area",
            source_pattern: sourcePattern,
            data_source: school.data_source,
            policy_url: school.policy_url,
            official_boundary_source: school.official_boundary_source,
            official_area_count: school.official_area_count,
            collected_at: new Date().toISOString(),
          }),
          school.id,
          school.name,
          school.district,
        ],
      );
      updated += result.rowCount ?? 0;
    }

    writeFileSync(paths.report, JSON.stringify(reports, null, 2), "utf8");
    if (apply) await client.query("COMMIT");
    else await client.query("ROLLBACK");

    console.log(`Report: ${paths.report}`);
    console.log(`Done. planned=${reports.length}, updated=${updated}, dryRun=${!apply}`);
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
