PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `district_boundaries_no_cascade` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`year` integer NOT NULL,
	`geojson` text NOT NULL,
	`notes` text,
	`created_at` integer,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `district_boundaries_no_cascade` (`id`, `school_id`, `year`, `geojson`, `notes`, `created_at`)
SELECT `id`, `school_id`, `year`, `geojson`, `notes`, `created_at`
FROM `district_boundaries`;
--> statement-breakpoint
DROP TABLE `district_boundaries`;
--> statement-breakpoint
ALTER TABLE `district_boundaries_no_cascade` RENAME TO `district_boundaries`;
--> statement-breakpoint
CREATE TABLE `policies_no_cascade` (
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
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `policies_no_cascade` (`id`, `school_id`, `scope`, `district`, `year`, `title`, `source_url`, `content`, `change_summary`, `fetched_at`)
SELECT `id`, `school_id`, `scope`, `district`, `year`, `title`, `source_url`, `content`, `change_summary`, `fetched_at`
FROM `policies`;
--> statement-breakpoint
DROP TABLE `policies`;
--> statement-breakpoint
ALTER TABLE `policies_no_cascade` RENAME TO `policies`;
--> statement-breakpoint
CREATE TABLE `school_communities_no_cascade` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`school_id` integer NOT NULL,
	`community_id` integer NOT NULL,
	`committee_name` text,
	`year` integer NOT NULL,
	`source_name` text NOT NULL,
	`source_url` text,
	`source_quote` text,
	`source_date` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`notes` text,
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `school_communities_no_cascade` (
	`id`,
	`school_id`,
	`community_id`,
	`committee_name`,
	`year`,
	`source_name`,
	`source_url`,
	`source_quote`,
	`source_date`,
	`verified`,
	`notes`
)
SELECT
	`id`,
	`school_id`,
	`community_id`,
	`committee_name`,
	`year`,
	`source_name`,
	`source_url`,
	`source_quote`,
	`source_date`,
	`verified`,
	`notes`
FROM `school_communities`;
--> statement-breakpoint
DROP TABLE `school_communities`;
--> statement-breakpoint
ALTER TABLE `school_communities_no_cascade` RENAME TO `school_communities`;
--> statement-breakpoint
CREATE UNIQUE INDEX `school_communities_uniq_idx` ON `school_communities` (`school_id`,`community_id`,`year`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
