import { NextResponse } from "next/server";
import { reviewFieldConflict } from "@/lib/product/queries";
export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: { action?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  try {
    const result = await reviewFieldConflict(Number(id), body.action as "keep_current" | "take_source", body.note);
    if (!result) return NextResponse.json({ error: "conflict not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "review failed";
    const status = message.includes("not found") ? 404 : message.includes("already") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
