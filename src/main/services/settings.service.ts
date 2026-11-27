import type { EmitFn } from '@shared/ipc/events'
import { appSettingsSchema, type AppSettings, type SettingsPatch } from '@shared/schemas/settings'
import type { SettingsRepository } from '../repositories/types'

export interface SettingsServiceDeps {
  repo: SettingsRepository
  emit: EmitFn
}

export class SettingsService {
  private current: AppSettings
  private readonly listeners = new Set<(settings: AppSettings) => void>()

  constructor(private readonly deps: SettingsServiceDeps) {
    this.current = deps.repo.load()
  }

  get(): AppSettings {
    return { ...this.current }
  }

  update(patch: SettingsPatch): AppSettings {
    return this.apply(patch)
  }

  /** Só o processo principal: pasta dos perfis e estado do backup (o renderer não edita). */
  setInternal(patch: Partial<AppSettings>): AppSettings {
    return this.apply(patch)
  }

  private apply(patch: Partial<AppSettings>): AppSettings {
    const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
    const next = appSettingsSchema.parse({ ...this.current, ...changes })
    this.deps.repo.save(next)
    this.current = next
    this.deps.emit('settings.changed', { ...next })
    for (const listener of this.listeners) listener({ ...next })
    return { ...next }
  }

  /** Usado pelo processo principal para reagir (tema nativo, idioma dos menus). */
  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
