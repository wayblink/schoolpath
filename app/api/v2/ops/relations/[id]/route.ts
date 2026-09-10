import { NextRequest, NextResponse } from "next/server";
import { reviewRelationCandidate } from "@/lib/product/queries";
export const runtime = "nodejs";
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = await request.json() as { action?: string; note?: string };
  if (body.action !== "accept" && body.action !== "reject") return NextResponse.json({ error: "action must be accept or reject" }, { status: 400 });
  try {
    const relation = await reviewRelationCandidate(Number(id), body.action, body.note);
    if (!relation) return NextResponse.json({ error: "candidate not found" }, { status: 404 });
    return NextResponse.json({ relation });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "review failed" }, { status: 409 });
  }
}
