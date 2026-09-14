import { NextResponse } from "next/server";
import { listMatchCandidates } from "@/lib/product/queries";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";
  const page = Number(url.searchParams.get("page") ?? 1);
  const pageSize = Number(url.searchParams.get("pageSize") ?? 30);
  return NextResponse.json(await listMatchCandidates({ status, page, pageSize }));
}
