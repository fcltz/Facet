import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/ipc/result'
import type { BackupResult, RestoreCandidate } from '@shared/schemas/backup'
import type { AppSettings } from '@shared/schemas/settings'
import { createBackup, machineTag, type BackupDeps } from '../backup/backup'
import { inspectBackup, stageRestore } from '../backup/restore'
import type { JobRunner } from '../jobs'
import type { Logger } from '../logger'
import type { SettingsService } from './settings.service'

export interface BackupServiceDeps extends BackupDeps {
  jobs: JobRunner
  settings: SettingsService
  logger: Logger
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Backup manual e automático, escolha da pasta e preparação da restauração. */
export class BackupService {
  private readonly restores = new Map<string, string>()

  constructor(private readonly deps: BackupServiceDeps) {}

  folder(): string {
    return this.deps.settings.get().backup.folder || this.deps.paths.backupsDir
  }

  /** Pasta escolhida no seletor: precisa existir (ou ser criável) e aceitar gravação. */
  setFolder(folder: string): AppSettings {
    const resolved = path.resolve(folder)
    try {
      fs.mkdirSync(resolved, { recursive: true })
      const probe = path.join(resolved, `.facet-write-test-${randomUUID()}`)
      fs.writeFileSync(probe, '', { flag: 'wx' })
      fs.rmSync(probe, { force: true })
    } catch (error) {
      throw new AppError('IO_ERROR', `Não é possível gravar nesta pasta: ${message(error)}`)
    }
    const { backup } = this.deps.settings.get()
    return this.deps.settings.update({ backup: { ...backup, folder: resolved } })
  }

  run(jobId: string, includeProfiles: boolean): Promise<BackupResult> {
    return this.deps.jobs.run(jobId, 'backup', async (job) => {
      const { backup } = this.deps.settings.get()
      try {
        const result = await createBackup(
          this.deps,
          { folder: this.folder(), keep: backup.keep, includeProfiles },
          job,
        )
        this.deps.settings.setInternal({
          backupState: {
            lastAt: this.deps.now(),
            lastFile: result.fileName,
            lastError: null,
            skipped: result.skipped,
          },
        })
        this.deps.logger.info(`Backup criado: ${result.fileName}`)
        return result
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'CANCELLED'))
          this.deps.settings.setInternal({
            backupState: { ...this.deps.settings.get().backupState, lastError: message(error) },
          })
        throw error
      }
    })
  }

  /** Backup automático: usa a opção "incluir dados dos perfis" das configurações. */
  runScheduled(): Promise<BackupResult> {
    return this.run(randomUUID(), this.deps.settings.get().backup.includeProfiles)
  }

  async inspectRestore(file: string): Promise<RestoreCandidate> {
    const manifest = await inspectBackup(file)
    const token = randomUUID()
    this.restores.set(token, file)
    return {
      token,
      fileName: path.basename(file),
      createdAt: manifest.createdAt,
      appVersion: manifest.app.version,
      includesProfiles: manifest.includesProfiles,
      profiles: manifest.profiles.length,
      otherMachine: manifest.machine !== machineTag(),
    }
  }

  /**
   * Fecha os perfis, extrai o backup e deixa as aberturas bloqueadas: o app reinicia em
   * seguida e aplica a troca antes de abrir o banco.
   */
  restore(token: string): Promise<void> {
    const file = this.restores.get(token)
    if (!file) return Promise.reject(new AppError('NOT_FOUND', 'Escolha o backup de novo'))
    this.restores.delete(token)
    return this.deps.jobs.run(randomUUID(), 'restore', async (job) => {
      await this.deps.runtime.stopAll()
      const release = this.deps.runtime.blockStarts?.('Restaurando um backup') ?? (() => undefined)
      try {
        job.progress('extracting', 0, 1, null)
        await stageRestore(file, this.deps.paths, this.deps.now())
        job.progress('extracting', 1, 1, null)
      } catch (error) {
        release()
        throw error
      }
    })
  }
}
