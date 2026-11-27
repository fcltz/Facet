import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { applyMigrations } from './migrate'

export function openDatabase(filename: string, migrationsFolder: string) {
  const sqlite = new Database(filename, { timeout: 5000 })
  try {
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('synchronous = FULL')
    const db = drizzle(sqlite, { schema })
    /** Referências quebradas depois das migrations (esperado: 0; o container registra no log). */
    const brokenReferences = applyMigrations(sqlite, db, migrationsFolder)
    return { sqlite, db, brokenReferences, close: () => sqlite.close() }
  } catch (error) {
    sqlite.close()
    throw error
  }
}
export type DatabaseConnection = ReturnType<typeof openDatabase>
export type AppDatabase = DatabaseConnection['db']
