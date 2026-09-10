import { NextRequest, NextResponse } from "next/server";
import { getRelationReviewCandidates } from "@/lib/product/queries";
export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status") ?? "pending";
  const district = request.nextUrl.searchParams.get("district") ?? undefined;
  const page = Number(request.nextUrl.searchParams.get("page") ?? 1);
  const pageSize = Number(request.nextUrl.searchParams.get("pageSize") ?? 30);
  return NextResponse.json(await getRelationReviewCandidates({ status, district, page, pageSize }));
}
