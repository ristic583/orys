ALTER TABLE `projects` ADD `mode` text DEFAULT 'scratch' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `mode_details` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `base_branch` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `integration_branch` text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `owner_gate` text;