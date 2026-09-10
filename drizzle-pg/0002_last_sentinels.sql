CREATE TABLE "community_price_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"community_id" integer NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text NOT NULL,
	"source_community_name" text,
	"source_address" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "community_price_sources" ADD CONSTRAINT "community_price_sources_community_id_communities_id_fk" FOREIGN KEY ("community_id") REFERENCES "public"."communities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "community_price_sources_uniq_idx" ON "community_price_sources" USING btree ("community_id","source_name");