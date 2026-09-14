import { NextResponse } from "next/server";
import { publishReleaseBatch } from "@/lib/product/release";
export const runtime = "nodejs";
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    return NextResponse.json(await publishReleaseBatch(Number(id)));
  } catch (err) {
    const message = err instanceof Error ? err.message : "publish failed";
    const status = message.includes("not found") ? 404 : message.includes("only draft") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
