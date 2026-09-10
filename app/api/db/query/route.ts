import { NextResponse } from "next/server";
import { DatabaseExplorerError, ReadOnlyViolation, executeQuery } from "@/lib/db/explorer";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let body: { sql?: unknown; maxRows?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const sql = typeof body.sql === "string" ? body.sql : "";
  const maxRows = typeof body.maxRows === "number" ? body.maxRows : 200;

  try {
    return NextResponse.json(await executeQuery(sql, maxRows));
  } catch (err) {
    if (err instanceof ReadOnlyViolation || err instanceof DatabaseExplorerError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const message = (err as Error).message?.split("\n", 1)[0] ?? String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
