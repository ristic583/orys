ALTER TABLE `projects` ADD `workspace` text DEFAULT 'in_place' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `source_path` text;