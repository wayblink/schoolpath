import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";

export const runtime = "nodejs";

export async function GET() {
  const rows = await db
    .select({
      id: schema.webDataSource.id,
      schoolId: schema.webDataSource.schoolId,
      schoolName: schema.schools.name,
      district: schema.schools.district,
      sourceType: schema.webDataSource.sourceType,
      sourceName: schema.webDataSource.sourceName,
      sourceUrl: schema.webDataSource.sourceUrl,
      sourceTitle: schema.webDataSource.sourceTitle,
      sourceDate: schema.webDataSource.sourceDate,
      evidence: schema.webDataSource.evidence,
      confidence: schema.webDataSource.confidence,
      fetchedAt: schema.webDataSource.fetchedAt,
      updatedAt: schema.webDataSource.updatedAt,
    })
    .from(schema.webDataSource)
    .innerJoin(schema.schools, eq(schema.webDataSource.schoolId, schema.schools.id))
    .orderBy(desc(schema.webDataSource.updatedAt), desc(schema.webDataSource.id))
    .limit(300);

  const byType = new Map<string, number>();
  const byConfidence = new Map<string, number>();
  for (const row of rows) {
    byType.set(row.sourceType, (byType.get(row.sourceType) ?? 0) + 1);
    byConfidence.set(row.confidence, (byConfidence.get(row.confidence) ?? 0) + 1);
  }

  return NextResponse.json({
    sources: rows,
    stats: {
      total: rows.length,
      byType: Object.fromEntries(byType),
      byConfidence: Object.fromEntries(byConfidence),
    },
  });
}
