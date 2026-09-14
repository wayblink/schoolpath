import { NextResponse } from "next/server";
import { getPipelineStats } from "@/lib/product/pipeline";
export const runtime = "nodejs";
export async function GET() {
  return NextResponse.json(await getPipelineStats());
}
