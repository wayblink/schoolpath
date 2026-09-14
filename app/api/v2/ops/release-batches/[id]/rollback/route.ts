import { NextResponse } from "next/server";
import { rollbackReleaseBatch } from "@/lib/product/release";
export const runtime = "nodejs";
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json(await rollbackReleaseBatch(Number(id)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "rollback failed";
    const status = message.includes("not found") ? 404 : message.includes("only published") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
