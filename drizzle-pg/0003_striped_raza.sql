CREATE TYPE "public"."school_nature" AS ENUM('公立', '私立');--> statement-breakpoint
ALTER TABLE "schools" ADD COLUMN "school_nature" "school_nature";