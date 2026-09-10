import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { db, schema } from "@/lib/db/client";
import { eq } from "drizzle-orm";

type SchoolSeed = {
  name: string;
  shortName?: string;
  district: string;
  tier?: string;
  type: "primary" | "middle" | "nine_year";
  address?: string;
  lat?: number;
  lng?: number;
  enrollmentNote?: string;
  recentScoreLine?: string;
  pitRiskLevel?: "low" | "medium" | "high" | "unknown";
  attrs?: Record<string, unknown>;
};

type SchoolTierOverride = {
  district: string;
  names: string[];
  tier: string;
  sourceName?: string;
  sourceUrl?: string;
  sourceNote?: string;
  verified?: boolean;
};

type SchoolTierFile = {
  items?: SchoolTierOverride[];
};

const DEFAULT_SCHOOL_TIER = "未入榜/待补充";
const SEED_CONFIRM_ENV = "HOUSE_ALLOW_DESTRUCTIVE_SEED";
const SEED_CONFIRM_VALUE = "I_UNDERSTAND_THIS_WILL_DELETE_HOUSE_DATA";

type GeoJsonFC = {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    properties: { school: string; year: number; verified?: boolean };
    geometry: unknown;
  }>;
};

type DistrictPolicy = {
  documentNumber: string;
  title: string;
  publishDate: string;
  officialUrl: string;
  scope: "city" | "district" | "school";
  district?: string;
  year: number;
  keyRules: Record<string, unknown>;
  _notes?: string[];
};

async function clearAll() {
  if (process.env[SEED_CONFIRM_ENV] !== SEED_CONFIRM_VALUE) {
    throw new Error(
      [
        "Refusing to run destructive seed.",
        "This script deletes schools, policies, district_boundaries, and can orphan or destroy hand-maintained mapping data.",
        `Set ${SEED_CONFIRM_ENV}=${SEED_CONFIRM_VALUE} only after taking a verified DB backup.`,
      ].join("\n"),
    );
  }

  await db.delete(schema.districtBoundaries);
  await db.delete(schema.policies);
  await db.delete(schema.schools);
  console.log("Cleared existing data.");
}

async function seedSchools(): Promise<Map<string, number>> {
  const schoolsPath = path.join(process.cwd(), "data", "schools.json");
  const seedSchools: SchoolSeed[] = JSON.parse(readFileSync(schoolsPath, "utf-8"));
  const tierOverrides = loadSchoolTierOverrides();

  const idMap = new Map<string, number>();
  console.log(`Seeding ${seedSchools.length} schools...`);

  for (const s of seedSchools) {
    const tierOverride = tierOverrides.get(schoolTierKey(s.district, s.name));
    const schoolTier = tierOverride?.tier ?? s.tier ?? DEFAULT_SCHOOL_TIER;
    const schoolAttrs = {
      shortName: s.shortName,
      ...(s.attrs ?? {}),
      ...(tierOverride
        ? {
            schoolTierSource: {
              name: tierOverride.sourceName,
              url: tierOverride.sourceUrl,
              note: tierOverride.sourceNote,
              verified: tierOverride.verified ?? false,
            },
          }
        : {}),
    };

    const [inserted] = await db
      .insert(schema.schools)
      .values({
        name: s.name,
        district: s.district,
        tier: schoolTier,
        type: s.type,
        address: s.address,
        lat: s.lat,
        lng: s.lng,
        enrollmentNote: s.enrollmentNote,
        recentScoreLine: s.recentScoreLine,
        pitRiskLevel: s.pitRiskLevel ?? "unknown",
        attrs: schoolAttrs,
      })
      .returning({ id: schema.schools.id, name: schema.schools.name });
    idMap.set(s.name, inserted.id);
    console.log(`  inserted: ${s.name} (id=${inserted.id})`);
  }
  return idMap;
}

function loadSchoolTierOverrides(): Map<string, SchoolTierOverride> {
  const tiersPath = path.join(process.cwd(), "data", "school-tiers.json");
  const tierMap = new Map<string, SchoolTierOverride>();

  if (!existsSync(tiersPath)) return tierMap;

  const tierFile: SchoolTierFile = JSON.parse(readFileSync(tiersPath, "utf-8"));
  for (const item of tierFile.items ?? []) {
    for (const name of item.names) {
      const key = schoolTierKey(item.district, name);
      if (tierMap.has(key)) {
        throw new Error(`Duplicate school tier override: ${item.district} / ${name}`);
      }
      tierMap.set(key, item);
    }
  }

  console.log(`Loaded ${tierMap.size} school tier overrides.`);
  return tierMap;
}

function schoolTierKey(district: string, name: string) {
  return `${district.trim()}::${name.trim()}`;
}

async function seedBoundaries(idMap: Map<string, number>) {
  const geojsonDir = path.join(process.cwd(), "data", "districts");
  const districtFiles = ["xuhui"];

  for (const districtKey of districtFiles) {
    const filePath = path.join(geojsonDir, `${districtKey}.geojson`);
    if (!existsSync(filePath)) continue;
    const fc: GeoJsonFC = JSON.parse(readFileSync(filePath, "utf-8"));
    console.log(`Seeding ${fc.features.length} boundaries for ${districtKey}...`);

    for (const feature of fc.features) {
      const schoolName = feature.properties.school;
      const schoolId = idMap.get(schoolName);
      if (!schoolId) {
        console.log(`  skip (no school): ${schoolName}`);
        continue;
      }
      await db.insert(schema.districtBoundaries).values({
        schoolId,
        year: feature.properties.year,
        geojson: feature.geometry,
        notes: feature.properties.verified ? "verified" : "PLACEHOLDER, redraw needed",
      });
      console.log(`  boundary inserted: ${schoolName} (${feature.properties.year})`);
    }
  }
}

async function seedPolicies(idMap: Map<string, number>) {
  const policyDir = path.join(process.cwd(), "data", "policies");
  if (!existsSync(policyDir)) return;
  const yearDirs = readdirSync(policyDir).filter((f) => /^\d{4}$/.test(f));

  for (const yearDir of yearDirs) {
    const dirPath = path.join(policyDir, yearDir);
    const files = readdirSync(dirPath).filter((f) => f.endsWith(".json"));

    for (const file of files) {
      const policy: DistrictPolicy = JSON.parse(readFileSync(path.join(dirPath, file), "utf-8"));
      await db.insert(schema.policies).values({
        scope: policy.scope,
        district: policy.district,
        year: policy.year,
        title: `${policy.documentNumber} ${policy.title}`,
        sourceUrl: policy.officialUrl,
        content: JSON.stringify(policy.keyRules, null, 2) + (policy._notes ? `\n\n备注：\n- ${policy._notes.join("\n- ")}` : ""),
        changeSummary: `Seeded from ${file}`,
      });
      console.log(`  policy inserted: ${policy.documentNumber} ${policy.title}`);
    }
  }

  // School-level policies derived from schools.json (each school's enrollmentNote)
  const schoolsPath = path.join(process.cwd(), "data", "schools.json");
  const schools: SchoolSeed[] = JSON.parse(readFileSync(schoolsPath, "utf-8"));
  for (const s of schools) {
    if (!s.enrollmentNote) continue;
    const schoolId = idMap.get(s.name);
    if (!schoolId) continue;
    const policyUrl = (s.attrs as { policy_url?: string } | undefined)?.policy_url;
    await db.insert(schema.policies).values({
      schoolId,
      scope: "school",
      district: s.district,
      year: 2025,
      title: `${s.name} 2025年招生方案（学校层面）`,
      sourceUrl: policyUrl,
      content: s.enrollmentNote,
      changeSummary: "Seeded from schools.json enrollmentNote",
    });
  }
}

type SchoolRow = {
  id: number;
  name: string;
  district: string;
  type: "primary" | "middle" | "nine_year";
  attrs: Record<string, unknown> | null;
};

type CommunityRow = {
  id: number;
  district: string;
  sourceCommittee: string | null;
  amapAddress: string | null;
  sourceDate: string;
};

function normalizeCommitteeName(name: string): string {
  return name
    .replace(/（部分）/g, "")
    .trim();
}

function normalizeSchoolName(name: string): string {
  return name
    .replace(/^上海市/, "")
    .replace(/^[\u4e00-\u9fa5]{1,4}区/, "")
    .replace(/（部分）/g, "")
    .replace(/[（）()]/g, "")
    .replace(/小学|校区/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function schoolAttrs<T extends Record<string, unknown>>(school: SchoolRow): T {
  return ((school.attrs ?? {}) as T);
}

async function seedSchoolCommunities() {
  const schoolsList: SchoolRow[] = await db
    .select({
      id: schema.schools.id,
      name: schema.schools.name,
      district: schema.schools.district,
      type: schema.schools.type,
      attrs: schema.schools.attrs,
    })
    .from(schema.schools);

  const communitiesList: CommunityRow[] = await db
    .select({
      id: schema.communities.id,
      district: schema.communities.district,
      sourceCommittee: schema.communities.sourceCommittee,
      amapAddress: schema.communities.amapAddress,
      sourceDate: schema.communities.sourceDate,
    })
    .from(schema.communities);

  if (communitiesList.length === 0) {
    console.log("No communities found; skip school-community links.");
    return;
  }

  const committeeToCommunities = new Map<string, CommunityRow[]>();
  for (const community of communitiesList) {
    if (!community.sourceCommittee) continue;
    const key = `${community.district}::${normalizeCommitteeName(community.sourceCommittee)}`;
    const list = committeeToCommunities.get(key) ?? [];
    list.push(community);
    committeeToCommunities.set(key, list);
  }

  let direct = 0;
  for (const school of schoolsList) {
    const attrs = schoolAttrs<{ matching_committees?: string[] }>(school);
    const committees = attrs.matching_committees ?? [];
    const seenCommunityIds = new Set<number>();

    for (const rawCommittee of committees) {
      const committee = normalizeCommitteeName(rawCommittee);
      const communities = committeeToCommunities.get(`${school.district}::${committee}`) ?? [];
      for (const community of communities) {
        if (seenCommunityIds.has(community.id)) continue;
        seenCommunityIds.add(community.id);

        await db.insert(schema.schoolCommunities).values({
          schoolId: school.id,
          communityId: community.id,
          committeeName: committee,
          year: 2025,
          sourceName: "amap_placesearch_via_committee",
          sourceUrl: "https://sh.bendibao.com/edu/202547/296230.shtm",
          sourceQuote: `对口居委 "${committee}" + 高德 POI 地址 "${community.amapAddress ?? ""}"`,
          sourceDate: community.sourceDate,
          verified: false,
          notes: "未核验。来源链：教育局对口居委表 → 高德 PlaceSearch 反查居委附近小区。可能漏小区或多挂小区。",
        });
        direct++;
      }
    }
  }

  const derived = await seedDerivedMiddleSchoolCommunities(schoolsList);
  console.log(`School-community links inserted: direct=${direct}, derived=${derived}.`);
}

async function seedDerivedMiddleSchoolCommunities(schoolsList: SchoolRow[]): Promise<number> {
  const schoolsByDistrict = new Map<string, SchoolRow[]>();
  for (const school of schoolsList) {
    const list = schoolsByDistrict.get(school.district) ?? [];
    list.push(school);
    schoolsByDistrict.set(school.district, list);
  }

  let derived = 0;
  for (const [district, districtSchools] of schoolsByDistrict.entries()) {
    const primarySchoolIndex = new Map<string, SchoolRow>();
    for (const school of districtSchools) {
      const attrs = schoolAttrs<{ shortName?: string }>(school);
      if (attrs.shortName) primarySchoolIndex.set(normalizeSchoolName(attrs.shortName), school);
      primarySchoolIndex.set(normalizeSchoolName(school.name), school);
    }

    const middleSchools = districtSchools.filter((school) => school.type === "middle");
    for (const middle of middleSchools) {
      const attrs = schoolAttrs<{ feeder_schools?: string[] }>(middle);
      const feeders = attrs.feeder_schools ?? [];
      if (feeders.length === 0) continue;

      const matchedPrimaryIds = new Set<number>();
      for (const feeder of feeders) {
        const matched = primarySchoolIndex.get(normalizeSchoolName(feeder));
        if (matched) matchedPrimaryIds.add(matched.id);
      }
      if (matchedPrimaryIds.size === 0) continue;

      const sourceLinks = await db
        .select()
        .from(schema.schoolCommunities)
        .where(eq(schema.schoolCommunities.year, 2025));
      const linksToCopy = sourceLinks.filter((link) => matchedPrimaryIds.has(link.schoolId));
      const copiedCommunityIds = new Set<number>();

      for (const link of linksToCopy) {
        if (copiedCommunityIds.has(link.communityId)) continue;
        copiedCommunityIds.add(link.communityId);

        await db.insert(schema.schoolCommunities).values({
          schoolId: middle.id,
          communityId: link.communityId,
          committeeName: `via ${link.committeeName ?? "?"}`,
          year: 2025,
          sourceName: "derived_via_feeder_school",
          sourceUrl: "https://www.shijiancn.com/zhengcezixun/63627.html",
          sourceQuote: `经由对口小学池继承小区，原居委 ${link.committeeName ?? "?"}`,
          sourceDate: link.sourceDate,
          verified: false,
          notes: `派生关系。若对口小学池本身有误，这里也会有误。district=${district}`,
        });
        derived++;
      }
    }
  }
  return derived;
}

async function main() {
  await clearAll();
  const idMap = await seedSchools();
  await seedSchoolCommunities();
  await seedBoundaries(idMap);
  await seedPolicies(idMap);
  console.log("Done.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
