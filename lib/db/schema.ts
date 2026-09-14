import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const catalogSchema = pgSchema("catalog");

export const schoolType = pgEnum("school_type", ["primary", "middle", "nine_year"]);
export const schoolNature = pgEnum("school_nature", ["公立", "私立"]);
export const pitRiskLevel = pgEnum("pit_risk_level", ["low", "medium", "high", "unknown"]);
export const policyScope = pgEnum("policy_scope", ["city", "district", "school"]);

export const schools = pgTable("schools", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  aliases: text("aliases").array().default([]),
  sourceKey: text("source_key"),
  sourceName: text("source_name"),
  sourceUrl: text("source_url"),
  sourceYear: integer("source_year"),
  sourceTier: integer("source_tier"),
  area: text("area"),
  street: text("street"),
  feederMiddleSchool: text("feeder_middle_school"),
  middleSchoolTier: integer("middle_school_tier"),
  evaluation: text("evaluation"),
  admissionMode: text("admission_mode"),
  classCount: integer("class_count"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  district: text("district").notNull(),
  tier: text("tier"),
  type: schoolType("type").notNull(),
  schoolNature: schoolNature("school_nature"),
  address: text("address"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  enrollmentNote: text("enrollment_note"),
  recentScoreLine: text("recent_score_line"),
  pitRiskLevel: pitRiskLevel("pit_risk_level").default("unknown"),
  attrs: jsonb("attrs").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  website: text("website"),
  studentCount: integer("student_count"),
  schoolScale: text("school_scale"),
  faculty: text("faculty"),
}, (t) => ({
  aliasesIdx: index("schools_aliases_gin_idx").using("gin", t.aliases),
}));

export const districtBoundaries = pgTable("district_boundaries", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").notNull().references(() => schools.id),
  year: integer("year").notNull(),
  geojson: jsonb("geojson").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// 政策唯一真源：public.policy_documents（2026-09-14 由 catalog 迁入 public——
// 政策是已发布事实，无"待审核政策"态，按 public=线上/catalog=采集待审核的边界归位；
// FK 仍指向 catalog.schools/catalog.districts）。由 lib/product/queries.ts
// getPolicies() 直连 SQL 读取，无 drizzle 定义。

export const schoolInfo = pgTable(
  "school_info",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().references(() => schools.id),
    category: text("category").notNull(),
    title: text("title"),
    content: text("content"),
    year: integer("year"),
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url"),
    sourceDate: text("source_date"),
    verified: boolean("verified").notNull().default(false),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    schoolIdIdx: index("school_info_school_id_idx").on(t.schoolId),
  }),
);

export type School = typeof schools.$inferSelect;
export type NewSchool = typeof schools.$inferInsert;
export type DistrictBoundary = typeof districtBoundaries.$inferSelect;
// Policy 类型已随 public.policies 删除（2026-09-14 B7）；产品层用 lib/product/queries.ts 的 ProductPolicy
export type SchoolInfo = typeof schoolInfo.$inferSelect;
export type NewSchoolInfo = typeof schoolInfo.$inferInsert;

export const communities = pgTable(
  "communities",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    district: text("district").notNull(),
    lng: doublePrecision("lng"),
    lat: doublePrecision("lat"),
    amapPoiId: text("amap_poi_id"),
    amapTypeCode: text("amap_type_code"),
    amapTypeName: text("amap_type_name"),
    amapAddress: text("amap_address"),
    sourceCommittee: text("source_committee"),
    sourceQuery: text("source_query"),
    sourceUrl: text("source_url"),
    sourceName: text("source_name").notNull(),
    sourceDate: text("source_date").notNull(),
    verified: boolean("verified").notNull().default(false),
    notes: text("notes"),
    attrs: jsonb("attrs").$type<Record<string, unknown>>(),
    osmPolygon: jsonb("osm_polygon").$type<{ type: "Polygon"; coordinates: number[][][] }>(),
    osmWayId: text("osm_way_id"),
    osmFetchedAt: text("osm_fetched_at"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    nameDistrictIdx: uniqueIndex("communities_name_district_idx").on(t.name, t.district),
  }),
);

export const schoolCommunities = pgTable(
  "school_communities",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().references(() => schools.id),
    communityId: integer("community_id").notNull().references(() => communities.id),
    committeeName: text("committee_name"),
    year: integer("year").notNull(),
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url"),
    sourceQuote: text("source_quote"),
    sourceDate: text("source_date").notNull(),
    verified: boolean("verified").notNull().default(false),
    notes: text("notes"),
  },
  (t) => ({
    uniqIdx: uniqueIndex("school_communities_uniq_idx").on(t.schoolId, t.communityId, t.year),
  }),
);

// 官方对口地段原文（2026-09-14 迁移 B6 从 public.school_community_candidates 迁入 catalog；
// 2026-09-14 由含义不明的 candidates 改名 official_enrollment_areas）。MapWorkspace 经 /api/school-community-candidates 消费。
export const officialEnrollmentAreas = catalogSchema.table("official_enrollment_areas", {
  id: serial("id").primaryKey(),
  schoolId: integer("school_id").references(() => schools.id),
  schoolNameRaw: text("school_name_raw").notNull(),
  district: text("district").notNull(),
  year: integer("year").notNull(),
  communityId: integer("community_id").references(() => communities.id),
  communityNameRaw: text("community_name_raw").notNull(),
  committeeNameRaw: text("committee_name_raw"),
  sourceUrl: text("source_url"),
  sourceTitle: text("source_title").notNull(),
  sourceDate: text("source_date"),
  sourceQuote: text("source_quote").notNull(),
  confidence: text("confidence").notNull().default("medium"),
  status: text("status").notNull().default("pending"),
  reviewNotes: text("review_notes"),
  raw: jsonb("raw").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
});

export const communityPriceSnapshots = pgTable(
  "community_price_snapshots",
  {
    id: serial("id").primaryKey(),
    communityId: integer("community_id").notNull().references(() => communities.id),
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourcePeriod: text("source_period").notNull(),
    unitPriceYuanPerSqm: integer("unit_price_yuan_per_sqm").notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniqIdx: uniqueIndex("community_price_snapshots_uniq_idx").on(
      t.communityId,
      t.sourceName,
      t.sourcePeriod,
    ),
  }),
);

export const communityPriceSources = pgTable(
  "community_price_sources",
  {
    id: serial("id").primaryKey(),
    communityId: integer("community_id").notNull().references(() => communities.id),
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceCommunityName: text("source_community_name"),
    sourceAddress: text("source_address"),
    active: boolean("active").notNull().default(true),
    notes: text("notes"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    uniqIdx: uniqueIndex("community_price_sources_uniq_idx").on(t.communityId, t.sourceName),
  }),
);

export const webDataSource = pgTable(
  "web_data_source",
  {
    id: serial("id").primaryKey(),
    schoolId: integer("school_id").notNull().references(() => schools.id),
    sourceType: text("source_type").notNull(),
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url"),
    sourceTitle: text("source_title"),
    sourceDate: text("source_date"),
    evidence: text("evidence"),
    confidence: text("confidence").notNull().default("high"),
    raw: jsonb("raw").$type<Record<string, unknown>>(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
  },
  (t) => ({
    schoolIdIdx: index("web_data_source_school_id_idx").on(t.schoolId),
    sourceUrlIdx: index("web_data_source_url_idx").on(t.sourceUrl),
    uniqIdx: uniqueIndex("web_data_source_school_url_type_idx").on(t.schoolId, t.sourceUrl, t.sourceType),
  }),
);

export type Community = typeof communities.$inferSelect;
export type SchoolCommunity = typeof schoolCommunities.$inferSelect;
export type OfficialEnrollmentArea = typeof officialEnrollmentAreas.$inferSelect;
export type NewOfficialEnrollmentArea = typeof officialEnrollmentAreas.$inferInsert;
export type CommunityPriceSnapshot = typeof communityPriceSnapshots.$inferSelect;
export type CommunityPriceSource = typeof communityPriceSources.$inferSelect;
export type WebDataSource = typeof webDataSource.$inferSelect;
export type NewWebDataSource = typeof webDataSource.$inferInsert;
