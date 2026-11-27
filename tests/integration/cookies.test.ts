import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { parseCookies } from '@shared/cookies/formats'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import type { BrowserCookie } from '@shared/schemas/cookies'
import { createContainer, type Container } from '@main/container'
import { assertDirectoryIdle } from '@main/browser/process'
import { silentLogger } from '@main/logger'
import { TEST_BROWSER, testBrowserDeps, useTestBrowser } from '../helpers/browser'
import { ensureBaseDirs, resolveAppPaths, type AppPaths } from '@main/paths'
import { createTestSecretBox } from '@main/security/secrets'

const FUTURE = Math.floor(Date.now() / 1000) + 86400 * 30

const cookie = (name: string, value: string, patch: Partial<BrowserCookie> = {}): BrowserCookie => ({
  name,
  value,
  domain: '127.0.0.1',
  path: '/',
  expires: FUTURE,
  httpOnly: false,
  secure: false,
  sameSite: null,
  partitionKey: null,
  ...patch,
})

describe.skipIf(process.env.SKIP_BRAVE_TESTS === '1')('Cookies no Brave real', () => {
  let directory: string
  let paths: AppPaths
  let app: Container
  let server: Server
  let url: string
  const requests: { path: string; cookie: string }[] = []
  const emit = vi.fn()

  beforeAll(async () => {
    fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
    directory = fs.mkdtempSync(resolve('.tmp-tests', 'cookies-'))
    paths = resolveAppPaths(directory)
    ensureBaseDirs(paths)
    server = createServer((request, response) => {
      requests.push({ path: request.url ?? '/', cookie: request.headers.cookie ?? '' })
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      response.end('<!doctype html><title>cookies</title>')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Porta indisponível')
    url = `http://127.0.0.1:${address.port}`
    app = useTestBrowser(
      createContainer({
        ...testBrowserDeps,
        paths,
        migrationsFolder: resolve('drizzle'),
        emit,
        logger: silentLogger,
        hostTimezone: 'America/Sao_Paulo',
        hostLanguages: ['pt-BR', 'pt'],
        secrets: createTestSecretBox(),
      }),
    )
    await app.initialize()
    expect(app.browsers.info(TEST_BROWSER).available).toBe(true)
  }, 60000)

  afterAll(async () => {
    if (app) {
      await app.runtime.stopAll()
      await app.close()
    }
    await new Promise<void>((done) => server?.close(() => done()))
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }, 60000)

  it('pendentes chegam na 1ª requisição; exporta aberto (CDP) e fechado (headless sem rede)', async () => {
    const profile = app.services.profiles.create({
      name: 'Cookies',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: { ...structuredClone(DEFAULT_LAUNCH_OPTIONS), startupUrls: [`${url}/page`] },
    })
    const imported = await app.services.cookies.import(profile.id, [
      cookie('host', '1'),
      cookie('http', '2', { httpOnly: true }),
      cookie('session', '3', { expires: null }),
      cookie('dom', '4', { domain: '.example.org' }),
      cookie('chips', '5', {
        domain: 'embed.example.org',
        secure: true,
        sameSite: 'None',
        partitionKey: { topLevelSite: 'https://example.net', hasCrossSiteAncestor: true },
      }),
      cookie('__Host-bad', '6', { domain: '.example.org', secure: true }),
    ])
    expect(imported).toMatchObject({ applied: 'pending', imported: 5, pending: 5 })
    expect(imported.failed).toEqual([{ name: '__Host-bad', domain: '.example.org', reason: 'hostPrefix' }])

    await app.runtime.start(profile.id)
    await vi.waitFor(() => expect(requests.some((request) => request.path === '/page')).toBe(true), {
      timeout: 15000,
    })
    // Primeira requisição do perfil já leva os cookies importados (inclusive httpOnly e de sessão).
    const first = requests.find((request) => request.path === '/page')!
    expect(first.cookie.split('; ').sort()).toEqual(['host=1', 'http=2', 'session=3'])
    expect(emit).toHaveBeenCalledWith('cookies.applied', {
      profileId: profile.id,
      imported: 5,
      failed: 0,
      error: null,
    })
    expect(app.services.cookies.status(profile.id)).toMatchObject({ pending: 0, running: true })

    // Aberto: importa na hora e exporta via CDP.
    expect(await app.services.cookies.import(profile.id, [cookie('live', '7')])).toMatchObject({
      applied: 'now',
      imported: 1,
    })
    const live = parseCookies((await app.services.cookies.export(profile.id, 'json')).text)
    if (!live.ok) throw new Error(live.error)
    const names = (cookies: BrowserCookie[]): string[] => cookies.map((item) => item.name).sort()
    expect(names(live.cookies)).toEqual(['chips', 'dom', 'host', 'http', 'live', 'session'])
    expect(live.cookies.find((item) => item.name === 'chips')?.partitionKey).toEqual({
      topLevelSite: 'https://example.net',
      hasCrossSiteAncestor: true,
    })

    // Fechado: lê a pasta num Brave headless sem rede; o cookie de sessão morreu ao fechar.
    await app.runtime.stop(profile.id)
    const offline = parseCookies((await app.services.cookies.export(profile.id, 'netscape')).text)
    if (!offline.ok) throw new Error(offline.error)
    expect(offline.format).toBe('netscape')
    expect(names(offline.cookies)).toEqual(['chips', 'dom', 'host', 'http', 'live'])
    expect(offline.cookies.find((item) => item.name === 'http')?.httpOnly).toBe(true)
    await assertDirectoryIdle(app.files.directory(profile.id))
    expect(app.runtime.status(profile.id)).toBe('stopped')
  }, 120000)
})
