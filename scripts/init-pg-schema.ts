import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { loadLocalEnv } from "./load-env";

const { Client } = pg;

loadLocalEnv();

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required.");
}

async function main() {
  const migrationsDir = path.join(process.cwd(), "drizzle-pg");
  const initialMigration = readdirSync(migrationsDir)
    .filter((fileName) => /^0000_.*\.sql$/.test(fileName))
    .sort()[0];

  if (!initialMigration) {
    throw new Error("No initial PostgreSQL migration found in drizzle-pg.");
  }

  const sqlPath = path.join(migrationsDir, initialMigration);
  const statements = readFileSync(sqlPath, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();
  try {
    await client.query("BEGIN");
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("COMMIT");
    console.log(`PostgreSQL schema initialized from ${initialMigration}.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
