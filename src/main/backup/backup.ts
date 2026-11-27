import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { APP_NAME } from '@shared/constants'
import { AppError } from '@shared/ipc/result'
import { BACKUP_FORMAT, type BackupManifest, type BackupResult } from '@shared/schemas/backup'
import { ZipWriter } from '../archive/zip-writer'
import type { ProfileFiles } from '../browser/profile-files'
import type { DatabaseConnection } from '../db/client'
import type { JobContext } from '../jobs'
import type { AppPaths } from '../paths'
import type { Repositories } from '../repositories/types'
import type { ProfileRuntime } from '../runtime/types'
import { profileDataFilter } from '../transfer/profile-data'

/** Nome dos arquivos de backup: data e hora, mais um número quando há dois no mesmo segundo. */
export const BACKUP_FILE = /^facet-backup-(\d{8}-\d{6})(?:-(\d+))?\.zip$/

/** Do mais antigo para o mais novo (`-2` depois do nome sem número, no mesmo segundo). */
function byAge(a: string, b: string): number {
  const [, stampA = '', indexA = '1'] = BACKUP_FILE.exec(a) ?? []
  const [, stampB = '', indexB = '1'] = BACKUP_FILE.exec(b) ?? []
  return stampA === stampB ? Number(indexA) - Number(indexB) : stampA.localeCompare(stampB)
}

/** Marca da máquina e do usuário: o cofre do Windows (DPAPI) só abre no mesmo usuário. */
function currentUser(): string {
  try {
    return os.userInfo().username
  } catch {
    return ''
  }
}

export function machineTag(): string {
  return createHash('sha256').update(`${os.hostname()}|${currentUser()}`).digest('hex').slice(0, 32)
}

function stamp(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

/** Apaga os backups além dos `keep` mais recentes (só os arquivos com o nome do Facet). */
export function pruneBackups(folder: string, keep: number): number {
  const files = fs
    .readdirSync(folder)
    .filter((name) => BACKUP_FILE.test(name))
    .sort(byAge)
    .reverse()
  for (const name of files.slice(keep)) fs.rmSync(path.join(folder, name), { force: true })
  return Math.max(0, files.length - keep)
}

export interface BackupDeps {
  paths: AppPaths
  database: DatabaseConnection
  files: ProfileFiles
  runtime: ProfileRuntime
  repos: Repositories
  appVersion: string
  now: () => number
}

/**
 * Backup para restaurar no mesmo usuário: cópia consistente do SQLite com o app aberto
 * (`db.backup`), biblioteca de extensões e, se pedido, as pastas dos perfis fechados sem
 * caches. Cada pasta fica travada (o perfil não abre) até ser lida para o ZIP; perfis
 * abertos ficam de fora e são listados.
 */
export async function createBackup(
  deps: BackupDeps,
  options: { folder: string; keep: number; includeProfiles: boolean },
  job: JobContext,
): Promise<BackupResult> {
  fs.mkdirSync(options.folder, { recursive: true })
  const now = deps.now()
  let fileName = `facet-backup-${stamp(now)}.zip`
  for (let index = 2; fs.existsSync(path.join(options.folder, fileName)); index++)
    fileName = `facet-backup-${stamp(now)}-${index}.zip`
  fs.mkdirSync(deps.paths.tempDir, { recursive: true })
  const snapshot = path.join(deps.paths.tempDir, `backup-${randomUUID()}.sqlite`)
  const writer = new ZipWriter(path.join(options.folder, fileName), job.signal)
  const included: string[] = []
  const skipped: string[] = []
  const skippedNames: string[] = []
  const runIdle =
    deps.runtime.runIdle?.bind(deps.runtime) ??
    (<T>(_id: string, action: () => Promise<T> | T): Promise<T> => Promise.resolve(action()))
  try {
    job.progress('database', 0, 1, null)
    await deps.database.sqlite.backup(snapshot)
    writer.addFile(snapshot, 'data/facet.sqlite')
    if (fs.existsSync(deps.paths.extensionsDir))
      writer.addDirectory(deps.paths.extensionsDir, 'extensions', (segments) => segments[0] !== '.staging')
    if (options.includeProfiles) {
      const filter = profileDataFilter('backup')
      const profiles = deps.repos.profiles.list('all')
      for (const [index, profile] of profiles.entries()) {
        job.signal.throwIfAborted()
        job.progress('profiles', index, profiles.length, profile.name)
        const directory = deps.files.directory(profile.id)
        if (!fs.existsSync(directory)) continue
        const skip = (): void => {
          skipped.push(profile.id)
          skippedNames.push(profile.name)
        }
        if (deps.runtime.isActive(profile.id)) {
          skip()
          continue
        }
        try {
          await runIdle(profile.id, async () => {
            await writer.addDirectory(directory, `profiles/${profile.id}`, filter).done
          })
          included.push(profile.id)
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'PROFILE_RUNNING')) throw error
          skip()
        }
      }
    }
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      kind: 'facet-backup',
      app: { name: APP_NAME, version: deps.appVersion },
      createdAt: now,
      machine: machineTag(),
      includesProfiles: options.includeProfiles,
      profiles: included,
      skipped,
    }
    writer.addBuffer(JSON.stringify(manifest, null, 2), 'facet-backup.json')
    job.progress('finishing', 1, 1, null)
    const bytes = await writer.finish()
    pruneBackups(options.folder, options.keep)
    return { fileName, bytes, profiles: included.length, skipped: skippedNames }
  } catch (error) {
    await writer.abort()
    if (job.signal.aborted) throw job.signal.reason
    throw error
  } finally {
    fs.rmSync(snapshot, { force: true })
  }
}
