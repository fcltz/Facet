-- Até aqui, as verificações de proxy faziam as requisições HTTPS fora do túnel: o IP e o local
-- gravados eram os desta máquina, e todo proxy acabava marcado como "IP real". Os resultados são
-- descartados; cada proxy volta a "não verificado" até a próxima verificação.
UPDATE `proxies` SET
	`check_status` = 'unknown',
	`checked_at` = NULL,
	`latency_ms` = NULL,
	`exit_ip` = NULL,
	`country_code` = NULL,
	`country_name` = NULL,
	`region` = NULL,
	`city` = NULL,
	`timezone` = NULL,
	`latitude` = NULL,
	`longitude` = NULL,
	`last_error` = NULL,
	`last_error_code` = NULL;
