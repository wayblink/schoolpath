import { NextRequest, NextResponse } from "next/server";
import { createReleaseBatch, listReleaseBatches } from "@/lib/product/release";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ batches: await listReleaseBatches() });
}

export async function POST(request: NextRequest) {
  let body: { name?: string; district?: string; sourceName?: string; year?: number; includeUnmatched?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be valid JSON" }, { status: 400 });
  }
  try {
    const name = typeof body.name === "string" ? body.name : "";
    return NextResponse.json(
      await createReleaseBatch({
        name,
        district: body.district,
        sourceName: body.sourceName,
        year: body.year,
        includeUnmatched: body.includeUnmatched === true,
      }),
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to create batch";
    return NextResponse.json({ error: message }, { status: /not found|no accepted/.test(message) ? 404 : 400 });
  }
}
