import { NextRequest, NextResponse } from "next/server";
import { listMatchCandidates, reviewMatchCandidate } from "@/lib/product/queries";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status") ?? "pending";
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const pageSize = Number(request.nextUrl.searchParams.get("pageSize") ?? 30);
  return NextResponse.json(await listMatchCandidates({ status, page, pageSize }));
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  let body: { action?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  try {
    const result = await reviewMatchCandidate(Number(id), body.action as "confirm" | "reject", body.note);
    if (!result) return NextResponse.json({ error: "candidate not found" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "review failed";
    const status = message.includes("not found") ? 404 : message.includes("already") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
