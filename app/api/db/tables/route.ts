import { NextResponse } from "next/server";
import { listTables } from "@/lib/db/explorer";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const schema = new URL(request.url).searchParams.get("schema");
  try {
    return NextResponse.json(await listTables(schema));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
