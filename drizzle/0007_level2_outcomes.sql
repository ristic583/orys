ALTER TABLE `phases` ADD `goal_plain` text;--> statement-breakpoint
ALTER TABLE `phases` ADD `visible` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `outcome_json` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `process_json` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `design_choice` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `handoff_json` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `accepted` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `returns` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `size` text;