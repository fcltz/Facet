import fs from 'node:fs'
import path from 'node:path'
import { appSettingsSchema, DEFAULT_SETTINGS, type AppSettings } from '@shared/schemas/settings'
import type { Logger } from '../logger'
import type { SettingsRepository } from './types'

/**
 * Configurações persistidas em JSON até a chegada do SQLite (Etapa 2), quando
 * este arquivo é importado para a tabela `settings`. Chaves inválidas ou
 * ausentes caem no padrão, então um arquivo corrompido nunca impede o app de abrir.
 */
export class JsonSettingsRepository implements SettingsRepository {
  constructor(
    private readonly filePath: string,
    private readonly logger?: Logger,
  ) {}

  load(): AppSettings {
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger?.warn('settings.json ilegível; usando padrões', error)
      }
      return { ...DEFAULT_SETTINGS }
    }
    const settings: AppSettings = { ...DEFAULT_SETTINGS }
    if (typeof raw === 'object' && raw !== null) {
      const shape = appSettingsSchema.shape
      for (const key of Object.keys(shape) as (keyof AppSettings)[]) {
        const parsed = shape[key].safeParse((raw as Record<string, unknown>)[key])
        if (parsed.success) Object.assign(settings, { [key]: parsed.data })
      }
    }
    return settings
  }

  save(settings: AppSettings): void {
    const valid = appSettingsSchema.parse(settings)
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, this.filePath)
  }
}
