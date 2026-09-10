import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const TABLES = ["schools", "communities", "district_boundaries", "policies", "school_communities"] as const;
const RESET_FLAG = "--reset-target";

type TableName = (typeof TABLES)[number];
type SqliteRow = Record<string, unknown>;

const databaseUrl = process.env.DATABASE_URL;
const sqlitePath = process.env.SQLITE_DB_PATH ?? path.join(process.cwd(), "data", "house.sqlite");
const shouldResetTarget = process.argv.includes(RESET_FLAG);

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

if (!existsSync(sqlitePath)) {
  throw new Error(`SQLite source not found: ${sqlitePath}`);
}

function backupSqlite() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const backupDir = path.join(process.cwd(), ".tmp", "pg-migration", stamp);
  mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, "house.sqlite");
  copyFileSync(sqlitePath, backupPath);
  return backupPath;
}

function parseJson(value: unknown) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return value;
  return JSON.parse(value);
}

function toBool(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function toDate(value: unknown) {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === "number") return new Date(value * 1000);
  if (typeof value === "string" && /^\d+$/.test(value)) return new Date(Number(value) * 1000);
  return new Date(String(value));
}

function rowsFor(sqlite: Database.Database, table: TableName) {
  return sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as SqliteRow[];
}

function transform(table: TableName, row: SqliteRow): SqliteRow {
  switch (table) {
    case "schools":
      return {
        id: row.id,
        name: row.name,
        district: row.district,
        tier: row.tier,
        type: row.type,
        address: row.address,
        lat: row.lat,
        lng: row.lng,
        enrollment_note: row.enrollment_note,
        recent_score_line: row.recent_score_line,
        pit_risk_level: row.pit_risk_level,
        attrs: parseJson(row.attrs),
        created_at: toDate(row.created_at),
        updated_at: toDate(row.updated_at),
      };
    case "communities":
      return {
        id: row.id,
        name: row.name,
        district: row.district,
        lng: row.lng,
        lat: row.lat,
        amap_poi_id: row.amap_poi_id,
        amap_type_code: row.amap_type_code,
        amap_type_name: row.amap_type_name,
        amap_address: row.amap_address,
        source_committee: row.source_committee,
        source_query: row.source_query,
        source_url: row.source_url,
        source_name: row.source_name,
        source_date: row.source_date,
        verified: toBool(row.verified),
        notes: row.notes,
        attrs: parseJson(row.attrs),
        osm_polygon: parseJson(row.osm_polygon),
        osm_way_id: row.osm_way_id,
        osm_fetched_at: row.osm_fetched_at,
        created_at: toDate(row.created_at),
      };
    case "district_boundaries":
      return {
        id: row.id,
        school_id: row.school_id,
        year: row.year,
        geojson: parseJson(row.geojson),
        notes: row.notes,
        created_at: toDate(row.created_at),
      };
    case "policies":
      return {
        id: row.id,
        school_id: row.school_id,
        scope: row.scope,
        district: row.district,
        year: row.year,
        title: row.title,
        source_url: row.source_url,
        content: row.content,
        change_summary: row.change_summary,
        fetched_at: toDate(row.fetched_at),
      };
    case "school_communities":
      return {
        id: row.id,
        school_id: row.school_id,
        community_id: row.community_id,
        committee_name: row.committee_name,
        year: row.year,
        source_name: row.source_name,
        source_url: row.source_url,
        source_quote: row.source_quote,
        source_date: row.source_date,
        verified: toBool(row.verified),
        notes: row.notes,
      };
  }
}

async function ensureTargetIsSafe(client: pg.Client) {
  const existing = await client.query<{ table_name: string; row_count: string }>(`
    SELECT table_name, row_count
    FROM (
      SELECT 'schools' AS table_name, count(*)::text AS row_count FROM schools
      UNION ALL SELECT 'communities', count(*)::text FROM communities
      UNION ALL SELECT 'district_boundaries', count(*)::text FROM district_boundaries
      UNION ALL SELECT 'policies', count(*)::text FROM policies
      UNION ALL SELECT 'school_communities', count(*)::text FROM school_communities
    ) counts
    WHERE row_count::int > 0
  `);

  if (existing.rows.length > 0 && !shouldResetTarget) {
    const counts = existing.rows.map((row) => `${row.table_name}=${row.row_count}`).join(", ");
    throw new Error(
      `Target PostgreSQL database is not empty (${counts}). Refusing to import. ` +
        `Use ${RESET_FLAG} only after verifying a target backup.`,
    );
  }

  if (shouldResetTarget) {
    await client.query("TRUNCATE school_communities, district_boundaries, policies, communities, schools RESTART IDENTITY");
  }
}

async function insertRows(client: pg.Client, table: TableName, rows: SqliteRow[]) {
  if (rows.length === 0) return;

  const columns = Object.keys(transform(table, rows[0]));
  const columnSql = columns.map((column) => `"${column}"`).join(", ");

  for (const row of rows) {
    const transformed = transform(table, row);
    const values = columns.map((column) => transformed[column]);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    await client.query(`INSERT INTO "${table}" (${columnSql}) VALUES (${placeholders})`, values);
  }

  await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT max(id) FROM "${table}"), 1), true)`);
}

async function tableCounts(client: pg.Client) {
  const result = await client.query<Record<TableName, string>>(`
    SELECT
      (SELECT count(*) FROM schools)::text AS schools,
      (SELECT count(*) FROM communities)::text AS communities,
      (SELECT count(*) FROM school_communities)::text AS school_communities,
      (SELECT count(*) FROM district_boundaries)::text AS district_boundaries,
      (SELECT count(*) FROM policies)::text AS policies
  `);
  return result.rows[0];
}

async function main() {
  const backupPath = backupSqlite();
  console.log(`SQLite backup created: ${backupPath}`);

  const sqlite = new Database(sqlitePath, { readonly: true });
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const sourceCounts = Object.fromEntries(TABLES.map((table) => [table, rowsFor(sqlite, table).length]));
    console.log("SQLite source counts:", sourceCounts);

    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await ensureTargetIsSafe(client);

    for (const table of TABLES) {
      const rows = rowsFor(sqlite, table);
      await insertRows(client, table, rows);
      console.log(`Imported ${table}: ${rows.length}`);
    }

    const targetCounts = await tableCounts(client);
    for (const table of TABLES) {
      if (Number(targetCounts[table]) !== sourceCounts[table]) {
        throw new Error(`Count mismatch for ${table}: sqlite=${sourceCounts[table]} pg=${targetCounts[table]}`);
      }
    }

    await client.query("COMMIT");
    console.log("PostgreSQL target counts:", targetCounts);
    console.log("SQLite to PostgreSQL migration completed.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    sqlite.close();
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
