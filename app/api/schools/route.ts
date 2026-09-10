import { NextResponse } from "next/server";
import { db, schema } from "@/lib/db/client";
import { eq, inArray, sql } from "drizzle-orm";
import { normalizeProductDistrict, PRODUCT_DISTRICTS } from "@/lib/product/districts";

const PRODUCT_DISTRICT_STORAGE_NAMES = PRODUCT_DISTRICTS.flatMap((district) =>
  district === "浦东" ? [district, "浦东区", "浦东新区"] : [district, `${district}区`],
);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const district = url.searchParams.get("district");
  const compact = url.searchParams.get("compact") === "1";
  const productMode = url.searchParams.get("product") === "1";
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

  const rows = districtCondition
    ? await db.select().from(schema.schools).where(districtCondition)
    : await db.select().from(schema.schools);

  const schools = compact ? rows.map((school) => ({
    id: school.id, name: school.name, district: school.district, tier: school.tier,
    type: school.type, schoolNature: school.schoolNature, address: school.address,
    lat: school.lat, lng: school.lng, enrollmentNote: school.enrollmentNote,
    recentScoreLine: school.recentScoreLine, pitRiskLevel: school.pitRiskLevel,
    attrs: {
      aliases: school.attrs?.aliases,
      shortName: school.attrs?.shortName,
      campus: school.attrs?.campus,
      matching_committees: school.attrs?.matching_committees,
      official_committee_items: school.attrs?.official_committee_items,
      feeder_schools: school.attrs?.feeder_schools,
      policy_url: school.attrs?.policy_url,
      data_source: school.attrs?.data_source,
    },
  })) : rows;

  return NextResponse.json({ schools });
}
