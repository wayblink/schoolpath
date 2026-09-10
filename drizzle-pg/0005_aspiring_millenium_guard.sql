ALTER TABLE "schools" ADD COLUMN "aliases" text[] DEFAULT '{}';--> statement-breakpoint
UPDATE "schools"
SET "aliases" = ARRAY(
	SELECT DISTINCT alias
	FROM jsonb_array_elements_text("schools"."attrs"->'aliases') AS alias
	WHERE btrim(alias) <> ''
)
WHERE "attrs" ? 'aliases'
	AND jsonb_typeof("attrs"->'aliases') = 'array';--> statement-breakpoint
CREATE INDEX "schools_aliases_gin_idx" ON "schools" USING gin ("aliases");
