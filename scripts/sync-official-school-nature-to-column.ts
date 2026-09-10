/** Promote only official catchment-derived nature values from attrs into the query column. */
import pg from "pg";
import { loadLocalEnv } from "./load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const apply = process.argv.includes("--apply");
async function main() {
const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query("begin");
  const result = await client.query(`
    update public.schools
    set school_nature = '公立'::school_nature, updated_at = now()
    where school_nature is null
      and attrs->'school_nature'->>'value' = '公办'
      and attrs->'school_nature'->>'confidence' = 'official-catchment-area'
      and attrs->>'official_boundary_source' is not null
  `);
  console.log(JSON.stringify({ planned: result.rowCount ?? 0, mode: apply ? "apply" : "dry-run" }));
  if (apply) await client.query("commit"); else await client.query("rollback");
} catch (error) {
  await client.query("rollback");
  throw error;
} finally {
  await client.end();
}
}
main().catch((error) => { console.error(error); process.exit(1); });
