CREATE TABLE `groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`color` text NOT NULL,
	`sort_order` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `groups_name_key_unique` ON `groups` (`name_key`);--> statement-breakpoint
CREATE TABLE `profile_tags` (
	`profile_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `tag_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_tags_tag_idx` ON `profile_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`group_id` text,
	`proxy_id` text,
	`color` text,
	`notes` text NOT NULL,
	`os` text NOT NULL,
	`user_agent` text NOT NULL,
	`fingerprint` text NOT NULL,
	`launch_options` text NOT NULL,
	`last_urls` text DEFAULT '[]' NOT NULL,
	`last_opened_at` integer,
	`last_closed_at` integer,
	`open_count` integer DEFAULT 0 NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `groups`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`proxy_id`) REFERENCES `proxies`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "profiles_os_check" CHECK("profiles"."os" in ('windows', 'macos', 'linux'))
);
--> statement-breakpoint
CREATE INDEX `profiles_deleted_idx` ON `profiles` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `profiles_group_idx` ON `profiles` (`group_id`);--> statement-breakpoint
CREATE INDEX `profiles_proxy_idx` ON `profiles` (`proxy_id`);--> statement-breakpoint
CREATE INDEX `profiles_opened_idx` ON `profiles` (`last_opened_at`);--> statement-breakpoint
CREATE TABLE `proxies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`type` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`username` text DEFAULT '' NOT NULL,
	`password_enc` blob,
	`change_ip_url` text,
	`notes` text DEFAULT '' NOT NULL,
	`check_status` text DEFAULT 'unknown' NOT NULL,
	`checked_at` integer,
	`latency_ms` integer,
	`exit_ip` text,
	`country_code` text,
	`country_name` text,
	`region` text,
	`city` text,
	`timezone` text,
	`latitude` real,
	`longitude` real,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "proxy_port_check" CHECK("proxies"."port" between 1 and 65535),
	CONSTRAINT "proxy_type_check" CHECK("proxies"."type" in ('http', 'https', 'socks5'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `proxy_endpoint_idx` ON `proxies` (`type`,`host`,`port`,`username`);--> statement-breakpoint
CREATE TABLE `profile_sessions` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`pid` integer,
	`process_started_at` text,
	`executable_path` text NOT NULL,
	`user_data_dir` text NOT NULL,
	`cdp_port` integer,
	`ws_endpoint` text,
	`engine_version` text,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_key_unique` ON `tags` (`name_key`);