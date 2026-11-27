import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import type { DatabaseConnection } from '../../db/client'
import { settings } from '../../db/schema'
import { JsonSettingsRepository } from '../json-settings.repository'
import type { SettingsRepository } from '../types'
import { appSettingsSchema, DEFAULT_SETTINGS, type AppSettings } from '@shared/schemas/settings'

export class SqliteSettingsRepository implements SettingsRepository {
  /**
   * @param initial valores de uma instalação nova (ex.: o idioma do sistema); não valem para quem
   * já tinha configurações.
   */
  constructor(
    private readonly connection: DatabaseConnection,
    legacyFile: string,
    initial: Partial<AppSettings> = {},
  ) {
    const { db, sqlite } = connection
    const has = (key: string): boolean =>
      db.select().from(settings).where(eq(settings.key, key)).get() !== undefined
    const insert = (key: string, value: unknown): void => {
      db.insert(settings).values({ key, value, updatedAt: Date.now() }).onConflictDoNothing().run()
    }
    sqlite.transaction(() => {
      if (!has('_legacyImported')) {
        // Banco novo: traz as configurações do arquivo JSON das primeiras versões, se existir.
        const upgrading = fs.existsSync(legacyFile)
        const values: AppSettings = upgrading
          ? { ...new JsonSettingsRepository(legacyFile).load(), onboardingCompleted: true }
          : { ...DEFAULT_SETTINGS, ...initial }
        for (const [key, value] of Object.entries(values)) insert(key, value)
        insert('_legacyImported', true)
      } else if (!has('onboardingCompleted')) {
        // Banco de uma versão anterior à tela de boas-vindas: o Facet já estava configurado.
        insert('onboardingCompleted', true)
      }
    })()
  }

  load(): AppSettings {
    const result = { ...DEFAULT_SETTINGS }
    let legacyBrowserPath: unknown = null
    let hasBrowserPaths = false
    for (const row of this.connection.db.select().from(settings).all()) {
      // Antes de haver vários navegadores, só o executável do Brave era configurável.
      if (row.key === 'browserPath') legacyBrowserPath = row.value
      if (row.key === 'browserPaths') hasBrowserPaths = true
      const key = row.key as keyof AppSettings
      const validator = appSettingsSchema.shape[key]
      if (!validator) continue
      const parsed = validator.safeParse(row.value)
      if (parsed.success) Object.assign(result, { [key]: parsed.data })
    }
    if (!hasBrowserPaths && typeof legacyBrowserPath === 'string' && legacyBrowserPath.length <= 4096)
      result.browserPaths = { ...result.browserPaths, brave: legacyBrowserPath }
    return result
  }

  save(value: AppSettings): void {
    const parsed = appSettingsSchema.parse(value)
    this.connection.sqlite.transaction(() => {
      for (const [key, entry] of Object.entries(parsed)) {
        const row = { key, value: entry, updatedAt: Date.now() }
        this.connection.db
          .insert(settings)
          .values(row)
          .onConflictDoUpdate({ target: settings.key, set: row })
          .run()
      }
    })()
  }
}
