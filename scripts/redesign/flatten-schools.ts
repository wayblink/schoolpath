import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "../load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

async function main() {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const sql = readFileSync(path.join(process.cwd(), "db/redesign/005_flatten_schools.sql"), "utf8");
    await client.query(sql);
    const { rows } = await client.query(`
      select
        (select count(*)::int from public.schools) schools,
        (select count(*)::int from public.schools where source_key is not null) source_enriched,
        (select count(*)::int from catalog.source_schools where public_school_id is not null) source_linked,
        (select count(*)::int from catalog.school_district_relations where school_id is not null) relations_linked
    `);
    console.table(rows);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
