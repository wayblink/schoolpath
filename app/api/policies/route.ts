import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db/client";
import { eq, desc } from "drizzle-orm";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const schoolIdParam = url.searchParams.get("schoolId");

  const rows = schoolIdParam
    ? await db
        .select()
        .from(schema.policies)
        .where(eq(schema.policies.schoolId, Number(schoolIdParam)))
        .orderBy(desc(schema.policies.year))
    : await db.select().from(schema.policies).orderBy(desc(schema.policies.year));

  return NextResponse.json({ policies: rows });
}
