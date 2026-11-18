ALTER TABLE `projects` ADD `role_models` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `model_source` text DEFAULT 'planner' NOT NULL;