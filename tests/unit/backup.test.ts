import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path, { resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/ipc/result'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/schemas/settings'
import { forEachEntry, openZipFile, readEntryBuffer } from '@main/archive/zip-reader'
import { ZipWriter } from '@main/archive/zip-writer'
import { applyPendingRestore, preRestoreDir } from '@main/backup/restore'
import { BackupScheduler } from '@main/backup/scheduler'
import { createContainer, type Container } from '@main/container'
import { silentLogger } from '@main/logger'
import { ensureBaseDirs, resolveAppPaths, type AppPaths } from '@main/paths'
import { createTestSecretBox } from '@main/security/secrets'
import { SettingsService } from '@main/services/settings.service'

fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
const base = fs.mkdtempSync(resolve('.tmp-tests', 'backup-'))
const opened: Container[] = []
afterAll(async () => {
  for (const app of opened) await app.close().catch(() => undefined)
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 })
})

function open(paths: AppPaths, now = Date.now): Container {
  const app = createContainer({
    paths,
    migrationsFolder: resolve('drizzle'),
    emit: vi.fn(),
    logger: silentLogger,
    hostTimezone: 'UTC',
    secrets: createTestSecretBox(),
    appVersion: '9.9.9',
    now,
  })
  opened.push(app)
  return app
}

function install(name: string): AppPaths {
  const paths = resolveAppPaths(path.join(base, name))
  ensureBaseDirs(paths)
  return paths
}

function profileWithFolder(app: Container, name: string): string {
  const profile = app.services.profiles.create({
    name,
    os: 'windows',
    groupId: null,
    proxyId: null,
    tagIds: [],
    color: null,
    notes: '',
    launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
  })
  const directory = app.files.prepare(profile.id)
  fs.mkdirSync(path.join(directory, 'Default', 'Network'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'Default', 'Cache'), { recursive: true })
  fs.writeFileSync(path.join(directory, 'Default', 'Network', 'Cookies'), `cookies de ${name}`)
  fs.writeFileSync(path.join(directory, 'Default', 'Cache', 'grande'), 'cache')
  fs.writeFileSync(path.join(directory, 'Local State'), '{"os_crypt":{"encrypted_key":"mantida"}}')
  return profile.id
}

async function entries(file: string): Promise<Map<string, string>> {
  const zipfile = await openZipFile(file)
  const found = new Map<string, string>()
  const invalid = (message: string) => new AppError('BACKUP_INVALID', message)
  await forEachEntry(
    zipfile,
    async ({ entry, segments }) => {
      const name = segments.join('/')
      found.set(
        name,
        name.endsWith('.sqlite') ? '' : (await readEntryBuffer(zipfile, entry, 1e7, invalid)).toString(),
      )
    },
    { maxEntries: 10000, invalid },
  )
  zipfile.close()
  return found
}

describe('backup', () => {
  it('banco, extensões e perfis sem caches (com cookies e chave: restauração no mesmo usuário)', async () => {
    const paths = install('origem')
    const app = open(paths)
    const id = profileWithFolder(app, 'Para guardar')
    fs.mkdirSync(path.join(paths.extensionsDir, 'abc', '1.0'), { recursive: true })
    fs.writeFileSync(path.join(paths.extensionsDir, 'abc', '1.0', 'manifest.json'), '{}')
    fs.mkdirSync(path.join(paths.extensionsDir, '.staging', 'tmp'), { recursive: true })
    const result = await app.services.backup.run(randomUUID(), true)
    expect(result).toMatchObject({ profiles: 1, skipped: [] })
    expect(result.fileName).toMatch(/^facet-backup-\d{8}-\d{6}\.zip$/)
    const file = path.join(paths.backupsDir, result.fileName)
    const found = await entries(file)
    expect(found.has('data/facet.sqlite')).toBe(true)
    expect(found.has('extensions/abc/1.0/manifest.json')).toBe(true)
    expect([...found.keys()].some((name) => name.includes('.staging'))).toBe(false)
    expect(found.get(`profiles/${id}/Default/Network/Cookies`)).toBe('cookies de Para guardar')
    expect(found.get(`profiles/${id}/Local State`)).toContain('mantida')
    expect(found.has(`profiles/${id}/Default/Cache/grande`)).toBe(false)
    expect(JSON.parse(found.get('facet-backup.json')!)).toMatchObject({
      kind: 'facet-backup',
      includesProfiles: true,
      profiles: [id],
      app: { version: '9.9.9' },
    })
    expect(app.services.settings.get().backupState).toMatchObject({
      lastFile: result.fileName,
      lastError: null,
    })
  })

  it('mantém só os N backups mais recentes', async () => {
    const paths = install('retencao')
    const app = open(paths)
    app.services.settings.update({ backup: { ...DEFAULT_SETTINGS.backup, keep: 2 } })
    const names: string[] = []
    for (let i = 0; i < 3; i++) names.push((await app.services.backup.run(randomUUID(), false)).fileName)
    expect(fs.readdirSync(paths.backupsDir).sort()).toEqual(names.slice(1).sort())
  })

  it('restaura no início, antes de abrir o banco, mantendo a pasta dos perfis desta instalação', async () => {
    const source = install('fonte')
    const app = open(source)
    const id = profileWithFolder(app, 'Restaurado')
    const { fileName } = await app.services.backup.run(randomUUID(), true)
    const file = path.join(source.backupsDir, fileName)

    const target = install('alvo')
    const customRoot = path.join(base, `raiz-alvo-${randomUUID()}`)
    let local = open(target)
    const previous = profileWithFolder(local, 'Antes da restauração')
    local.services.profilesRoot.apply(customRoot)
    fs.renameSync(path.join(target.profilesDir, previous), path.join(customRoot, previous))
    const candidate = await local.services.backup.inspectRestore(file)
    expect(candidate).toMatchObject({
      fileName,
      profiles: 1,
      includesProfiles: true,
      otherMachine: false,
      appVersion: '9.9.9',
    })
    await local.services.backup.restore(candidate.token)
    await expect(local.runtime.start(previous)).rejects.toMatchObject({ code: 'JOB_BUSY' })
    await local.close()

    expect(applyPendingRestore(target, silentLogger)).toBe(true)
    expect(applyPendingRestore(target, silentLogger)).toBe(false)
    local = open(target)
    expect(local.services.profiles.list('active').map((profile) => profile.name)).toEqual(['Restaurado'])
    expect(local.services.settings.get().profilesRoot).toBe(customRoot)
    expect(local.files.root).toBe(customRoot)
    expect(fs.readFileSync(path.join(customRoot, id, 'Default', 'Network', 'Cookies'), 'utf8')).toBe(
      'cookies de Restaurado',
    )
    expect(fs.existsSync(path.join(preRestoreDir(target), 'data', 'facet.sqlite'))).toBe(true)
    // A pasta do perfil que não está no backup continua no lugar.
    expect(fs.existsSync(path.join(customRoot, previous))).toBe(true)
  })

  it.each(['preserve-database', 'install-database', 'preserve-copy', 'install-copy'])(
    'retoma uma restauração interrompida em %s sem perder os dados anteriores',
    async (failure) => {
      const paths = install(`interrompido-${failure}`)
      const app = open(paths)
      const id = profileWithFolder(app, 'Do backup')
      const { fileName } = await app.services.backup.run(randomUUID(), true)
      const customRoot = path.join(base, `raiz-${failure}`)
      app.services.profilesRoot.apply(customRoot)
      fs.renameSync(path.join(paths.profilesDir, id), path.join(customRoot, id))
      app.services.profiles.update(id, { name: 'Antes de restaurar' })
      const current = path.join(customRoot, id)
      fs.writeFileSync(path.join(current, 'Default', 'Network', 'Cookies'), 'cookies atuais')
      const candidate = await app.services.backup.inspectRestore(path.join(paths.backupsDir, fileName))
      await app.services.backup.restore(candidate.token)
      await app.close()

      const aside = preRestoreDir(paths)
      const previous = path.join(aside, 'profiles', id)
      const staged = path.join(paths.userData, 'restore-staging')
      const crossVolume = failure.endsWith('copy')
      const originalRename = fs.renameSync
      let interrupted = false
      const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        const source = String(from),
          destination = String(to)
        if (
          crossVolume &&
          ((source === current && destination === previous) ||
            (source === path.join(staged, 'profiles', id) && destination === current))
        )
          throw Object.assign(new Error('Outra unidade'), { code: 'EXDEV' })
        originalRename(from, to)
        const atFailure =
          (failure === 'preserve-database' && source === paths.databaseFile) ||
          (failure === 'install-database' && source === path.join(staged, 'data', 'facet.sqlite')) ||
          (failure === 'preserve-copy' && source === `${previous}.restore-copy`) ||
          (failure === 'install-copy' && source === `${current}.restore-copy`)
        if (!interrupted && atFailure) {
          interrupted = true
          throw new Error('Interrupção simulada após a operação no disco')
        }
      })
      try {
        expect(() => applyPendingRestore(paths, silentLogger)).toThrow('Interrupção simulada')
        expect(interrupted).toBe(true)
        expect(applyPendingRestore(paths, silentLogger)).toBe(true)
        expect(applyPendingRestore(paths, silentLogger)).toBe(false)
      } finally {
        rename.mockRestore()
      }
      const restored = open(paths)
      expect(restored.services.profiles.get(id).name).toBe('Do backup')
      expect(restored.files.root).toBe(customRoot)
      expect(fs.readFileSync(path.join(current, 'Default', 'Network', 'Cookies'), 'utf8')).toBe(
        'cookies de Do backup',
      )
      expect(fs.readFileSync(path.join(previous, 'Default', 'Network', 'Cookies'), 'utf8')).toBe(
        'cookies atuais',
      )
      const before = new Database(path.join(aside, 'data', 'facet.sqlite'), { readonly: true })
      try {
        expect(before.prepare('SELECT name FROM profiles WHERE id = ?').get(id)).toEqual({
          name: 'Antes de restaurar',
        })
      } finally {
        before.close()
      }
    },
  )

  it('avisa backup de outra máquina e recusa ZIP que não é backup', async () => {
    const paths = install('outra')
    const app = open(paths)
    const foreign = path.join(base, 'outra-maquina.zip')
    const writer = new ZipWriter(foreign)
    writer.addBuffer('', 'data/facet.sqlite')
    writer.addBuffer(
      JSON.stringify({
        format: 1,
        kind: 'facet-backup',
        app: { name: 'Facet', version: '1' },
        createdAt: 1,
        machine: 'outra',
        includesProfiles: false,
        profiles: [],
        skipped: [],
      }),
      'facet-backup.json',
    )
    await writer.finish()
    expect((await app.services.backup.inspectRestore(foreign)).otherMachine).toBe(true)
    const corrupt = await app.services.backup.inspectRestore(foreign)
    await expect(app.services.backup.restore(corrupt.token)).rejects.toMatchObject({ code: 'BACKUP_INVALID' })
    expect(fs.existsSync(path.join(paths.userData, 'restore-pending.json'))).toBe(false)
    expect(fs.existsSync(preRestoreDir(paths))).toBe(false)
    expect(app.services.profiles.list('active')).toEqual([])
    const notBackup = path.join(base, 'qualquer.zip')
    const other = new ZipWriter(notBackup)
    other.addBuffer('oi', 'leia-me.txt')
    await other.finish()
    await expect(app.services.backup.inspectRestore(notBackup)).rejects.toMatchObject({
      code: 'BACKUP_INVALID',
    })
  })
})

describe('agendamento', () => {
  it('roda só quando vencido; operação ocupada fica para a próxima conferência', async () => {
    let stored: AppSettings = { ...DEFAULT_SETTINGS }
    const settings = new SettingsService({
      repo: { load: () => stored, save: (value) => (stored = value) },
      emit: vi.fn(),
    })
    const run = vi.fn(async () => undefined)
    const warn = vi.fn()
    const now = Date.UTC(2026, 10, 26)
    const scheduler = new BackupScheduler({
      settings,
      run,
      now: () => now,
      logger: { ...silentLogger, warn },
    })
    expect(await scheduler.tick()).toBe(false)
    settings.update({ backup: { ...DEFAULT_SETTINGS.backup, interval: 'daily' } })
    expect(await scheduler.tick()).toBe(true)
    settings.setInternal({
      backupState: { lastAt: now - 60 * 60 * 1000, lastFile: 'x', lastError: null, skipped: [] },
    })
    expect(await scheduler.tick()).toBe(false)
    settings.setInternal({
      backupState: { lastAt: now - 25 * 60 * 60 * 1000, lastFile: 'x', lastError: null, skipped: [] },
    })
    run.mockRejectedValueOnce(new AppError('JOB_BUSY', 'ocupado'))
    expect(await scheduler.tick()).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledTimes(2)
  })
})
