PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_extensions` (
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
	CONSTRAINT "extensions_source_check" CHECK("__new_extensions"."source" in ('webstore', 'crx', 'zip', 'folder', 'builtin')),
	CONSTRAINT "extensions_manifest_check" CHECK("__new_extensions"."manifest_version" in (2, 3))
);
--> statement-breakpoint
INSERT INTO `__new_extensions`("id", "name", "version", "description", "manifest_version", "source", "public_key", "dir_name", "icon", "permissions", "is_default", "config_enc", "config_area", "config_mode", "config_keys", "config_revision", "config_updated_at", "size_bytes", "created_at", "updated_at") SELECT "id", "name", "version", "description", "manifest_version", "source", "public_key", "dir_name", "icon", "permissions", "is_default", "config_enc", "config_area", "config_mode", "config_keys", "config_revision", "config_updated_at", "size_bytes", "created_at", "updated_at" FROM `extensions`;--> statement-breakpoint
DROP TABLE `extensions`;--> statement-breakpoint
ALTER TABLE `__new_extensions` RENAME TO `extensions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `extensions_default_idx` ON `extensions` (`is_default`);