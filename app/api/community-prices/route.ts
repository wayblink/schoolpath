import { desc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db/client";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const communityIdParam = url.searchParams.get("communityId");

  if (!communityIdParam) {
    return NextResponse.json(
      { error: "communityId query param required" },
      { status: 400 },
    );
  }

  const communityId = Number(communityIdParam);
  if (!Number.isInteger(communityId) || communityId <= 0) {
    return NextResponse.json(
      { error: "communityId must be a positive integer" },
      { status: 400 },
    );
  }

  const rows = await db
    .select({
      id: schema.communityPriceSnapshots.id,
      communityId: schema.communityPriceSnapshots.communityId,
      sourceName: schema.communityPriceSnapshots.sourceName,
      sourceUrl: schema.communityPriceSnapshots.sourceUrl,
      sourcePeriod: schema.communityPriceSnapshots.sourcePeriod,
      unitPriceYuanPerSqm: schema.communityPriceSnapshots.unitPriceYuanPerSqm,
      raw: schema.communityPriceSnapshots.raw,
      fetchedAt: schema.communityPriceSnapshots.fetchedAt,
    })
    .from(schema.communityPriceSnapshots)
    .where(eq(schema.communityPriceSnapshots.communityId, communityId))
    .orderBy(desc(schema.communityPriceSnapshots.fetchedAt));

  return NextResponse.json({
    communityId,
    priceSnapshots: rows,
    stats: { total: rows.length },
  });
}
