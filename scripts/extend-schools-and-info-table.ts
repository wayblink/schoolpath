/**
 * Additive schema extension:
 *  - add schools columns: website, student_count, school_scale, faculty (nullable, appended)
 *  - create school_info table (append-only crawled-info store, FK -> schools.id) + index
 *  - best-effort backfill student_count from attrs.official_current_students (numeric only)
 *
 * Idempotent DDL (IF NOT EXISTS). Single transaction; dry-run by default (ROLLBACK),
 * --apply to COMMIT. Pure additive — does not modify existing rows except the
 * guarded student_count backfill.
 */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;
loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const apply = process.argv.includes("--apply");

const STATEMENTS = [
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS website text`,
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS student_count integer`,
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS school_scale text`,
  `ALTER TABLE schools ADD COLUMN IF NOT EXISTS faculty text`,
  `CREATE TABLE IF NOT EXISTS school_info (
     id serial PRIMARY KEY,
     school_id integer NOT NULL REFERENCES schools(id),
     category text NOT NULL,
     title text,
     content text,
     year integer,
     source_name text NOT NULL,
     source_url text,
     source_date text,
     verified boolean NOT NULL DEFAULT false,
     raw jsonb,
     fetched_at timestamp with time zone DEFAULT now(),
     created_at timestamp with time zone DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS school_info_school_id_idx ON school_info (school_id)`,
];

const BACKFILL = `
  UPDATE schools
  SET student_count = (attrs->>'official_current_students')::int, updated_at = now()
  WHERE student_count IS NULL
    AND attrs->>'official_current_students' ~ '^[0-9]+$'
`;

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    console.log(`Mode: ${apply ? "APPLY (COMMIT)" : "dry-run (ROLLBACK)"}`);
    await client.query("BEGIN");

    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    const backfill = await client.query(BACKFILL);
    console.log(`student_count backfilled from attrs: ${backfill.rowCount ?? 0} rows`);

    // verification (inside txn)
    const cols = (
      await client.query(
        `SELECT attname FROM pg_attribute
         WHERE attrelid='public.schools'::regclass AND attnum>0 AND NOT attisdropped
         ORDER BY attnum`,
      )
    ).rows.map((r) => r.attname);
    const newCols = ["website", "student_count", "school_scale", "faculty"].filter((c) => cols.includes(c));
    const infoExists = (await client.query(`SELECT to_regclass('public.school_info') AS t`)).rows[0].t;
    const infoFk = Number(
      (await client.query(`SELECT count(*)::int c FROM pg_constraint WHERE conrelid='public.school_info'::regclass AND contype='f'`)).rows[0].c,
    );
    const infoIdx = (await client.query(`SELECT indexname FROM pg_indexes WHERE tablename='school_info'`)).rows.map((r) => r.indexname);

    console.log(`schools new columns present: ${newCols.join(", ")} (${newCols.length}/4)`);
    console.log(`schools column order tail: ${cols.slice(-4).join(", ")}`);
    console.log(`school_info table: ${infoExists ?? "MISSING"} | FK count: ${infoFk} | indexes: ${infoIdx.join(", ")}`);

    if (newCols.length !== 4 || !infoExists || infoFk < 1) {
      throw new Error("verification failed; aborting (rollback)");
    }

    if (apply) {
      await client.query("COMMIT");
      console.log("COMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("ROLLED BACK (dry-run). Re-run with --apply to commit.");
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
