import { AppError } from '@shared/ipc/result'
import { BACKUP_INTERVAL_MS } from '@shared/schemas/backup'
import type { Logger } from '../logger'
import type { SettingsService } from '../services/settings.service'

export interface BackupSchedulerDeps {
  settings: SettingsService
  run: () => Promise<unknown>
  now: () => number
  logger: Logger
  /** Intervalo entre conferências (padrão: 30 min). */
  checkEveryMs?: number
  /** Primeira conferência depois de abrir o app (padrão: 2 min, para não pesar no início). */
  firstCheckMs?: number
}

/**
 * Backup automático: confere de tempos em tempos se o último backup bem-sucedido ficou
 * mais velho que o intervalo escolhido. Se outra operação longa estiver rodando, tenta
 * na próxima conferência.
 */
export class BackupScheduler {
  private interval: ReturnType<typeof setInterval> | null = null
  private first: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(private readonly deps: BackupSchedulerDeps) {}

  start(): void {
    this.stop()
    this.first = setTimeout(() => void this.tick(), this.deps.firstCheckMs ?? 2 * 60 * 1000)
    this.interval = setInterval(() => void this.tick(), this.deps.checkEveryMs ?? 30 * 60 * 1000)
    this.first.unref?.()
    this.interval.unref?.()
  }

  stop(): void {
    if (this.first) clearTimeout(this.first)
    if (this.interval) clearInterval(this.interval)
    this.first = null
    this.interval = null
  }

  /** true = um backup foi feito agora. */
  async tick(): Promise<boolean> {
    if (this.running) return false
    const { backup, backupState } = this.deps.settings.get()
    if (backup.interval === 'off') return false
    if ((backupState.lastAt ?? 0) + BACKUP_INTERVAL_MS[backup.interval] > this.deps.now()) return false
    this.running = true
    try {
      await this.deps.run()
      return true
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'JOB_BUSY'))
        this.deps.logger.warn('Backup automático falhou', error)
      return false
    } finally {
      this.running = false
    }
  }
}
