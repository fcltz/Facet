CREATE TABLE `pending_cookies` (
	`profile_id` text PRIMARY KEY NOT NULL,
	`cookies_enc` blob NOT NULL,
	`count` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
