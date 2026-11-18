CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`phase_id` text,
	`task_id` text,
	`run_id` text,
	`target` text NOT NULL,
	`kind` text NOT NULL,
	`rationale` text NOT NULL,
	`feedback` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`phase_id`) REFERENCES `phases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `decisions_project_idx` ON `decisions` (`project_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_project_created_idx` ON `events` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `features` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` integer DEFAULT 3 NOT NULL,
	`deadline` integer,
	`status` text DEFAULT 'planned' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `features_project_idx` ON `features` (`project_id`);--> statement-breakpoint
CREATE TABLE `limit_state` (
	`id` text PRIMARY KEY DEFAULT 'global' NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`rate_limit_type` text,
	`utilization` real,
	`reset_at` integer,
	`detected_at` integer,
	`source_text` text,
	`last_probe_at` integer,
	`auth_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `phases` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`idx` integer NOT NULL,
	`title` text NOT NULL,
	`goal` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`branch` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `phases_project_idx` ON `phases` (`project_id`,`idx`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`problem` text NOT NULL,
	`aspects` text DEFAULT '[]' NOT NULL,
	`constraints` text DEFAULT '[]' NOT NULL,
	`priority` integer DEFAULT 3 NOT NULL,
	`profile` text DEFAULT 'balanced' NOT NULL,
	`deadline` integer,
	`runner` text DEFAULT 'local' NOT NULL,
	`repo_path` text NOT NULL,
	`worker_permission_mode` text DEFAULT 'bypassPermissions' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`blocked_from` text,
	`blocked_reason` text,
	`paused` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`phase_id` text,
	`task_id` text,
	`kind` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`session_id` text,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`exit_code` integer,
	`is_error` integer,
	`error_kind` text,
	`result_text` text,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_creation_tokens` integer DEFAULT 0 NOT NULL,
	`num_turns` integer DEFAULT 0 NOT NULL,
	`log_path` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`phase_id`) REFERENCES `phases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `runs_project_started_idx` ON `runs` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`phase_id` text NOT NULL,
	`feature_id` text,
	`idx` integer NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`spec` text NOT NULL,
	`acceptance` text DEFAULT '[]' NOT NULL,
	`verify_commands` text DEFAULT '[]' NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`model` text,
	`effort` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`session_id` text,
	`last_feedback` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`phase_id`) REFERENCES `phases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_phase_idx` ON `tasks` (`phase_id`,`idx`);--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`command` text NOT NULL,
	`exit_code` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`output_tail` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `verifications_task_idx` ON `verifications` (`task_id`);