import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db/client";
import { desc, eq, and, sql } from "drizzle-orm";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const schoolIdParam = url.searchParams.get("schoolId");
  const yearParam = url.searchParams.get("year");
  const year = yearParam ? Number(yearParam) : 2025;

  if (!schoolIdParam) {
    return NextResponse.json(
      { error: "schoolId query param required" },
      { status: 400 },
    );
  }
  const schoolId = Number(schoolIdParam);

  const rows = await db
    .select({
      linkId: schema.schoolCommunities.id,
      communityId: schema.communities.id,
      name: schema.communities.name,
      lng: schema.communities.lng,
      lat: schema.communities.lat,
      amapPoiId: schema.communities.amapPoiId,
      amapTypeName: schema.communities.amapTypeName,
      amapAddress: schema.communities.amapAddress,
      sourceCommittee: schema.communities.sourceCommittee,
      communityVerified: schema.communities.verified,
      committeeName: schema.schoolCommunities.committeeName,
      sourceName: schema.schoolCommunities.sourceName,
      sourceUrl: schema.schoolCommunities.sourceUrl,
      sourceQuote: schema.schoolCommunities.sourceQuote,
      sourceDate: schema.schoolCommunities.sourceDate,
      linkVerified: schema.schoolCommunities.verified,
      notes: schema.schoolCommunities.notes,
    })
    .from(schema.schoolCommunities)
    .innerJoin(
      schema.communities,
      eq(schema.schoolCommunities.communityId, schema.communities.id),
    )
    .where(
      and(
        eq(schema.schoolCommunities.schoolId, schoolId),
        eq(schema.schoolCommunities.year, year),
      ),
    );

  const communityIds = Array.from(new Set(rows.map((r) => r.communityId)));
  const priceRows = communityIds.length > 0
    ? await db
      .select({
        id: schema.communityPriceSnapshots.id,
        communityId: schema.communityPriceSnapshots.communityId,
        sourceName: schema.communityPriceSnapshots.sourceName,
        sourceUrl: schema.communityPriceSnapshots.sourceUrl,
        sourcePeriod: schema.communityPriceSnapshots.sourcePeriod,
        unitPriceYuanPerSqm: schema.communityPriceSnapshots.unitPriceYuanPerSqm,
        fetchedAt: schema.communityPriceSnapshots.fetchedAt,
      })
      .from(schema.communityPriceSnapshots)
      .where(
        sql`${schema.communityPriceSnapshots.communityId} IN (${sql.join(
          communityIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      )
      .orderBy(
        schema.communityPriceSnapshots.communityId,
        desc(schema.communityPriceSnapshots.fetchedAt),
        desc(schema.communityPriceSnapshots.id),
      )
    : [];

  const latestPriceByCommunityId = new Map<number, (typeof priceRows)[number]>();
  for (const price of priceRows) {
    if (!latestPriceByCommunityId.has(price.communityId)) {
      latestPriceByCommunityId.set(price.communityId, price);
    }
  }

  const communities = rows.map((row) => ({
    ...row,
    latestPriceSnapshot: latestPriceByCommunityId.get(row.communityId) ?? null,
  }));

  // 按 source_name 分组的小统计
  const stats = {
    total: rows.length,
    via_committee: rows.filter((r) => r.sourceName === "amap_placesearch_via_committee").length,
    via_feeder: rows.filter((r) => r.sourceName === "derived_via_feeder_school").length,
    priced: rows.filter((r) => latestPriceByCommunityId.has(r.communityId)).length,
  };

  return NextResponse.json({ communities, stats });
}
