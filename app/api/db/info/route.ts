import { NextResponse } from "next/server";
import { getDatabaseInfo } from "@/lib/db/explorer";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(await getDatabaseInfo());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
