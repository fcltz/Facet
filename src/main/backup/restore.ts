import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { LIMITS } from '@shared/constants'
import { AppError } from '@shared/ipc/result'
import { backupManifestSchema, type BackupManifest } from '@shared/schemas/backup'
import { forEachEntry, openZipFile, readEntryBuffer, unpackAll, type InvalidZip } from '../archive/zip-reader'
import type { Logger } from '../logger'
import type { AppPaths } from '../paths'

const invalid: InvalidZip = (message, reason = 'backup') =>
  new AppError('BACKUP_INVALID', message, { reason })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MARKER = 'restore-pending.json'

interface RestoreMarker {
  version: 1
  createdAt: number
  /** Fase já concluída: retomar depois de uma queda continua daqui. */
  phase: 'staged' | 'prepared' | 'database' | 'extensions' | 'profiles'
  /** Valor de `profilesRoot` desta instalação, levado para o banco restaurado. */
  profilesRoot: string | null
}

function stagingDir(paths: AppPaths): string {
  return path.join(paths.userData, 'restore-staging')
}

/** Dados de antes da última restauração (substituídos a cada nova restauração). */
export function preRestoreDir(paths: AppPaths): string {
  return path.join(paths.userData, 'pre-restore')
}

export async function inspectBackup(file: string): Promise<BackupManifest> {
  let zipfile
  try {
    zipfile = await openZipFile(file)
  } catch (error) {
    throw invalid(`O arquivo não é um ZIP válido: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const found: { manifest: BackupManifest | null; database: boolean } = { manifest: null, database: false }
    await forEachEntry(
      zipfile,
      async ({ entry, segments }) => {
        const name = segments.join('/')
        if (name === 'data/facet.sqlite') found.database = true
        if (name === 'facet-backup.json') {
          try {
            found.manifest = backupManifestSchema.parse(
              JSON.parse((await readEntryBuffer(zipfile, entry, 1024 * 1024, invalid)).toString('utf8')),
            )
          } catch (error) {
            if (error instanceof AppError) throw error
            throw invalid('Manifesto do backup inválido')
          }
        }
      },
      { maxEntries: LIMITS.transferMaxEntries, invalid },
    )
    if (!found.manifest) throw invalid('Este ZIP não é um backup do Facet', 'notBackup')
    if (!found.database) throw invalid('Backup sem o banco de dados')
    return found.manifest
  } finally {
    zipfile.close()
  }
}

function writeMarker(paths: AppPaths, marker: RestoreMarker): void {
  const file = path.join(paths.userData, MARKER)
  const temp = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(marker), { flag: 'wx' })
  fs.renameSync(temp, file)
}

/** Extrai o backup numa área temporária; a troca acontece no próximo início do app. */
export async function stageRestore(file: string, paths: AppPaths, now: number): Promise<void> {
  const staging = stagingDir(paths)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  const zipfile = await openZipFile(file)
  try {
    await unpackAll(
      zipfile,
      staging,
      { maxEntries: LIMITS.transferMaxEntries, maxTotalBytes: LIMITS.transferMaxBytes },
      invalid,
    )
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  } finally {
    zipfile.close()
  }
  if (!fs.existsSync(path.join(staging, 'data', 'facet.sqlite'))) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw invalid('Backup sem o banco de dados')
  }
  let database: Database.Database | undefined
  try {
    database = new Database(path.join(staging, 'data', 'facet.sqlite'), {
      readonly: true,
      fileMustExist: true,
    })
    const check = database.pragma('quick_check', { simple: true })
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string
    }[]
    if (
      check !== 'ok' ||
      !['profiles', 'settings', 'profile_sessions'].every((name) =>
        tables.some((table) => table.name === name),
      )
    )
      throw invalid('O banco do backup é inválido ou está corrompido')
  } catch (error) {
    database?.close()
    database = undefined
    fs.rmSync(staging, { recursive: true, force: true })
    if (error instanceof AppError) throw error
    throw invalid('O banco do backup é inválido ou está corrompido')
  } finally {
    database?.close()
  }
  writeMarker(paths, { version: 1, createdAt: now, phase: 'staged', profilesRoot: null })
}

function readProfilesRoot(databaseFile: string): string {
  if (!fs.existsSync(databaseFile)) return ''
  let db: Database.Database | undefined
  try {
    db = new Database(databaseFile, { readonly: true, fileMustExist: true })
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('profilesRoot') as
      { value: string } | undefined
    const value: unknown = row ? JSON.parse(row.value) : ''
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  } finally {
    db?.close()
  }
}

/** Banco restaurado: mantém a pasta dos perfis desta instalação e descarta sessões antigas. */
function adjustRestoredDatabase(databaseFile: string, profilesRoot: string): void {
  const db = new Database(databaseFile)
  try {
    db.prepare(
      'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    ).run('profilesRoot', JSON.stringify(profilesRoot), Date.now())
    db.prepare('DELETE FROM profile_sessions').run()
  } finally {
    db.close()
  }
}

/** Publica a cópia completa antes de remover a origem; uma queda pode retomar a remoção. */
function moveDir(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true })
  if (fs.existsSync(to)) {
    fs.rmSync(from, { recursive: true, force: true })
    return
  }
  try {
    fs.renameSync(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    const temporary = `${to}.restore-copy`
    fs.rmSync(temporary, { recursive: true, force: true })
    fs.cpSync(from, temporary, { recursive: true, errorOnExist: true, force: false })
    fs.renameSync(temporary, to)
    fs.rmSync(from, { recursive: true, force: true })
  }
}

function readMarker(file: string): RestoreMarker | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RestoreMarker
    const valid =
      value.version === 1 &&
      ['staged', 'prepared', 'database', 'extensions', 'profiles'].includes(value.phase) &&
      (value.profilesRoot === null || typeof value.profilesRoot === 'string')
    return valid ? value : null
  } catch {
    return null
  }
}

/**
 * No início do app, antes de abrir o banco: troca banco, extensões e pastas de perfil pelos
 * do backup. O que havia vai para `pre-restore/`. Cada fase é gravada; uma queda no meio é
 * retomada no início seguinte.
 */
export function applyPendingRestore(paths: AppPaths, logger: Logger): boolean {
  const markerFile = path.join(paths.userData, MARKER)
  if (!fs.existsSync(markerFile)) return false
  const marker = readMarker(markerFile)
  const staging = stagingDir(paths)
  if (!marker || !fs.existsSync(staging)) {
    logger.error('Restauração pendente inválida; descartada', markerFile)
    fs.renameSync(markerFile, `${markerFile}.invalid-${Date.now()}`)
    return false
  }
  const aside = preRestoreDir(paths)
  if (marker.phase === 'staged') {
    fs.rmSync(aside, { recursive: true, force: true })
    fs.mkdirSync(path.join(aside, 'data'), { recursive: true })
    marker.profilesRoot = readProfilesRoot(paths.databaseFile)
    // Grave a preparação antes de mover: repetir esta etapa não pode apagar o banco preservado.
    marker.phase = 'prepared'
    writeMarker(paths, marker)
  }
  if (marker.phase === 'prepared') {
    const restored = path.join(staging, 'data', 'facet.sqlite')
    if (fs.existsSync(restored)) {
      for (const suffix of ['', '-wal', '-shm']) {
        const file = paths.databaseFile + suffix
        const saved = path.join(aside, 'data', path.basename(file))
        if (fs.existsSync(file) && !fs.existsSync(saved)) fs.renameSync(file, saved)
      }
      fs.mkdirSync(path.dirname(paths.databaseFile), { recursive: true })
      fs.renameSync(restored, paths.databaseFile)
    }
    adjustRestoredDatabase(paths.databaseFile, marker.profilesRoot ?? '')
    marker.phase = 'database'
    writeMarker(paths, marker)
  }
  if (marker.phase === 'database') {
    const restored = path.join(staging, 'extensions')
    if (fs.existsSync(restored)) {
      if (fs.existsSync(paths.extensionsDir)) {
        const target = path.join(aside, 'extensions')
        if (fs.existsSync(target)) fs.rmSync(paths.extensionsDir, { recursive: true, force: true })
        else moveDir(paths.extensionsDir, target)
      }
      moveDir(restored, paths.extensionsDir)
    }
    marker.phase = 'extensions'
    writeMarker(paths, marker)
  }
  if (marker.phase === 'extensions') {
    const root = marker.profilesRoot || paths.profilesDir
    const restored = path.join(staging, 'profiles')
    if (fs.existsSync(restored)) {
      fs.mkdirSync(root, { recursive: true })
      for (const id of fs.readdirSync(restored).filter((name) => UUID.test(name))) {
        const target = path.join(root, id)
        if (fs.existsSync(target)) moveDir(target, path.join(aside, 'profiles', id))
        moveDir(path.join(restored, id), target)
      }
    }
    marker.phase = 'profiles'
    writeMarker(paths, marker)
  }
  fs.rmSync(staging, { recursive: true, force: true })
  fs.rmSync(markerFile, { force: true })
  logger.info('Backup restaurado; os dados anteriores estão em', aside)
  return true
}
