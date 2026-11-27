CREATE TABLE `fingerprint_history` (
	`key` text PRIMARY KEY NOT NULL,
	`first_used_at` integer NOT NULL
);
--> statement-breakpoint
-- Hardware emulado dos perfis existentes (inclusive na lixeira), no formato de `fingerprintKey`:
-- sistema|LxA|área útil LxA|cor|densidade|núcleos|memória|toque. Perfis nativos ficam de fora.
INSERT OR IGNORE INTO `fingerprint_history` (`key`, `first_used_at`)
SELECT `key`, MIN(`created_at`) FROM (
	SELECT
		json_extract(`fingerprint`, '$.os') || '|' ||
		json_extract(`fingerprint`, '$.screen.width') || 'x' || json_extract(`fingerprint`, '$.screen.height') || '|' ||
		json_extract(`fingerprint`, '$.screen.availWidth') || 'x' || json_extract(`fingerprint`, '$.screen.availHeight') || '|' ||
		json_extract(`fingerprint`, '$.screen.colorDepth') || '|' ||
		json_extract(`fingerprint`, '$.screen.pixelRatio') || '|' ||
		json_extract(`fingerprint`, '$.navigator.hardwareConcurrency') || '|' ||
		COALESCE(json_extract(`fingerprint`, '$.navigator.deviceMemory'), 'brave') || '|' ||
		json_extract(`fingerprint`, '$.navigator.maxTouchPoints') AS `key`,
		`created_at`
	FROM `profiles`
	WHERE COALESCE(json_extract(`fingerprint`, '$.mode'), 'emulated') <> 'native'
)
WHERE `key` IS NOT NULL
GROUP BY `key`;
