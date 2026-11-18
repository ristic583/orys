CREATE TABLE `sketches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`summary_json` text NOT NULL,
	`feedback` text,
	`direction` text,
	`run_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sketches_project_version` ON `sketches` (`project_id`,`version`);--> statement-breakpoint
ALTER TABLE `projects` ADD `sketch` integer DEFAULT false NOT NULL;