import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/ipc/result'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/schemas/settings'
import { ProfileFiles } from '@main/browser/profile-files'
import { JobRunner, type JobContext } from '@main/jobs'
import { silentLogger } from '@main/logger'
import { ensureBaseDirs, resolveAppPaths } from '@main/paths'
import {
  ProfilesRootService,
  relocateProfiles,
  relocationJournalFile,
  resumeRelocation,
} from '@main/profiles-root/relocate'
import { MockRuntime } from '@main/runtime/mock-runtime'
import { SettingsService } from '@main/services/settings.service'

fs.mkdirSync(path.resolve('.tmp-tests'), { recursive: true })
const base = fs.mkdtempSync(path.resolve('.tmp-tests', 'relocate-'))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

function job(signal = new AbortController().signal): JobContext {
  return { signal, progress: vi.fn() }
}

function seedProfiles(root: string, count: number): string[] {
  return Array.from({ length: count }, () => {
    const id = randomUUID()
    fs.mkdirSync(path.join(root, id, 'Default', 'Local Storage'), { recursive: true })
    fs.writeFileSync(path.join(root, id, 'Default', 'Preferences'), `{"id":"${id}"}`)
    fs.writeFileSync(path.join(root, id, 'Default', 'Local Storage', 'data'), 'x'.repeat(1000))
    return id
  })
}

function setup() {
  const userData = fs.mkdtempSync(path.join(base, 'app-'))
  const paths = resolveAppPaths(userData)
  ensureBaseDirs(paths)
  let stored: AppSettings = { ...DEFAULT_SETTINGS }
  const settings = new SettingsService({
    repo: { load: () => stored, save: (value) => (stored = value) },
    emit: vi.fn(),
  })
  const files = new ProfileFiles(paths.profilesDir)
  const runtime = new MockRuntime({ startDelayMs: 50, stopDelayMs: 1 })
  const service = new ProfilesRootService({
    files,
    settings,
    runtime,
    paths,
    jobs: new JobRunner(vi.fn()),
    logger: silentLogger,
    now: () => 1,
  })
  return { paths, settings, files, runtime, service }
}

describe('escolha da pasta dos perfis', () => {
  it('aponta o motivo de cada pasta recusada', async () => {
    const { paths, files, runtime, service } = setup()
    seedProfiles(files.root, 2)
    const empty = path.join(base, `vazia-${randomUUID()}`)
    const ok = service.inspect(empty, false)
    expect(ok).toMatchObject({ problem: null, profiles: 2, bytes: 2 * (1000 + 45), sameVolume: true })
    expect(service.inspect(files.root, false).problem).toBe('same')
    expect(service.inspect(path.join(files.root, 'dentro'), false).problem).toBe('insideData')
    expect(service.inspect(path.join(paths.dataDir, 'perfis'), false).problem).toBe('insideData')
    const busy = path.join(base, `cheia-${randomUUID()}`)
    fs.mkdirSync(busy)
    fs.writeFileSync(path.join(busy, 'algo.txt'), 'x')
    expect(service.inspect(busy, false).problem).toBe('notEmpty')
    expect(service.inspect(path.join(base, 'x'.repeat(160)), false).problem).toBe('tooLong')
    const starting = runtime.start(randomUUID())
    expect(service.inspect(empty, false).problem).toBe('running')
    await starting
    await runtime.stopAll()
  })
})

describe('mudança da pasta dos perfis', () => {
  it('mesma unidade: move as pastas, troca a raiz em uso e volta para a padrão', async () => {
    const { paths, settings, files, service } = setup()
    const ids = seedProfiles(files.root, 2)
    const target = path.join(base, `nova-${randomUUID()}`)
    const candidate = service.inspect(target, false)
    expect(await service.move(randomUUID(), candidate.token)).toEqual({ root: target, moved: 2 })
    expect(files.root).toBe(target)
    expect(settings.get().profilesRoot).toBe(target)
    for (const id of ids) {
      expect(fs.readFileSync(path.join(target, id, 'Default', 'Preferences'), 'utf8')).toContain(id)
      expect(fs.existsSync(path.join(paths.profilesDir, id))).toBe(false)
    }
    expect(fs.existsSync(relocationJournalFile(paths))).toBe(false)
    // De volta para a pasta padrão: a configuração fica vazia.
    const back = service.inspect(paths.profilesDir, true)
    expect(back.problem).toBeNull()
    await service.move(randomUUID(), back.token)
    expect(settings.get().profilesRoot).toBe('')
    expect(fs.existsSync(path.join(paths.profilesDir, ids[0]!, 'Default', 'Preferences'))).toBe(true)
    await expect(service.move(randomUUID(), back.token)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('outra unidade: copia tudo antes de trocar a raiz e só então apaga as originais', async () => {
    const { paths, files } = setup()
    const ids = seedProfiles(files.root, 3)
    const target = path.join(base, `copia-${randomUUID()}`)
    const apply = vi.fn((root: string) => {
      // Na troca da raiz as cópias já estão completas e as originais ainda existem.
      for (const id of ids) {
        expect(fs.existsSync(path.join(root, id, 'Default', 'Preferences'))).toBe(true)
        expect(fs.existsSync(path.join(paths.profilesDir, id))).toBe(true)
      }
    })
    const journal = relocationJournalFile(paths)
    expect(
      await relocateProfiles({
        from: files.root,
        to: target,
        sameVolume: false,
        journal,
        job: job(),
        apply,
        now: 1,
      }),
    ).toBe(3)
    expect(apply).toHaveBeenCalledWith(target)
    for (const id of ids) expect(fs.existsSync(path.join(paths.profilesDir, id))).toBe(false)
    expect(fs.existsSync(path.join(target, '.relocating'))).toBe(false)
    expect(fs.existsSync(journal)).toBe(false)
  })

  it('cancelar durante a cópia desfaz a cópia e mantém as originais', async () => {
    const { paths, files } = setup()
    const ids = seedProfiles(files.root, 3)
    const target = path.join(base, `cancelada-${randomUUID()}`)
    const controller = new AbortController()
    const context: JobContext = {
      signal: controller.signal,
      progress: () => controller.abort(new AppError('CANCELLED', 'Operação cancelada')),
    }
    const apply = vi.fn()
    await expect(
      relocateProfiles({
        from: files.root,
        to: target,
        sameVolume: false,
        journal: relocationJournalFile(paths),
        job: context,
        apply,
        now: 1,
      }),
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(apply).not.toHaveBeenCalled()
    expect(fs.readdirSync(target)).toEqual([])
    for (const id of ids)
      expect(fs.existsSync(path.join(paths.profilesDir, id, 'Default', 'Preferences'))).toBe(true)
    expect(fs.existsSync(relocationJournalFile(paths))).toBe(false)
  })
})

describe('retomada após queda', () => {
  function journal(paths: ReturnType<typeof resolveAppPaths>, value: object): string {
    const file = relocationJournalFile(paths)
    fs.writeFileSync(file, JSON.stringify({ version: 1, strategy: 'rename', startedAt: 1, ...value }))
    return file
  }

  it('mover pela metade termina a mudança', () => {
    const { paths, files } = setup()
    const ids = seedProfiles(files.root, 2)
    const target = path.join(base, `meio-${randomUUID()}`)
    fs.mkdirSync(target)
    fs.renameSync(path.join(files.root, ids[0]!), path.join(target, ids[0]!))
    const file = journal(paths, { from: files.root, to: target, ids, phase: 'moving' })
    const apply = vi.fn()
    resumeRelocation(file, apply, silentLogger)
    expect(apply).toHaveBeenCalledWith(target)
    for (const id of ids) expect(fs.existsSync(path.join(target, id, 'Default', 'Preferences'))).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('cópia pela metade é desfeita; limpeza pela metade é concluída', () => {
    const { paths, files } = setup()
    const ids = seedProfiles(files.root, 2)
    const target = path.join(base, `parcial-${randomUUID()}`)
    fs.mkdirSync(path.join(target, ids[0]!), { recursive: true })
    fs.mkdirSync(path.join(target, '.relocating', ids[1]!), { recursive: true })
    const copying = journal(paths, { from: files.root, to: target, ids, phase: 'copying', strategy: 'copy' })
    const apply = vi.fn()
    resumeRelocation(copying, apply, silentLogger)
    expect(apply).not.toHaveBeenCalled()
    expect(fs.readdirSync(target)).toEqual([])
    for (const id of ids) expect(fs.existsSync(path.join(files.root, id))).toBe(true)

    for (const id of ids) fs.cpSync(path.join(files.root, id), path.join(target, id), { recursive: true })
    const cleanup = journal(paths, { from: files.root, to: target, ids, phase: 'cleanup', strategy: 'copy' })
    resumeRelocation(cleanup, apply, silentLogger)
    expect(apply).toHaveBeenCalledWith(target)
    for (const id of ids) expect(fs.existsSync(path.join(files.root, id))).toBe(false)
  })

  it('diário inválido é guardado de lado sem mexer nas pastas', () => {
    const { paths } = setup()
    const file = journal(paths, { from: 'relativo', to: '../../fora', ids: ['../x'], phase: 'moving' })
    const apply = vi.fn()
    resumeRelocation(file, apply, silentLogger)
    expect(apply).not.toHaveBeenCalled()
    expect(fs.existsSync(file)).toBe(false)
    expect(
      fs.readdirSync(paths.dataDir).some((name) => name.startsWith('profiles-relocation.json.invalid-')),
    ).toBe(true)
  })
})
