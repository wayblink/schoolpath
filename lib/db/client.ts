import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required. Start the PostgreSQL service or set a valid connection string.");
}

export const pool = new Pool({ connectionString: DATABASE_URL });

export const db = drizzle(pool, { schema });
export { schema };
