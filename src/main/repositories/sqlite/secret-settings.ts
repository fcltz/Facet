import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../../db/client'
import { settings } from '../../db/schema'
import type { SecretBox } from '../../security/secrets'

export type SecretSettingKey = 'geoIpToken'

/** Prefixo das chaves cifradas: o repositório de configurações comum ignora estas linhas. */
const PREFIX = 'secret.'

/**
 * Segredos de configuração (token do provedor de geo-IP), cifrados com o
 * SecretBox e gravados em base64 na tabela `settings`. O valor decifrado nunca
 * vai ao renderer: a interface só sabe se existe um token salvo.
 */
export class SecretSettingsRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly box: SecretBox,
  ) {}

  has(key: SecretSettingKey): boolean {
    return this.row(key) !== null
  }

  get(key: SecretSettingKey): string | null {
    const value = this.row(key)
    return value === null ? null : this.box.decrypt(Buffer.from(value, 'base64'))
  }

  set(key: SecretSettingKey, value: string | null): void {
    const id = PREFIX + key
    if (value === null) {
      this.db.delete(settings).where(eq(settings.key, id)).run()
      return
    }
    const row = { key: id, value: this.box.encrypt(value).toString('base64'), updatedAt: Date.now() }
    this.db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row }).run()
  }

  private row(key: SecretSettingKey): string | null {
    const row = this.db
      .select()
      .from(settings)
      .where(eq(settings.key, PREFIX + key))
      .get()
    return row && typeof row.value === 'string' ? row.value : null
  }
}
