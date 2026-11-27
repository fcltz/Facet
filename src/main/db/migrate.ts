import type Database from 'better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { AppDatabase } from './client'

/**
 * Aplica as migrations com as chaves estrangeiras desligadas, como o SQLite recomenda para
 * recriar tabelas (https://www.sqlite.org/lang_altertable.html#otheralter). O migrator roda
 * tudo numa transação, e dentro dela `PRAGMA foreign_keys` não tem efeito: sem desligar antes,
 * o DROP TABLE de uma recriação (ex.: 0009, `extensions`) apagaria em cascata as linhas que
 * apontam para a tabela (os vínculos perfil–extensão).
 *
 * Devolve quantas referências ficaram quebradas (esperado: 0). Não lança: a migration já foi
 * gravada, e recusar abrir o banco deixaria o app sem iniciar a cada tentativa.
 */
export function applyMigrations(
  sqlite: Database.Database,
  db: AppDatabase,
  migrationsFolder: string,
): number {
  sqlite.pragma('foreign_keys = OFF')
  try {
    migrate(db, { migrationsFolder })
    return (sqlite.pragma('foreign_key_check') as unknown[]).length
  } finally {
    sqlite.pragma('foreign_keys = ON')
  }
}
