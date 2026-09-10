import { NextResponse } from "next/server";
import { buildSchoolDistrictAudit } from "@/lib/school-district-audit";

export const runtime = "nodejs";

function parseYears(value: string | null) {
  if (!value) return undefined;
  const years = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 2000);
  return years.length > 0 ? years : undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const years = parseYears(url.searchParams.get("years"));
  const includeRemoteSources = url.searchParams.get("remote") !== "0";

  try {
    const audit = await buildSchoolDistrictAudit({ years, includeRemoteSources });
    return NextResponse.json(audit);
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to build audit";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
