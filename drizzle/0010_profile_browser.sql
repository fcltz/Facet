PRAGMA foreign_keys=OFF;--> statement-breakpoint
-- Perfis existentes foram todos criados no Brave (o único navegador até aqui); o CHECK do
-- sistema passa a aceitar Android e iOS. Recriação da tabela: o SQLite não altera CHECK.
CREATE TABLE `__new_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`serial` integer NOT NULL,
	`name` text NOT NULL,
	`group_id` text,
	`proxy_id` text,
	`color` text,
	`notes` text NOT NULL,
	`browser` text DEFAULT 'brave' NOT NULL,
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
	CONSTRAINT "profiles_os_check" CHECK("__new_profiles"."os" in ('windows', 'macos', 'linux', 'android', 'ios')),
	CONSTRAINT "profiles_browser_check" CHECK("__new_profiles"."browser" in ('ungoogled', 'chrome', 'brave', 'opera'))
);
--> statement-breakpoint
INSERT INTO `__new_profiles`("id", "serial", "name", "group_id", "proxy_id", "color", "notes", "browser", "os", "user_agent", "fingerprint", "launch_options", "last_urls", "last_opened_at", "last_closed_at", "open_count", "deleted_at", "created_at", "updated_at") SELECT "id", "serial", "name", "group_id", "proxy_id", "color", "notes", 'brave', "os", "user_agent", "fingerprint", "launch_options", "last_urls", "last_opened_at", "last_closed_at", "open_count", "deleted_at", "created_at", "updated_at" FROM `profiles`;--> statement-breakpoint
DROP TABLE `profiles`;--> statement-breakpoint
ALTER TABLE `__new_profiles` RENAME TO `profiles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `profiles_deleted_idx` ON `profiles` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `profiles_group_idx` ON `profiles` (`group_id`);--> statement-breakpoint
CREATE INDEX `profiles_proxy_idx` ON `profiles` (`proxy_id`);--> statement-breakpoint
CREATE INDEX `profiles_opened_idx` ON `profiles` (`last_opened_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_serial_unique` ON `profiles` (`serial`);