import { NextResponse } from "next/server";
import { DatabaseExplorerError, deleteRow, deleteRows, insertRow, updateRow } from "@/lib/db/explorer";

export const runtime = "nodejs";

type Body = {
  schema?: unknown;
  name?: unknown;
  values?: unknown;
  pk?: unknown;
  pks?: unknown;
};

function parseTarget(body: Body): { schema: string; name: string } | null {
  if (typeof body.schema !== "string" || typeof body.name !== "string") return null;
  return { schema: body.schema, name: body.name };
}

function asRecord(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = v === null || v === undefined ? null : String(v);
  }
  return out;
}

async function readBody(request: Request): Promise<Body | null> {
  try {
    return (await request.json()) as Body;
  } catch {
    return null;
  }
}

function handleError(err: unknown) {
  if (err instanceof DatabaseExplorerError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  const message = (err as Error).message?.split("\n", 1)[0] ?? String(err);
  return NextResponse.json({ error: message }, { status: 500 });
}

export async function POST(request: Request) {
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const target = parseTarget(body);
  if (!target) return NextResponse.json({ error: "schema and name are required" }, { status: 400 });
  try {
    return NextResponse.json(await insertRow(target.schema, target.name, asRecord(body.values)));
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(request: Request) {
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const target = parseTarget(body);
  if (!target) return NextResponse.json({ error: "schema and name are required" }, { status: 400 });
  try {
    return NextResponse.json(
      await updateRow(target.schema, target.name, asRecord(body.pk), asRecord(body.values)),
    );
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(request: Request) {
  const body = await readBody(request);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const target = parseTarget(body);
  if (!target) return NextResponse.json({ error: "schema and name are required" }, { status: 400 });
  try {
    // Batch delete when `pks` (array) is provided, otherwise single `pk`.
    if (Array.isArray(body.pks)) {
      const pks = (body.pks as unknown[]).map((p) => asRecord(p));
      return NextResponse.json(await deleteRows(target.schema, target.name, pks));
    }
    return NextResponse.json(await deleteRow(target.schema, target.name, asRecord(body.pk)));
  } catch (err) {
    return handleError(err);
  }
}
