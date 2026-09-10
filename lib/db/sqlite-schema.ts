import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";

export const schools = sqliteTable("schools", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  aliases: text("aliases", { mode: "json" }).$type<string[]>().$defaultFn(() => []),
  district: text("district").notNull(),
  tier: text("tier"),
  type: text("type", { enum: ["primary", "middle", "nine_year"] }).notNull(),
  address: text("address"),
  lat: real("lat"),
  lng: real("lng"),
  enrollmentNote: text("enrollment_note"),
  recentScoreLine: text("recent_score_line"),
  pitRiskLevel: text("pit_risk_level", { enum: ["low", "medium", "high", "unknown"] }).default("unknown"),
  attrs: text("attrs", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const districtBoundaries = sqliteTable("district_boundaries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id").notNull().references(() => schools.id),
  year: integer("year").notNull(),
  geojson: text("geojson", { mode: "json" }).notNull(),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const policies = sqliteTable("policies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  schoolId: integer("school_id").references(() => schools.id),
  scope: text("scope", { enum: ["city", "district", "school"] }).notNull(),
  district: text("district"),
  year: integer("year").notNull(),
  title: text("title").notNull(),
  sourceUrl: text("source_url"),
  content: text("content").notNull(),
  changeSummary: text("change_summary"),
  fetchedAt: integer("fetched_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const communities = sqliteTable(
  "communities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    district: text("district").notNull(),
    lng: real("lng"),
    lat: real("lat"),
    amapPoiId: text("amap_poi_id"),
    amapTypeCode: text("amap_type_code"),
    amapTypeName: text("amap_type_name"),
    amapAddress: text("amap_address"),
    sourceCommittee: text("source_committee"),
    sourceQuery: text("source_query"),
    sourceUrl: text("source_url"),
    sourceName: text("source_name").notNull(),
    sourceDate: text("source_date").notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
    attrs: text("attrs", { mode: "json" }).$type<Record<string, unknown>>(),
    osmPolygon: text("osm_polygon", { mode: "json" }).$type<{ type: "Polygon"; coordinates: number[][][] }>(),
    osmWayId: text("osm_way_id"),
    osmFetchedAt: text("osm_fetched_at"),
    createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  },
  (t) => ({
    nameDistrictIdx: uniqueIndex("communities_name_district_idx").on(t.name, t.district),
  }),
);

export const schoolCommunities = sqliteTable(
  "school_communities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    schoolId: integer("school_id").notNull().references(() => schools.id),
    communityId: integer("community_id").notNull().references(() => communities.id),
    committeeName: text("committee_name"),
    year: integer("year").notNull(),
    sourceName: text("source_name").notNull(),
    sourceUrl: text("source_url"),
    sourceQuote: text("source_quote"),
    sourceDate: text("source_date").notNull(),
    verified: integer("verified", { mode: "boolean" }).notNull().default(false),
    notes: text("notes"),
  },
  (t) => ({
    uniqIdx: uniqueIndex("school_communities_uniq_idx").on(t.schoolId, t.communityId, t.year),
  }),
);
