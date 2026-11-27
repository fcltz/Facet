CREATE TABLE `extensions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`manifest_version` integer NOT NULL,
	`source` text NOT NULL,
	`public_key` text NOT NULL,
	`dir_name` text NOT NULL,
	`icon` text,
	`permissions` text DEFAULT '[]' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`config_enc` blob,
	`config_area` text,
	`config_mode` text,
	`config_keys` integer,
	`config_revision` integer DEFAULT 0 NOT NULL,
	`config_updated_at` integer,
	`size_bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "extensions_source_check" CHECK("extensions"."source" in ('webstore', 'crx', 'zip', 'folder')),
	CONSTRAINT "extensions_manifest_check" CHECK("extensions"."manifest_version" in (2, 3))
);
--> statement-breakpoint
CREATE INDEX `extensions_default_idx` ON `extensions` (`is_default`);--> statement-breakpoint
CREATE TABLE `profile_extensions` (
	`profile_id` text NOT NULL,
	`extension_id` text NOT NULL,
	`added_at` integer NOT NULL,
	`first_loaded_at` integer,
	`config_revision` integer,
	`config_applied_at` integer,
	`config_error` text,
	PRIMARY KEY(`profile_id`, `extension_id`),
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`extension_id`) REFERENCES `extensions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_extensions_extension_idx` ON `profile_extensions` (`extension_id`);--> statement-breakpoint
ALTER TABLE `profile_sessions` ADD `extension_dirs` text;