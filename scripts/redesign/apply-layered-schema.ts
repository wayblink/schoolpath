import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "../load-env";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const sql = readFileSync(path.join(process.cwd(), "db/redesign/001_create_layered_schemas.sql"), "utf8");
const client = new pg.Client({ connectionString: databaseUrl });

async function main() {
  await client.connect();
  try {
  await client.query(sql);
  const { rows } = await client.query(`
    select 'catalog.schools' table_name, count(*)::int count from catalog.schools
    union all select 'catalog.communities', count(*)::int from catalog.communities
    union all select 'catalog.school_community_assignments', count(*)::int from catalog.school_community_assignments
    union all select 'catalog.policy_documents', count(*)::int from catalog.policy_documents
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
