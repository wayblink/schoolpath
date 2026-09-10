CREATE TYPE "public"."pit_risk_level" AS ENUM('low', 'medium', 'high', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."policy_scope" AS ENUM('city', 'district', 'school');--> statement-breakpoint
CREATE TYPE "public"."school_type" AS ENUM('primary', 'middle', 'nine_year');--> statement-breakpoint
CREATE TABLE "communities" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"district" text NOT NULL,
	"lng" double precision,
	"lat" double precision,
	"amap_poi_id" text,
	"amap_type_code" text,
	"amap_type_name" text,
	"amap_address" text,
	"source_committee" text,
	"source_query" text,
	"source_url" text,
	"source_name" text NOT NULL,
	"source_date" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"notes" text,
	"attrs" jsonb,
	"osm_polygon" jsonb,
	"osm_way_id" text,
	"osm_fetched_at" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "district_boundaries" (
	"id" serial PRIMARY KEY NOT NULL,
	"school_id" integer NOT NULL,
	"year" integer NOT NULL,
	"geojson" jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"school_id" integer,
	"scope" "policy_scope" NOT NULL,
	"district" text,
	"year" integer NOT NULL,
	"title" text NOT NULL,
	"source_url" text,
	"content" text NOT NULL,
	"change_summary" text,
	"fetched_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "school_communities" (
	"id" serial PRIMARY KEY NOT NULL,
	"school_id" integer NOT NULL,
	"community_id" integer NOT NULL,
	"committee_name" text,
	"year" integer NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_quote" text,
	"source_date" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"district" text NOT NULL,
	"tier" text,
	"type" "school_type" NOT NULL,
	"address" text,
	"lat" double precision,
	"lng" double precision,
	"enrollment_note" text,
	"recent_score_line" text,
	"pit_risk_level" "pit_risk_level" DEFAULT 'unknown',
	"attrs" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "district_boundaries" ADD CONSTRAINT "district_boundaries_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_communities" ADD CONSTRAINT "school_communities_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_communities" ADD CONSTRAINT "school_communities_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "communities_name_district_idx" ON "communities" USING btree ("name","district");--> statement-breakpoint
CREATE UNIQUE INDEX "school_communities_uniq_idx" ON "school_communities" USING btree ("school_id","community_id","year");