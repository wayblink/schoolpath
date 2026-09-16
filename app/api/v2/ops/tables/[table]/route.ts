import { NextRequest, NextResponse } from "next/server";
import { insertRow, listRows, OPS_TABLES } from "@/lib/db/crud";

export const runtime = "nodejs";

type Params = { params: Promise<{ table: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const { table } = await params;
  if (!OPS_TABLES.some((t) => t.key === table)) return NextResponse.json({ error: "unknown table" }, { status: 404 });
  const url = new URL(request.url);
  try {
    const result = await listRows(table, {
      page: Number(url.searchParams.get("page") ?? 1),
      pageSize: Number(url.searchParams.get("pageSize") ?? 30),
      q: url.searchParams.get("q") ?? undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const { table } = await params;
  if (!OPS_TABLES.some((t) => t.key === table)) return NextResponse.json({ error: "unknown table" }, { status: 404 });
  try {
    const body = await request.json();
    const row = await insertRow(table, body);
    return NextResponse.json({ row }, { status: 201 });
  } catch (err) {
    const message = (err as Error).message;
    const status = /foreign key|not-null|invalid input|必须是|没有可/.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
