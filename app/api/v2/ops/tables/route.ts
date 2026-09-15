import { NextResponse } from "next/server";
import pg from "pg";

export const runtime = "nodejs";

export async function GET() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const { OPS_TABLES } = await import("@/lib/db/crud");
    const tables = await Promise.all(
      OPS_TABLES.map(async (t) => {
        const { rows } = await pool.query(`select count(*)::int c from public.${JSON.stringify(t.key)}`);
        return { key: t.key, label: t.label, icon: t.icon, count: rows[0].c };
      }),
    );
    return NextResponse.json({ tables });
  } finally {
    await pool.end();
  }
}
