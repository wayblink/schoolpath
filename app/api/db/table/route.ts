import { NextResponse } from "next/server";
import { DatabaseExplorerError, getTableDetail } from "@/lib/db/explorer";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const schema = params.get("schema");
  const name = params.get("name");
  if (!schema || !name) {
    return NextResponse.json({ error: "schema and name are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await getTableDetail(schema, name));
  } catch (err) {
    if (err instanceof DatabaseExplorerError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
