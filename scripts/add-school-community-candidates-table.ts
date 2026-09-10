/**
 * Add school_community_candidates for reviewed official catchment extraction.
 *
 * Idempotent DDL. Dry-run by default (ROLLBACK); pass --apply to COMMIT.
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS school_community_candidates (
     id serial PRIMARY KEY,
     school_id integer REFERENCES schools(id),
     school_name_raw text NOT NULL,
     district text NOT NULL,
     year integer NOT NULL,
     community_id integer REFERENCES communities(id),
     community_name_raw text NOT NULL,
     committee_name_raw text,
     source_url text,
     source_title text NOT NULL,
     source_date text,
     source_quote text NOT NULL,
     confidence text NOT NULL DEFAULT 'medium',
     status text NOT NULL DEFAULT 'pending',
     review_notes text,
     raw jsonb,
     created_at timestamp with time zone DEFAULT now(),
     updated_at timestamp with time zone DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS school_community_candidates_school_id_idx
     ON school_community_candidates (school_id)`,
  `CREATE INDEX IF NOT EXISTS school_community_candidates_year_district_idx
     ON school_community_candidates (year, district)`,
  `CREATE INDEX IF NOT EXISTS school_community_candidates_status_idx
     ON school_community_candidates (status)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS school_community_candidates_uniq_idx
     ON school_community_candidates (year, district, school_name_raw, community_name_raw, source_url)`,
];

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    console.log(`Mode: ${apply ? "APPLY (COMMIT)" : "dry-run (ROLLBACK)"}`);
    await client.query("BEGIN");

    for (const statement of STATEMENTS) {
      await client.query(statement);
    }

    const tableExists = (await client.query(`SELECT to_regclass('public.school_community_candidates') AS table_name`))
      .rows[0].table_name;
    const columns = (
      await client.query(
        `SELECT attname
         FROM pg_attribute
         WHERE attrelid='public.school_community_candidates'::regclass
           AND attnum > 0
           AND NOT attisdropped
         ORDER BY attnum`,
      )
    ).rows.map((row) => row.attname);
    const indexes = (
      await client.query(
        `SELECT indexname
         FROM pg_indexes
         WHERE tablename = 'school_community_candidates'
         ORDER BY indexname`,
      )
    ).rows.map((row) => row.indexname);

    console.log(`school_community_candidates table: ${tableExists ?? "MISSING"}`);
    console.log(`columns: ${columns.join(", ")}`);
    console.log(`indexes: ${indexes.join(", ")}`);

    const requiredColumns = [
      "id",
      "school_id",
      "school_name_raw",
      "district",
      "year",
      "community_id",
      "community_name_raw",
      "committee_name_raw",
      "source_url",
      "source_title",
      "source_date",
      "source_quote",
      "confidence",
      "status",
      "review_notes",
      "raw",
      "created_at",
      "updated_at",
    ];
    const missingColumns = requiredColumns.filter((column) => !columns.includes(column));
    const missingIndexes = [
      "school_community_candidates_school_id_idx",
      "school_community_candidates_year_district_idx",
      "school_community_candidates_status_idx",
      "school_community_candidates_uniq_idx",
    ].filter((index) => !indexes.includes(index));

    if (!tableExists || missingColumns.length > 0 || missingIndexes.length > 0) {
      throw new Error(
        `verification failed: missingColumns=${missingColumns.join(",")}, missingIndexes=${missingIndexes.join(",")}`,
      );
    }

    if (apply) {
      await client.query("COMMIT");
      console.log("COMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("ROLLED BACK (dry-run). Re-run with --apply to commit.");
    }
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
