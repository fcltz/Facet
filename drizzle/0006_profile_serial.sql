CREATE TABLE `counters` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer NOT NULL
);
--> statement-breakpoint
-- O SQLite só adiciona coluna NOT NULL com valor padrão; o número de cada perfil vem a seguir.
ALTER TABLE `profiles` ADD `serial` integer NOT NULL DEFAULT 0;--> statement-breakpoint
-- Perfis existentes (inclusive os da lixeira): 1, 2, 3… pela ordem de criação; empate pelo id.
UPDATE `profiles` SET `serial` = `numbered`.`n`
FROM (SELECT `id`, ROW_NUMBER() OVER (ORDER BY `created_at`, `id`) AS `n` FROM `profiles`) AS `numbered`
WHERE `profiles`.`id` = `numbered`.`id`;--> statement-breakpoint
CREATE UNIQUE INDEX `profiles_serial_unique` ON `profiles` (`serial`);--> statement-breakpoint
INSERT INTO `counters` (`name`, `value`) SELECT 'profile_serial', COALESCE(MAX(`serial`), 0) FROM `profiles`;
