CREATE TABLE `communities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`district` text NOT NULL,
	`lng` real,
	`lat` real,
	`amap_poi_id` text,
	`amap_type_code` text,
	`amap_type_name` text,
	`amap_address` text,
	`source_committee` text,
	`source_query` text,
	`source_url` text,
	`source_name` text NOT NULL,
	`source_date` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`notes` text,
	`attrs` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `communities_name_district_idx` ON `communities` (`name`,`district`);--> statement-breakpoint
CREATE TABLE `school_communities` (
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
	FOREIGN KEY (`school_id`) REFERENCES `schools`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`community_id`) REFERENCES `communities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `school_communities_uniq_idx` ON `school_communities` (`school_id`,`community_id`,`year`);