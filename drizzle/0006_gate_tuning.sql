ALTER TABLE `phases` ADD `verify_commands` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `verifications` ADD `baseline` integer DEFAULT false NOT NULL;