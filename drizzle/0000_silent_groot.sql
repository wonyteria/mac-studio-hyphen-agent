CREATE TABLE `ops_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`risk` text NOT NULL,
	`result` text,
	`worker_log` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`claimed_at` integer,
	`completed_at` integer
);
