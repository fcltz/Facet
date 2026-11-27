import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path, { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import { parseCookies } from '@shared/cookies/formats'
import { createContainer, type Container } from '@main/container'
import { assertDirectoryIdle } from '@main/browser/process'
import { silentLogger } from '@main/logger'
import { TEST_BROWSER, testBrowserDeps, useTestBrowser } from '../helpers/browser'
import { ensureBaseDirs, resolveAppPaths, type AppPaths } from '@main/paths'
import { createTestSecretBox } from '@main/security/secrets'

describe.skipIf(process.env.SKIP_BRAVE_TESTS === '1')('Pasta dos perfis e backup no Brave real', () => {
  let root: string
  let paths: AppPaths
  let app: Container

  const create = (name: string) =>
    app.services.profiles.create({
      name,
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
    })

  beforeAll(async () => {
    fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
    root = fs.mkdtempSync(resolve('.tmp-tests', 'settings-'))
    paths = resolveAppPaths(path.join(root, 'app'))
    ensureBaseDirs(paths)
    app = useTestBrowser(
      createContainer({
        ...testBrowserDeps,
        paths,
        migrationsFolder: resolve('drizzle'),
        emit: vi.fn(),
        logger: silentLogger,
        hostTimezone: 'America/Sao_Paulo',
        hostLanguages: ['pt-BR', 'pt'],
        secrets: createTestSecretBox(),
        appVersion: '0.0.0-test',
      }),
    )
    await app.initialize()
    // sem internet: os perfis destes testes não têm URLs iniciais e abrem em branco
    app.services.settings.update({ startPage: '' })
    expect(app.browsers.info(TEST_BROWSER).available).toBe(true)
  }, 60000)

  afterAll(async () => {
    if (app) {
      await app.runtime.stopAll()
      await app.close()
    }
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }, 60000)

  it('backup pula o perfil aberto; a pasta dos perfis muda e o perfil abre com os mesmos dados', async () => {
    const open = create('Aberto')
    const closed = create('Fechado')
    await app.runtime.start(closed.id)
    await app.services.cookies.import(closed.id, [
      {
        name: 'mudou',
        value: 'junto',
        domain: 'example.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: false,
        secure: false,
        sameSite: null,
        partitionKey: null,
      },
    ])
    await app.runtime.stop(closed.id)
    await app.runtime.start(open.id)

    const backup = await app.services.backup.run(randomUUID(), true)
    expect(backup).toMatchObject({ profiles: 1, skipped: ['Aberto'] })
    expect(app.services.settings.get().backupState.skipped).toEqual(['Aberto'])

    // Com um perfil aberto a mudança é recusada; fechado, as pastas mudam de lugar.
    const target = path.join(root, 'perfis-novos')
    expect(app.services.profilesRoot.inspect(target, false).problem).toBe('running')
    await app.runtime.stop(open.id)
    const candidate = app.services.profilesRoot.inspect(target, false)
    expect(candidate).toMatchObject({ problem: null, profiles: 2, sameVolume: true })
    expect(await app.services.profilesRoot.move(randomUUID(), candidate.token)).toEqual({
      root: target,
      moved: 2,
    })
    expect(app.browsers.info(TEST_BROWSER).profilesDir).toBe(target)
    expect(fs.existsSync(path.join(paths.profilesDir, closed.id))).toBe(false)

    await app.runtime.start(closed.id)
    expect(app.sessions.get(closed.id)?.userDataDir).toBe(path.join(target, closed.id))
    const exported = parseCookies((await app.services.cookies.export(closed.id, 'json')).text)
    if (!exported.ok) throw new Error(exported.error)
    expect(exported.cookies.find((cookie) => cookie.name === 'mudou')?.value).toBe('junto')
    await app.runtime.stop(closed.id)
    await assertDirectoryIdle(app.files.directory(closed.id))
  }, 180000)
})
