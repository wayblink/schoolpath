CREATE TABLE "community_price_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text NOT NULL,
	"source_period" text NOT NULL,
	"unit_price_yuan_per_sqm" integer NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "community_price_snapshots" ADD CONSTRAINT "community_price_snapshots_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_price_snapshots_uniq_idx" ON "community_price_snapshots" USING btree ("community_id","source_name","source_period");