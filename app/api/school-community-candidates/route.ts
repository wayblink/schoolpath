import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export const runtime = "nodejs";

type CandidateSummaryRow = {
  year: number | string;
  district: string;
  status: string;
  confidence: string;
  count: number | string;
  matched_schools: number | string;
};

function parseYears(value: string | null) {
  if (!value) return [2026, 2025];
  const years = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 2000);
  return years.length > 0 ? years : [2026, 2025];
}

function toNumber(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const years = parseYears(url.searchParams.get("years"));

  const exists = await db.execute<{ table_name: string | null }>(
    sql`SELECT to_regclass('public.school_community_candidates') AS table_name`,
  );
  if (!exists.rows[0]?.table_name) {
    return NextResponse.json({
      summaries: [],
      stats: {
        total: 0,
        matchedSchools: 0,
        byYear: {},
        byStatus: {},
      },
      tableReady: false,
    });
  }

  const result = await db.execute<CandidateSummaryRow>(sql`
    SELECT
      year,
      district,
      status,
      confidence,
      count(*)::int AS count,
      count(DISTINCT school_id) FILTER (WHERE school_id IS NOT NULL)::int AS matched_schools
    FROM school_community_candidates
    WHERE year IN (${sql.join(years.map((year) => sql`${year}`), sql`, `)})
    GROUP BY year, district, status, confidence
    ORDER BY year DESC, district, status, confidence
  `);

  const summaries = result.rows.map((row) => ({
    year: toNumber(row.year),
    district: row.district,
    status: row.status,
    confidence: row.confidence,
    count: toNumber(row.count),
    matchedSchools: toNumber(row.matched_schools),
  }));
  const byYear: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  let total = 0;
  let matchedSchools = 0;
  for (const row of summaries) {
    total += row.count;
    matchedSchools += row.matchedSchools;
    byYear[row.year] = (byYear[row.year] ?? 0) + row.count;
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
  }

  return NextResponse.json({
    summaries,
    stats: {
      total,
      matchedSchools,
      byYear,
      byStatus,
    },
    tableReady: true,
  });
}
