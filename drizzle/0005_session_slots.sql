CREATE TABLE `session_slots` (
	`id` text PRIMARY KEY NOT NULL,
	`idx` integer NOT NULL,
	`project_id` text,
	`session_id` text,
	`context_tokens` integer DEFAULT 0 NOT NULL,
	`runs` integer DEFAULT 0 NOT NULL,
	`rotations` integer DEFAULT 0 NOT NULL,
	`assigned_at` integer,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_slots_idx` ON `session_slots` (`idx`);--> statement-breakpoint
CREATE UNIQUE INDEX `session_slots_project` ON `session_slots` (`project_id`);--> statement-breakpoint
ALTER TABLE `runs` ADD `context_tokens` integer DEFAULT 0 NOT NULL;