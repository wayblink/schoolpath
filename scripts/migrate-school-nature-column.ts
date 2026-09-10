/**
 * Promote attrs.school_nature into a first-class `school_nature` enum column on
 * `schools`, physically positioned right after `type`, clean/normalize the
 * values into 公立/私立 (else NULL), and strip school_nature / school_nature_source
 * from attrs.
 *
 * PostgreSQL cannot insert a column at a position, so this rebuilds the table:
 *   create schools_new (correct column order) -> copy + map + clean -> swap
 *   (detach sequence, drop child FKs, drop old, rename, re-add PK/indexes/seq/FKs).
 *
 * Safety: everything runs in ONE transaction. Default is dry-run (ROLLBACK);
 * pass --apply to COMMIT. A pre-image snapshot is written to .tmp/. Take a
 * pg_dump backup before --apply (see plan).
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

// Desired physical column order (school_nature inserted right after type).
const NEW_TABLE_DDL = `
  CREATE TABLE schools_new (
    id integer NOT NULL,
    name text NOT NULL,
    district text NOT NULL,
    tier text,
    type school_type NOT NULL,
    school_nature school_nature,
    address text,
    lat double precision,
    lng double precision,
    enrollment_note text,
    recent_score_line text,
    pit_risk_level pit_risk_level DEFAULT 'unknown',
    attrs jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
  )
`;

const NATURE_EXPR = `
  CASE
    WHEN attrs->'school_nature'->>'normalized' = 'public' THEN '公立'
    WHEN attrs->'school_nature'->>'normalized' = 'private' THEN '私立'
    WHEN lower(coalesce(attrs->>'school_nature','')) LIKE '%公办%'
      OR lower(coalesce(attrs->>'school_nature','')) LIKE '%public%' THEN '公立'
    WHEN lower(coalesce(attrs->>'school_nature','')) LIKE '%民办%'
      OR lower(coalesce(attrs->>'school_nature','')) LIKE '%private%' THEN '私立'
    ELSE NULL
  END::school_nature
`;

const COPY_SQL = `
  INSERT INTO schools_new
    (id, name, district, tier, type, school_nature, address, lat, lng,
     enrollment_note, recent_score_line, pit_risk_level, attrs, created_at, updated_at)
  SELECT
    id, name, district, tier, type,
    ${NATURE_EXPR},
    address, lat, lng, enrollment_note, recent_score_line, pit_risk_level,
    (attrs - 'school_nature' - 'school_nature_source'),
    created_at, updated_at
  FROM schools
`;

type FkRow = { conname: string; child_table: string; def: string };
type IdxRow = { indexname: string; indexdef: string };

function snapshotDir() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = path.join(process.cwd(), ".tmp", "school-nature-column", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function main() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const dir = snapshotDir();
    console.log(`Mode: ${apply ? "APPLY (will COMMIT)" : "dry-run (will ROLLBACK)"}`);
    console.log(`Snapshot dir: ${dir}`);

    // ---- pre-image (outside txn, read-only) ----
    const beforeCount = Number((await client.query(`SELECT count(*)::int AS c FROM schools`)).rows[0].c);
    const beforeDist = (
      await client.query(
        `SELECT attrs->>'school_nature' AS raw, count(*)::int AS c FROM schools GROUP BY 1 ORDER BY 2 DESC`,
      )
    ).rows;
    const fks = (
      await client.query<FkRow>(`
        SELECT con.conname, rel.relname AS child_table, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE con.confrelid = 'public.schools'::regclass AND con.contype = 'f'
        ORDER BY rel.relname
      `)
    ).rows;
    const idxs = (
      await client.query<IdxRow>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='schools'`,
      )
    ).rows;
    const nonPkIdx = idxs.filter((i) => i.indexname !== "schools_pkey");

    writeFileSync(
      path.join(dir, "pre-image.json"),
      JSON.stringify({ beforeCount, beforeDist, fks, idxs }, null, 2),
      "utf8",
    );
    console.log(`schools rows: ${beforeCount}`);
    console.log(`FKs referencing schools: ${fks.map((f) => `${f.child_table}.${f.conname}`).join(", ")}`);
    console.log(`non-PK indexes to recreate: ${nonPkIdx.map((i) => i.indexname).join(", ") || "(none)"}`);

    // ---- rebuild in one transaction ----
    await client.query("BEGIN");

    await client.query(`DROP TABLE IF EXISTS schools_new`);
    const hasType = (await client.query(`SELECT 1 FROM pg_type WHERE typname = 'school_nature'`)).rowCount;
    if (!hasType) {
      await client.query(`CREATE TYPE school_nature AS ENUM ('公立', '私立')`);
      console.log("created enum type school_nature");
    } else {
      console.log("enum type school_nature already exists, reusing");
    }

    await client.query(NEW_TABLE_DDL);
    const copied = (await client.query(COPY_SQL)).rowCount ?? 0;
    const newCount = Number((await client.query(`SELECT count(*)::int AS c FROM schools_new`)).rows[0].c);
    console.log(`copied ${copied} rows -> schools_new has ${newCount}`);
    if (newCount !== beforeCount) {
      throw new Error(`row count mismatch: before=${beforeCount} after=${newCount}; aborting`);
    }

    // swap
    await client.query(`ALTER SEQUENCE schools_id_seq OWNED BY NONE`);
    for (const fk of fks) {
      await client.query(`ALTER TABLE "${fk.child_table}" DROP CONSTRAINT "${fk.conname}"`);
    }
    await client.query(`DROP TABLE schools`);
    await client.query(`ALTER TABLE schools_new RENAME TO schools`);
    await client.query(`ALTER TABLE schools ADD CONSTRAINT schools_pkey PRIMARY KEY (id)`);
    for (const idx of nonPkIdx) {
      await client.query(idx.indexdef); // indexdef targets table "schools"
    }
    await client.query(`ALTER TABLE schools ALTER COLUMN id SET DEFAULT nextval('schools_id_seq'::regclass)`);
    await client.query(`ALTER SEQUENCE schools_id_seq OWNED BY schools.id`);
    await client.query(`SELECT setval('schools_id_seq', GREATEST((SELECT COALESCE(max(id), 1) FROM schools), 1))`);
    for (const fk of fks) {
      await client.query(`ALTER TABLE "${fk.child_table}" ADD CONSTRAINT "${fk.conname}" ${fk.def}`);
    }

    // ---- in-txn verification ----
    const colOrder = (
      await client.query(
        `SELECT attname FROM pg_attribute
         WHERE attrelid='public.schools'::regclass AND attnum>0 AND NOT attisdropped
         ORDER BY attnum`,
      )
    ).rows.map((r) => r.attname);
    const typeIdx = colOrder.indexOf("type");
    const natureIdx = colOrder.indexOf("school_nature");
    const fkAfter = Number(
      (await client.query(`SELECT count(*)::int c FROM pg_constraint WHERE confrelid='public.schools'::regclass AND contype='f'`))
        .rows[0].c,
    );
    const leftoverKeys = Number(
      (await client.query(`SELECT count(*)::int c FROM schools WHERE attrs ? 'school_nature' OR attrs ? 'school_nature_source'`))
        .rows[0].c,
    );
    const natureDist = (
      await client.query(`SELECT school_nature, count(*)::int c FROM schools GROUP BY 1 ORDER BY 2 DESC`)
    ).rows;

    const report = {
      apply,
      beforeCount,
      newCount,
      columnOrder: colOrder,
      typeAt: typeIdx,
      schoolNatureAt: natureIdx,
      naturePlacedAfterType: natureIdx === typeIdx + 1,
      fksRestored: fkAfter,
      leftoverAttrsKeys: leftoverKeys,
      natureDistribution: natureDist,
    };
    writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2), "utf8");
    console.log("\n=== verification ===");
    console.log(`column order: ${colOrder.join(", ")}`);
    console.log(`school_nature right after type: ${report.naturePlacedAfterType}`);
    console.log(`FKs restored: ${fkAfter} (expected ${fks.length})`);
    console.log(`rows still carrying attrs school_nature keys: ${leftoverKeys} (expected 0)`);
    console.log(`new column distribution: ${JSON.stringify(natureDist)}`);

    if (!report.naturePlacedAfterType || fkAfter !== fks.length || leftoverKeys !== 0) {
      throw new Error("post-rebuild verification failed; aborting (rollback)");
    }

    if (apply) {
      await client.query("COMMIT");
      console.log("\nCOMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("\nROLLED BACK (dry-run). Re-run with --apply to commit.");
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
