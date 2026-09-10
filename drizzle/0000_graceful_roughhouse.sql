CREATE TABLE `district_boundaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`year` integer NOT NULL,
	`geojson` text NOT NULL,
	`notes` text,
	`created_at` integer,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `policies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer,
	`scope` text NOT NULL,
	`district` text,
	`year` integer NOT NULL,
	`title` text NOT NULL,
	`source_url` text,
	`content` text NOT NULL,
	`change_summary` text,
	`fetched_at` integer,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `schools` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`district` text NOT NULL,
	`tier` text,
	`type` text NOT NULL,
	`address` text,
	`lat` real,
	`lng` real,
	`enrollment_note` text,
	`recent_score_line` text,
	`pit_risk_level` text DEFAULT 'unknown',
	`attrs` text,
	`created_at` integer,
	`updated_at` integer
);
