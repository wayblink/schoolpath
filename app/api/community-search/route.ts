import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db/client";
import { eq, like, or, and, sql } from "drizzle-orm";

/**
 * 反向查询: 输入小区名/居委名 → 返回该小区对口的所有学校
 * GET /api/community-search?q=长桥五村&year=2025
 *
 * 返回:
 *   communities: [{ id, name, district, lng, lat, source_committee, schools: [{...}] }]
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const yearParam = url.searchParams.get("year");
  const year = yearParam ? Number(yearParam) : 2025;

  if (!q || q.length < 1) {
    return NextResponse.json({ communities: [] });
  }

  // 第一步: 找匹配 community (name LIKE q 或 source_committee LIKE q)
  const pattern = `%${q}%`;
  const matchedCommunities = await db
    .select()
    .from(schema.communities)
    .where(
      or(
        like(schema.communities.name, pattern),
        like(schema.communities.sourceCommittee, pattern),
        like(schema.communities.amapAddress, pattern),
      ),
    )
    .limit(50);

  if (matchedCommunities.length === 0) {
    return NextResponse.json({ communities: [] });
  }

  // 第二步: 对每个 community 查它对口的所有学校
  const communityIds = matchedCommunities.map((c) => c.id);
  const links = await db
    .select({
      communityId: schema.schoolCommunities.communityId,
      schoolId: schema.schoolCommunities.schoolId,
      committeeName: schema.schoolCommunities.committeeName,
      sourceName: schema.schoolCommunities.sourceName,
      sourceUrl: schema.schoolCommunities.sourceUrl,
      schoolName: schema.schools.name,
      schoolDistrict: schema.schools.district,
      schoolType: schema.schools.type,
      schoolTier: schema.schools.tier,
      schoolPolicyUrl: sql<string | null>`${schema.schools.attrs}->>'policy_url'`,
    })
    .from(schema.schoolCommunities)
    .innerJoin(schema.schools, eq(schema.schoolCommunities.schoolId, schema.schools.id))
    .where(
      and(
        eq(schema.schoolCommunities.year, year),
        sql`${schema.schoolCommunities.communityId} IN (${sql.join(
          communityIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      ),
    );

  // 第三步: 按 community 聚合
  const linksByCommId = new Map<number, typeof links>();
  for (const l of links) {
    if (!linksByCommId.has(l.communityId)) linksByCommId.set(l.communityId, []);
    linksByCommId.get(l.communityId)!.push(l);
  }

  const result = matchedCommunities
    .map((c) => ({
      id: c.id,
      name: c.name,
      district: c.district,
      lng: c.lng,
      lat: c.lat,
      address: c.amapAddress,
      sourceCommittee: c.sourceCommittee,
      verified: c.verified,
      schools: (linksByCommId.get(c.id) ?? []).map((l) => ({
        id: l.schoolId,
        name: l.schoolName,
        district: l.schoolDistrict,
        type: l.schoolType,
        tier: l.schoolTier,
        committeeName: l.committeeName,
        sourceName: l.sourceName,
        sourceUrl: l.sourceUrl,
        policyUrl: l.schoolPolicyUrl,
      })),
    }))
    // 优先有 schools 的小区在前
    .sort((a, b) => b.schools.length - a.schools.length);

  return NextResponse.json({
    query: q,
    communities: result,
    stats: {
      matched_communities: result.length,
      total_school_links: links.length,
    },
  });
}
