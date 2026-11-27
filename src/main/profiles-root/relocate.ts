import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from '@shared/constants'
import { AppError } from '@shared/ipc/result'
import type {
  ProfilesRootCandidate,
  ProfilesRootMoveResult,
  ProfilesRootProblem,
} from '@shared/schemas/settings'
import type { ProfileFiles } from '../browser/profile-files'
import { samePath } from '../browser/process'
import type { JobContext, JobRunner } from '../jobs'
import type { Logger } from '../logger'
import type { AppPaths } from '../paths'
import type { ProfileRuntime } from '../runtime/types'
import type { SettingsService } from '../services/settings.service'

/**
 * Mudança da pasta raiz dos perfis, com todos os perfis parados e as aberturas bloqueadas.
 * - Mesma unidade: `rename` de cada pasta (instantâneo). Uma queda no meio é retomada no
 *   próximo início, antes de qualquer perfil abrir.
 * - Outra unidade: cópia completa primeiro (os originais ficam intactos); só então a raiz
 *   muda e as pastas antigas são apagadas. Cancelar ou cair durante a cópia desfaz a cópia.
 */
export interface RelocationJournal {
  version: 1
  from: string
  to: string
  strategy: 'rename' | 'copy'
  ids: string[]
  phase: 'moving' | 'copying' | 'cleanup'
  startedAt: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HELPERS = new Set(['.pending-delete', '.import-staging', '.relocating'])

export function relocationJournalFile(paths: AppPaths): string {
  return path.join(paths.dataDir, 'profiles-relocation.json')
}

function profileFolders(root: string): string[] {
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && !item.isSymbolicLink() && UUID.test(item.name))
    .map((item) => item.name)
}

function folderBytes(directory: string): number {
  let total = 0
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) continue
    const full = path.join(directory, item.name)
    if (item.isDirectory()) total += folderBytes(full)
    else if (item.isFile()) total += fs.statSync(full).size
  }
  return total
}

function emptyDir(directory: string): boolean {
  return fs.readdirSync(directory).length === 0
}

function existingAncestor(target: string): string {
  let current = target
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return current
}

function inside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function writable(directory: string): boolean {
  const probe = path.join(directory, `.facet-write-test-${randomUUID()}`)
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' })
    fs.rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

function freeSpace(directory: string): number | null {
  try {
    const stats = fs.statfsSync(directory)
    return stats.bavail * stats.bsize
  } catch {
    return null
  }
}

function writeJournal(file: string, journal: RelocationJournal): void {
  const temp = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(temp, JSON.stringify(journal), { flag: 'wx' })
  fs.renameSync(temp, file)
}

async function copyTree(
  source: string,
  target: string,
  signal: AbortSignal,
  onBytes: (bytes: number) => void,
): Promise<void> {
  fs.mkdirSync(target, { recursive: true })
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    signal.throwIfAborted()
    if (item.isSymbolicLink()) continue
    const from = path.join(source, item.name)
    const to = path.join(target, item.name)
    if (item.isDirectory()) await copyTree(from, to, signal, onBytes)
    else if (item.isFile()) {
      await fs.promises.copyFile(from, to, fs.constants.COPYFILE_EXCL)
      onBytes(fs.statSync(to).size)
    }
  }
}

/** Move as pastas dos perfis; `apply` troca a raiz em uso (arquivos e configuração). */
export async function relocateProfiles(params: {
  from: string
  to: string
  sameVolume: boolean
  journal: string
  job: JobContext
  apply: (root: string) => void
  now: number
}): Promise<number> {
  const { from, to, job } = params
  const ids = profileFolders(from)
  fs.mkdirSync(to, { recursive: true })
  for (const helper of HELPERS) {
    const directory = path.join(to, helper)
    if (fs.existsSync(directory) && emptyDir(directory)) fs.rmdirSync(directory)
  }
  const strategy = params.sameVolume ? 'rename' : 'copy'
  const journal: RelocationJournal = {
    version: 1,
    from,
    to,
    strategy,
    ids,
    phase: strategy === 'rename' ? 'moving' : 'copying',
    startedAt: params.now,
  }
  writeJournal(params.journal, journal)
  if (strategy === 'rename') {
    ids.forEach((id, index) => {
      job.progress('moving', index, ids.length, null)
      const source = path.join(from, id)
      if (fs.existsSync(source)) fs.renameSync(source, path.join(to, id))
    })
    params.apply(to)
    fs.rmSync(params.journal, { force: true })
    return ids.length
  }
  const total = ids.reduce((sum, id) => sum + folderBytes(path.join(from, id)), 0)
  const scratch = path.join(to, '.relocating')
  let copied = 0
  try {
    for (const id of ids) {
      const partial = path.join(scratch, id)
      fs.rmSync(partial, { recursive: true, force: true })
      await copyTree(path.join(from, id), partial, job.signal, (bytes) => {
        copied += bytes
        job.progress('copying', copied, total, null)
      })
      fs.renameSync(partial, path.join(to, id))
    }
  } catch (error) {
    // A pasta de destino estava vazia: tudo que há nela com esses IDs é cópia desta mudança.
    for (const id of ids) fs.rmSync(path.join(to, id), { recursive: true, force: true })
    fs.rmSync(scratch, { recursive: true, force: true })
    fs.rmSync(params.journal, { force: true })
    throw error
  }
  fs.rmSync(scratch, { recursive: true, force: true })
  writeJournal(params.journal, { ...journal, phase: 'cleanup' })
  params.apply(to)
  ids.forEach((id, index) => {
    job.progress('cleanup', index, ids.length, null)
    fs.rmSync(path.join(from, id), { recursive: true, force: true, maxRetries: 2 })
  })
  fs.rmSync(params.journal, { force: true })
  return ids.length
}

function readJournal(file: string): RelocationJournal | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RelocationJournal
    const valid =
      value.version === 1 &&
      typeof value.from === 'string' &&
      typeof value.to === 'string' &&
      path.isAbsolute(value.from) &&
      path.isAbsolute(value.to) &&
      ['rename', 'copy'].includes(value.strategy) &&
      ['moving', 'copying', 'cleanup'].includes(value.phase) &&
      Array.isArray(value.ids) &&
      value.ids.every((id) => typeof id === 'string' && UUID.test(id))
    return valid ? value : null
  } catch {
    return null
  }
}

/** No início, antes de montar a pasta dos perfis: termina ou desfaz uma mudança interrompida. */
export function resumeRelocation(file: string, apply: (root: string) => void, logger: Logger): void {
  if (!fs.existsSync(file)) return
  const journal = readJournal(file)
  if (!journal) {
    logger.error('Diário da mudança da pasta dos perfis inválido; mantido para análise', file)
    fs.renameSync(file, `${file}.invalid-${Date.now()}`)
    return
  }
  const { from, to, ids } = journal
  if (journal.phase === 'moving') {
    fs.mkdirSync(to, { recursive: true })
    for (const id of ids) {
      const source = path.join(from, id)
      const target = path.join(to, id)
      if (fs.existsSync(source) && !fs.existsSync(target)) fs.renameSync(source, target)
    }
    apply(to)
    logger.warn('Mudança da pasta dos perfis concluída após interrupção', to)
  } else if (journal.phase === 'copying') {
    for (const id of ids) {
      if (fs.existsSync(path.join(from, id))) fs.rmSync(path.join(to, id), { recursive: true, force: true })
    }
    fs.rmSync(path.join(to, '.relocating'), { recursive: true, force: true })
    logger.warn('Mudança da pasta dos perfis interrompida durante a cópia; mantida a pasta anterior', from)
  } else {
    apply(to)
    for (const id of ids) {
      if (fs.existsSync(path.join(to, id))) fs.rmSync(path.join(from, id), { recursive: true, force: true })
    }
    logger.warn('Limpeza da pasta antiga dos perfis concluída após interrupção', from)
  }
  fs.rmSync(file, { force: true })
}

export interface ProfilesRootDeps {
  files: ProfileFiles
  settings: SettingsService
  runtime: ProfileRuntime
  paths: AppPaths
  jobs: JobRunner
  logger: Logger
  now: () => number
}

/** Escolha conferida da nova pasta (por token) e a mudança como tarefa longa. */
export class ProfilesRootService {
  private readonly candidates = new Map<string, { path: string; isDefault: boolean }>()

  constructor(private readonly deps: ProfilesRootDeps) {}

  /** Grava a raiz em uso: vazio na configuração quando for a pasta padrão. */
  apply(root: string): void {
    this.deps.files.setRoot(root)
    this.deps.settings.setInternal({ profilesRoot: samePath(root, this.deps.paths.profilesDir) ? '' : root })
  }

  inspect(target: string, isDefault: boolean): ProfilesRootCandidate {
    const resolved = path.resolve(target)
    const current = this.deps.files.root
    const ids = profileFolders(current)
    const bytes = ids.reduce((sum, id) => sum + folderBytes(path.join(current, id)), 0)
    const ancestor = existingAncestor(resolved)
    const sameVolume = fs.statSync(ancestor).dev === fs.statSync(current).dev
    const freeBytes = freeSpace(ancestor)
    const token = randomUUID()
    this.candidates.set(token, { path: resolved, isDefault })
    return {
      token,
      path: resolved,
      isDefault,
      profiles: ids.length,
      bytes,
      freeBytes,
      sameVolume,
      problem: this.problem(resolved, current, ancestor, bytes, freeBytes, sameVolume),
    }
  }

  private problem(
    target: string,
    current: string,
    ancestor: string,
    bytes: number,
    freeBytes: number | null,
    sameVolume: boolean,
  ): ProfilesRootProblem | null {
    const { paths } = this.deps
    if (this.deps.runtime.hasActive()) return 'running'
    if (samePath(target, current)) return 'same'
    if (target.length > LIMITS.profilesRootMax) return 'tooLong'
    const reserved = [paths.dataDir, paths.extensionsDir, paths.tempDir, paths.logsDir, paths.backupsDir]
    if (
      inside(target, current) ||
      inside(current, target) ||
      reserved.some((directory) => samePath(target, directory) || inside(target, directory))
    )
      return 'insideData'
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target)
      if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(fs.realpathSync(target), target))
        return 'link'
      const entries = fs
        .readdirSync(target)
        .filter((name) => !HELPERS.has(name) || !emptyDir(path.join(target, name)))
      if (entries.length > 0) return 'notEmpty'
    } else if (!samePath(fs.realpathSync(ancestor), ancestor)) {
      return 'link'
    }
    if (!writable(ancestor)) return 'notWritable'
    if (!sameVolume && freeBytes !== null && freeBytes < bytes * 1.1 + 64 * 1024 * 1024) return 'noSpace'
    return null
  }

  move(jobId: string, token: string): Promise<ProfilesRootMoveResult> {
    const candidate = this.candidates.get(token)
    if (!candidate) return Promise.reject(new AppError('NOT_FOUND', 'Escolha a pasta de novo'))
    this.candidates.delete(token)
    return this.deps.jobs.run(jobId, 'relocate', async (job) => {
      // Confere de novo: algo pode ter mudado desde a escolha.
      const check = this.inspect(candidate.path, candidate.isDefault)
      this.candidates.delete(check.token)
      if (check.problem)
        throw new AppError('PROFILES_ROOT_INVALID', 'A pasta escolhida não pode ser usada', {
          problem: check.problem,
        })
      const release = this.deps.runtime.blockStarts?.('Mudando a pasta dos perfis') ?? (() => undefined)
      try {
        const moved = await relocateProfiles({
          from: this.deps.files.root,
          to: candidate.path,
          sameVolume: check.sameVolume,
          journal: relocationJournalFile(this.deps.paths),
          job,
          apply: (root) => this.apply(root),
          now: this.deps.now(),
        })
        this.deps.logger.info(`Pasta dos perfis mudou para ${candidate.path} (${moved} perfis)`)
        return { root: candidate.path, moved }
      } finally {
        release()
      }
    })
  }
}
