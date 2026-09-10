import { NextResponse } from "next/server";
import { getSchoolDistrictSummary, getSchools } from "@/lib/product/queries";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const [schools, districts] = await Promise.all([
    getSchools({
      district: url.searchParams.get("district") || undefined,
      type: url.searchParams.get("type") || undefined,
      tier: url.searchParams.get("tier") || undefined,
      q: url.searchParams.get("q") || undefined,
      limit: Number(url.searchParams.get("limit") || 500),
    }),
    getSchoolDistrictSummary(),
  ]);
  return NextResponse.json({ schools, districts });
}
