import type { DatabaseConnection } from '../../db/client'
import type { SecretBox } from '../../security/secrets'
import type { Repositories } from '../types'
import type { AppSettings } from '@shared/schemas/settings'
import { SqliteProfileRepository } from './profiles'
import { SqliteGroupRepository } from './groups'
import { SqliteTagRepository } from './tags'
import { SqliteProxyRepository } from './proxies'
import { SqliteExtensionRepository } from './extensions'
import { SqliteSettingsRepository } from './settings'
import { SqlitePendingCookieRepository } from './pending-cookies'

export function createSqliteRepositories(
  connection: DatabaseConnection,
  legacySettingsFile: string,
  secrets: SecretBox,
  /** Configurações de uma instalação nova (ex.: idioma do sistema). */
  initialSettings: Partial<AppSettings> = {},
): Repositories {
  return {
    transaction: (action) => connection.sqlite.transaction(action)(),
    profiles: new SqliteProfileRepository(connection),
    groups: new SqliteGroupRepository(connection.db),
    tags: new SqliteTagRepository(connection.db),
    proxies: new SqliteProxyRepository(connection.db, secrets),
    extensions: new SqliteExtensionRepository(connection.db, secrets),
    settings: new SqliteSettingsRepository(connection, legacySettingsFile, initialSettings),
    pendingCookies: new SqlitePendingCookieRepository(connection.db, secrets),
  }
}
