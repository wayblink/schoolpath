import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db/client";
import { and, eq, inArray, sql } from "drizzle-orm";
import { normalizeProductDistrict, PRODUCT_DISTRICTS } from "@/lib/product/districts";

const PRODUCT_DISTRICT_STORAGE_NAMES = PRODUCT_DISTRICTS.flatMap((district) =>
  district === "浦东" ? [district, "浦东区", "浦东新区"] : [district, `${district}区`],
);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const yearParam = url.searchParams.get("year");
  const district = url.searchParams.get("district");
  const productMode = url.searchParams.get("product") === "1";
  const year = yearParam ? Number(yearParam) : new Date().getFullYear();
  const normalizedDistrict = district ? normalizeProductDistrict(district) : null;
  const districtCondition = productMode
    ? normalizedDistrict
      ? inArray(schema.schools.district, normalizedDistrict === "浦东"
        ? ["浦东", "浦东区", "浦东新区"]
        : [normalizedDistrict, `${normalizedDistrict}区`])
      : district?.trim()
        ? sql`false`
        : inArray(schema.schools.district, PRODUCT_DISTRICT_STORAGE_NAMES)
    : district
      ? eq(schema.schools.district, district)
      : undefined;

  const rows = await db
    .select({
      boundaryId: schema.districtBoundaries.id,
      schoolId: schema.districtBoundaries.schoolId,
      year: schema.districtBoundaries.year,
      geojson: schema.districtBoundaries.geojson,
      notes: schema.districtBoundaries.notes,
      schoolName: schema.schools.name,
      schoolTier: schema.schools.tier,
      schoolType: schema.schools.type,
      schoolDistrict: schema.schools.district,
    })
    .from(schema.districtBoundaries)
    .innerJoin(schema.schools, eq(schema.districtBoundaries.schoolId, schema.schools.id))
    .where(
      and(
        eq(schema.districtBoundaries.year, year),
        ...(districtCondition ? [districtCondition] : []),
      ),
    );

  const featureCollection = {
    type: "FeatureCollection" as const,
    features: rows.map((r) => ({
      type: "Feature" as const,
      properties: {
        boundaryId: r.boundaryId,
        schoolId: r.schoolId,
        schoolName: r.schoolName,
        schoolTier: r.schoolTier,
        schoolType: r.schoolType,
        district: r.schoolDistrict,
        year: r.year,
        notes: r.notes,
      },
      geometry: r.geojson,
    })),
  };

  return NextResponse.json(featureCollection);
}
