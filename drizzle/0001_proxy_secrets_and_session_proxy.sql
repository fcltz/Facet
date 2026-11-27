ALTER TABLE `proxies` ADD `change_ip_url_enc` blob;--> statement-breakpoint
ALTER TABLE `proxies` ADD `change_ip_host` text;--> statement-breakpoint
ALTER TABLE `proxies` ADD `last_error_code` text;--> statement-breakpoint
ALTER TABLE `profile_sessions` ADD `proxy_id` text;--> statement-breakpoint
ALTER TABLE `profile_sessions` ADD `local_proxy_port` integer;