/**
 * Add web_data_source for reviewed school web/evidence sources.
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
  `CREATE TABLE IF NOT EXISTS web_data_source (
     id serial PRIMARY KEY,
     school_id integer NOT NULL REFERENCES schools(id),
     source_type text NOT NULL,
     source_name text NOT NULL,
     source_url text,
     source_title text,
     source_date text,
     evidence text,
     confidence text NOT NULL DEFAULT 'high',
     raw jsonb,
     fetched_at timestamp with time zone DEFAULT now(),
     created_at timestamp with time zone DEFAULT now(),
     updated_at timestamp with time zone DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS web_data_source_school_id_idx ON web_data_source (school_id)`,
  `CREATE INDEX IF NOT EXISTS web_data_source_url_idx ON web_data_source (source_url)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS web_data_source_school_url_type_idx
     ON web_data_source (school_id, source_url, source_type)`,
];

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    console.log(`Mode: ${apply ? "APPLY (COMMIT)" : "dry-run (ROLLBACK)"}`);
    await client.query("BEGIN");

    for (const sql of STATEMENTS) {
      await client.query(sql);
    }

    const tableExists = (await client.query(`SELECT to_regclass('public.web_data_source') AS table_name`)).rows[0]
      .table_name;
    const columns = (
      await client.query(
        `SELECT attname
         FROM pg_attribute
         WHERE attrelid='public.web_data_source'::regclass
           AND attnum > 0
           AND NOT attisdropped
         ORDER BY attnum`,
      )
    ).rows.map((row) => row.attname);
    const indexes = (
      await client.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'web_data_source' ORDER BY indexname`)
    ).rows.map((row) => row.indexname);
    const fkCount = Number(
      (
        await client.query(
          `SELECT count(*)::int AS count
           FROM pg_constraint
           WHERE conrelid = 'public.web_data_source'::regclass
             AND contype = 'f'`,
        )
      ).rows[0].count,
    );

    console.log(`web_data_source table: ${tableExists ?? "MISSING"}`);
    console.log(`columns: ${columns.join(", ")}`);
    console.log(`indexes: ${indexes.join(", ")}`);
    console.log(`FK count: ${fkCount}`);

    const requiredColumns = [
      "id",
      "school_id",
      "source_type",
      "source_name",
      "source_url",
      "source_title",
      "source_date",
      "evidence",
      "confidence",
      "raw",
      "fetched_at",
      "created_at",
      "updated_at",
    ];
    const missingColumns = requiredColumns.filter((column) => !columns.includes(column));
    const missingIndexes = [
      "web_data_source_school_id_idx",
      "web_data_source_url_idx",
      "web_data_source_school_url_type_idx",
    ].filter((index) => !indexes.includes(index));

    if (!tableExists || missingColumns.length > 0 || missingIndexes.length > 0 || fkCount < 1) {
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
