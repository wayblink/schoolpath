CREATE TABLE "school_info" (
	"id" serial PRIMARY KEY NOT NULL,
	"school_id" integer NOT NULL,
	"category" text NOT NULL,
	"title" text,
	"content" text,
	"year" integer,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_date" text,
	"verified" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now(),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "student_count" integer;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "school_scale" text;--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "faculty" text;--> statement-breakpoint
ALTER TABLE "school_info" ADD CONSTRAINT "school_info_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "school_info_school_id_idx" ON "school_info" USING btree ("school_id");