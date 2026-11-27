import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createContainer, type Container } from '@main/container'
import { silentLogger } from '@main/logger'
import { TEST_BROWSER, testBrowserDeps, useTestBrowser } from '../helpers/browser'
import { ensureBaseDirs, resolveAppPaths, type AppPaths } from '@main/paths'
import { CdpClient } from '@main/browser/cdp/client'
import { assertDirectoryIdle, inspectProcess } from '@main/browser/process'
import { proxies } from '@main/db/schema'
import { openExtensionPage, readStorage, writeStorage } from '@main/extensions/autoconfig'
import { GEO_PROVIDERS, type GeoProvider, type GeoProviderId } from '@main/proxy/geoip/providers'
import { IDENTITY_EXTENSION_ID, ungroupIdentityTabs } from '@main/identity/extension'
import { createTestSecretBox } from '@main/security/secrets'
import { DEFAULT_LAUNCH_OPTIONS, formatSerial } from '@shared/schemas/profile'
import { proxyCreateSchema, type ProxySummary } from '@shared/schemas/proxy'
import { writeExtension } from '../helpers/extension-fixtures'
import {
  fakeGeoServer,
  fakeRemoteProxy,
  type FakeGeoServer,
  type FakeRemoteProxy,
} from '../helpers/fake-network'
import { browserInfobars } from '../helpers/infobars'
import { gatherCandidates, stunServer } from '../helpers/stun'
import { taskbarButtons } from '../helpers/taskbar'

const PROXY_PASSWORD = 'p@ss:w/rd-integração'

function localProviders(url: string): Record<GeoProviderId, GeoProvider> {
  const local = (provider: GeoProvider): GeoProvider => ({ ...provider, url: () => url })
  return {
    ipwhois: local(GEO_PROVIDERS.ipwhois),
    geojs: local(GEO_PROVIDERS.geojs),
    ipinfo: local(GEO_PROVIDERS.ipinfo),
    ipapi: local(GEO_PROVIDERS.ipapi),
  }
}

// Exige Brave instalado. CI sem navegador pode definir SKIP_BRAVE_TESTS=1.
describe.skipIf(process.env.SKIP_BRAVE_TESTS === '1')('Brave real em pastas temporárias', () => {
  let directory: string
  let paths: AppPaths
  let app: Container
  let server: Server
  let url: string
  let port: number
  let geo: FakeGeoServer
  let remote: FakeRemoteProxy
  /** Caminhos pedidos ao servidor da página de teste, na ordem. */
  const requests: string[] = []
  const clients: CdpClient[] = []
  const secrets = createTestSecretBox()
  const make = (): Container =>
    useTestBrowser(
      createContainer({
        ...testBrowserDeps,
        paths,
        migrationsFolder: resolve('drizzle'),
        emit: vi.fn(),
        logger: silentLogger,
        hostTimezone: 'America/Sao_Paulo',
        secrets,
        // checagem, geo-IP e IP real da conexão em servidores locais (sem internet); o IP real
        // sem cache permite trocá-lo no meio da suíte
        network: {
          traceUrl: geo.traceUrl,
          geoProviders: localProviders(geo.geoUrl),
          realIpUrls: [geo.realIpUrl],
          realIpTtlMs: 0,
        },
        // esperas da autoconfiguração encurtadas (a extensão de teste inicia na hora)
        extensionTiming: { settleMs: 300, configVerifyMs: 600 },
        // utilitário real da barra de tarefas (compilado no beforeAll)
        windowHelperPath: process.platform === 'win32' ? resolve('build', 'facet-win-helper.exe') : null,
      }),
    )
  const create = (name: string) =>
    app.services.profiles.create({
      name,
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: { ...structuredClone(DEFAULT_LAUNCH_OPTIONS), startupUrls: [url], restoreTabs: true },
    })
  /** O proxy autenticado de teste (cadastrado uma vez). */
  const remoteProxy = (): ProxySummary =>
    app.services.proxies.list().find((proxy) => proxy.port === remote.port) ??
    app.services.proxies.create(
      proxyCreateSchema.parse({
        name: 'Remoto de teste',
        type: 'http',
        host: '127.0.0.1',
        port: remote.port,
        username: 'user',
        password: PROXY_PASSWORD,
        changeIpUrl: '',
        notes: '',
      }),
    )
  async function page(id: string, container: Container = app) {
    const endpoint = container.sessions.get(id)?.wsEndpoint
    if (!endpoint) throw new Error('Sessão sem endpoint')
    const client = await CdpClient.connect(endpoint)
    clients.push(client)
    let targetId = ''
    await vi.waitFor(
      async () => {
        const target = (await client.send('Target.getTargets', {})).targetInfos.find(
          (t) => t.type === 'page' && t.url.startsWith(url),
        )
        expect(target).toBeDefined()
        targetId = target!.targetId
      },
      { timeout: 10000, interval: 100 },
    )
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    const evaluate = async (expression: string, awaitPromise = false): Promise<unknown> => {
      const response = await client.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise },
        sessionId,
      )
      if (response.exceptionDetails)
        throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
      return response.result.value
    }
    await vi.waitFor(
      async () =>
        expect(
          await evaluate(
            `document.readyState === 'complete' && location.href.startsWith(${JSON.stringify(url)})`,
          ),
        ).toBe(true),
      {
        timeout: 10000,
        interval: 100,
      },
    )
    return { client, evaluate, targetId, sessionId }
  }
  beforeAll(async () => {
    if (process.platform === 'win32') {
      const built = spawnSync(process.execPath, [resolve('scripts', 'build-win-helper.mjs')], {
        encoding: 'utf8',
      })
      expect(built.status, built.stderr).toBe(0)
    }
    fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
    directory = fs.mkdtempSync(resolve('.tmp-tests', 'brave-'))
    paths = resolveAppPaths(directory)
    ensureBaseDirs(paths)
    geo = await fakeGeoServer()
    remote = await fakeRemoteProxy({ username: 'user', password: PROXY_PASSWORD })
    app = make()
    await app.initialize()
    // sem internet: perfis sem URLs iniciais abrem em branco (o teste da página inicial usa um local)
    app.services.settings.update({ startPage: '' })
    expect(
      app.browsers.info(TEST_BROWSER),
      'A validação deve conectar ao CDP do Brave instalado',
    ).toMatchObject({
      available: true,
    })
    server = createServer((request, response) => {
      requests.push(request.url ?? '/')
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<!doctype html><title>Facet isolation test</title><h1>Local fixture</h1>')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Porta HTTP indisponível')
    port = address.port
    url = `http://127.0.0.1:${port}/`
  }, 60000)
  afterAll(async () => {
    for (const client of clients) client.close()
    if (app) {
      await app.runtime.stopAll()
      await app.close()
    }
    if (server)
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())))
    await remote?.close()
    await geo?.close()
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }, 60000)

  it('isola cookies/localStorage, deduplica abertura, reconecta CDP e preserva dados e URLs ao reiniciar', async () => {
    const a = create('Perfil A')
    const b = create('Perfil B')
    const launch = vi.spyOn(app.browsers.get(TEST_BROWSER), 'launch')
    const result = await Promise.all([
      app.services.profiles.start([a.id, b.id]),
      app.services.profiles.start([a.id]),
    ])
    expect(
      result.every((r) => r.failed.length === 0),
      JSON.stringify(result),
    ).toBe(true)
    expect(launch).toHaveBeenCalledTimes(2)
    expect(app.sessions.get(a.id)?.cdpPort).not.toBe(app.sessions.get(b.id)?.cdpPort)
    const pa = await page(a.id)
    const pb = await page(b.id)
    expect(
      (await pa.client.send('Target.getTargets', {})).targetInfos
        .filter((t) => t.type === 'page')
        .map((t) => t.url),
      'Abas na primeira abertura',
    ).toEqual([url])
    await pa.evaluate(
      "document.cookie='account=A; max-age=3600; path=/'; localStorage.setItem('account','A')",
    )
    expect(await pb.evaluate("({cookie:document.cookie, storage:localStorage.getItem('account')})")).toEqual({
      cookie: '',
      storage: null,
    })
    await pb.evaluate(
      "document.cookie='account=B; max-age=3600; path=/'; localStorage.setItem('account','B')",
    )
    expect(await pa.evaluate("({cookie:document.cookie, storage:localStorage.getItem('account')})")).toEqual({
      cookie: 'account=A',
      storage: 'A',
    })
    // Derruba apenas o transporte CDP do gerente, mantendo o processo real.
    const call = launch.mock.calls.findIndex(([profile]) => profile.id === a.id)
    const launched = await launch.mock.results[call]!.value
    launched.client.close()
    expect(app.runtime.status(a.id)).toBe('disconnected')
    await vi.waitFor(() => expect(app.runtime.status(a.id)).toBe('running'), {
      timeout: 30000,
      interval: 200,
    })
    expect(app.services.profiles.get(a.id).openCount).toBe(1)
    expect(
      (await pa.client.send('Target.getTargets', {})).targetInfos
        .filter((t) => t.type === 'page')
        .map((t) => t.url),
      'Abas após reconectar CDP',
    ).toEqual([url])
    await pa.evaluate("history.pushState({}, '', '/restored')")
    await vi.waitFor(() => expect(app.sessions.getUrls(a.id)).toContain(`${url}restored`), { timeout: 5000 })
    expect((await app.services.profiles.stop([a.id])).failed).toEqual([])
    expect(app.sessions.getUrls(a.id), 'URLs gravadas antes de reiniciar').toEqual([`${url}restored`])
    await assertDirectoryIdle(app.files.directory(a.id))
    expect(app.services.profiles.get(a.id).lastClosedAt).not.toBeNull()
    expect((await app.services.profiles.start([a.id])).failed).toEqual([])
    const restored = await page(a.id)
    expect(
      await restored.evaluate(
        "({cookie:document.cookie, storage:localStorage.getItem('account'), path:location.pathname})",
      ),
    ).toEqual({ cookie: 'account=A', storage: 'A', path: '/restored' })
    expect(app.services.profiles.get(a.id).openCount).toBe(2)
    // Fechar todas as abas visíveis equivale ao fechamento das janelas pelo usuário.
    const tabs = (await restored.client.send('Target.getTargets', {})).targetInfos.filter(
      (t) => t.type === 'page',
    )
    expect(
      tabs.filter((t) => t.url.startsWith(url)),
      JSON.stringify(tabs.map((t) => t.url)),
    ).toHaveLength(1)
    for (const tab of tabs)
      await restored.client.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined)
    await vi.waitFor(() => expect(app.runtime.status(a.id)).toBe('stopped'), {
      timeout: 30000,
      interval: 200,
    })
    expect(app.runtime.status(b.id)).toBe('running')
    expect((await app.services.profiles.stop([b.id])).failed).toEqual([])
    expect(app.sessions.list()).toEqual([])
    launch.mockRestore()
  }, 120000)

  it('cancela uma abertura após o spawn e não deixa processo órfão', async () => {
    const profile = create('Cancelado')
    const starting = app.services.profiles.start([profile.id])
    await vi.waitFor(() => expect(app.sessions.get(profile.id)?.pid).toBeGreaterThan(0), {
      timeout: 30000,
      interval: 100,
    })
    const stopped = await app.services.profiles.stop([profile.id])
    expect(stopped.failed).toEqual([])
    expect((await starting).failed).toHaveLength(1)
    expect(app.runtime.status(profile.id)).toBe('stopped')
    expect(app.sessions.get(profile.id)).toBeNull()
    await assertDirectoryIdle(app.files.directory(profile.id))
  }, 60000)

  it('bloqueia perfil com proxy fora do ar antes de criar a pasta ou abrir conexão direta', async () => {
    const proxyId = randomUUID()
    app.database.db
      .insert(proxies)
      .values({
        id: proxyId,
        type: 'http',
        host: '127.0.0.1',
        port: 9,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    const profile = create('Exige proxy')
    app.services.profiles.assignProxy([profile.id], proxyId)
    const result = await app.services.profiles.start([profile.id])
    expect(result.failed[0]?.error.code).toBe('PROXY_UNREACHABLE')
    expect(fs.existsSync(app.files.directory(profile.id))).toBe(false)
    expect(app.sessions.get(profile.id)).toBeNull()
    expect(app.pool.port(profile.id)).toBeNull()
    expect(app.runtime.status(profile.id)).toBe('error')
  })

  it('bloqueia perfil cujo proxy sai pelo IP real desta conexão, sem criar a pasta nem abrir o Brave', async () => {
    const proxy = remoteProxy()
    const profile = create('Proxy com IP real')
    app.services.profiles.assignProxy([profile.id], proxy.id)
    const exit = geo.current()
    geo.setRealIp(exit.ip)
    try {
      const result = await app.services.profiles.start([profile.id])
      expect(result.failed[0]?.error.code).toBe('PROXY_REAL_IP')
      expect(fs.existsSync(app.files.directory(profile.id))).toBe(false)
      expect(app.sessions.get(profile.id)).toBeNull()
      expect(app.pool.port(profile.id)).toBeNull()
      const [checked] = await app.services.proxies.check([proxy.id])
      expect(checked?.outcome).toMatchObject({
        status: 'offline',
        exitIp: exit.ip,
        error: { code: 'PROXY_REAL_IP' },
      })
      // SQLite: o IP e o local medidos ficam gravados para a lista explicar
      expect(app.services.proxies.get(proxy.id)).toMatchObject({
        checkStatus: 'offline',
        lastErrorCode: 'PROXY_REAL_IP',
        exitIp: exit.ip,
        countryCode: exit.countryCode,
        city: exit.city,
      })
    } finally {
      geo.setRealIp(null)
    }
    // a conexão voltou a ter outro IP: o mesmo proxy volta a ser aceito
    const [again] = await app.services.proxies.check([proxy.id])
    expect(again?.outcome).toMatchObject({ status: 'online', exitIp: exit.ip, error: null })
  })

  it('passa todo o tráfego pelo proxy autenticado, sem senha na linha de comando, sem WebRTC e com falha fechada', async () => {
    const proxy = remoteProxy()
    const profile = create('Com proxy')
    app.services.profiles.assignProxy([profile.id], proxy.id)
    const direct = create('Direto (controle)')
    const started = await app.services.profiles.start([profile.id, direct.id])
    expect(started.failed, JSON.stringify(started.failed)).toEqual([])

    const session = app.sessions.get(profile.id)!
    expect(session.proxyId).toBe(proxy.id)
    expect(session.localProxyPort).toBe(app.pool.port(profile.id))
    const identity = await inspectProcess(session.pid!)
    const commandLine = identity!.args.join(' ')
    expect(commandLine).toContain(`--proxy-server=http://127.0.0.1:${session.localProxyPort}`)
    expect(commandLine).toContain('--proxy-bypass-list=<-loopback>')
    expect(commandLine).not.toContain(PROXY_PASSWORD)
    expect(commandLine).not.toContain(encodeURIComponent(PROXY_PASSWORD))
    const preferences = JSON.parse(
      fs.readFileSync(join(session.userDataDir, 'Default', 'Preferences'), 'utf8'),
    )
    expect(preferences.webrtc.ip_handling_policy).toBe('disable_non_proxied_udp')
    // "Restringir UDP ao proxy" sem proxy não restringe: o IP visto pelos sites já é o real.
    const directPreferences = JSON.parse(
      fs.readFileSync(join(app.sessions.get(direct.id)!.userDataDir, 'Default', 'Preferences'), 'utf8'),
    )
    expect(directPreferences.webrtc.ip_handling_policy).toBe('default')

    // a página de teste (127.0.0.1) só chega ao Brave através do proxy remoto autenticado
    const viaProxy = await page(profile.id)
    expect(remote.seen).toContain(`127.0.0.1:${port}`)

    // WebRTC: o perfil com proxy não expõe nenhum candidato; o controle sem proxy expõe
    const stun = await stunServer()
    try {
      expect(await viaProxy.evaluate(gatherCandidates(stun.port), true)).toEqual([])
      expect(stun.requests(), 'nenhum pacote STUN pode sair do perfil com proxy').toBe(0)
      const control = await page(direct.id)
      const candidates = (await control.evaluate(gatherCandidates(stun.port), true)) as string[]
      expect(candidates.length, 'o controle sem proxy deve gerar candidatos').toBeGreaterThan(0)
    } finally {
      await stun.close()
    }

    // falha fechada: sem o proxy local, a navegação não sai pela conexão direta
    await app.pool.close(profile.id)
    const seenBefore = remote.seen.length
    await viaProxy.client.send('Page.navigate', { url: `${url}?depois-do-proxy` }, viaProxy.sessionId)
    await new Promise((done) => setTimeout(done, 2500))
    expect(requests.filter((path) => path.includes('depois-do-proxy'))).toEqual([])
    expect(remote.seen.length).toBe(seenBefore)

    expect((await app.services.profiles.stop([profile.id, direct.id])).failed).toEqual([])
    expect(app.sessions.list()).toEqual([])
  }, 120000)

  it('após queda do Facet, recria o proxy local na mesma porta e o perfil continua pelo proxy', async () => {
    const proxy = remoteProxy()
    const profile = create('Recuperado com proxy')
    app.services.profiles.assignProxy([profile.id], proxy.id)
    expect((await app.services.profiles.start([profile.id])).failed).toEqual([])
    const localPort = app.sessions.get(profile.id)!.localProxyPort!
    await page(profile.id)

    // Queda simulada: o Facet some sem fechar o Brave e o proxy local morre junto.
    ;(app.runtime as unknown as { entries: Map<string, unknown> }).entries.clear()
    await app.pool.closeAll()

    const recovered = make()
    try {
      await recovered.initialize()
      await vi.waitFor(() => expect(recovered.runtime.status(profile.id)).toBe('running'), {
        timeout: 30000,
        interval: 200,
      })
      expect(recovered.pool.port(profile.id)).toBe(localPort)
      const tab = await page(profile.id, recovered)
      const seenBefore = remote.seen.length
      await tab.client.send('Page.navigate', { url: `${url}?apos-recuperar` }, tab.sessionId)
      await vi.waitFor(() => expect(requests.some((path) => path.includes('apos-recuperar'))).toBe(true), {
        timeout: 15000,
        interval: 200,
      })
      expect(remote.seen.length).toBeGreaterThan(seenBefore)
      expect((await recovered.services.profiles.stop([profile.id])).failed).toEqual([])
      expect(recovered.pool.port(profile.id)).toBeNull()
    } finally {
      await recovered.runtime.stopAll()
      await recovered.close()
    }
    await assertDirectoryIdle(app.files.directory(profile.id))
  }, 120000)

  it('carrega extensões com --load-extension, aplica a autoconfiguração e fecha a boas-vindas a partir da 2ª abertura', async () => {
    const sources = fs.mkdtempSync(join(directory, 'ext-src-'))
    // onInstalled roda em TODA abertura (verificado no Brave 158): grava padrões e abre a boas-vindas
    const installSw = `chrome.runtime.onInstalled.addListener(async () => {
      const { installs = 0 } = await chrome.storage.local.get('installs')
      await chrome.storage.local.set({ theme: 'light', installs: installs + 1 })
      chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })
    })`
    const welcomeManifest = (version: string) => ({
      manifest_version: 3,
      name: 'Facet Teste Boas-vindas',
      version,
      permissions: ['storage'],
      background: { service_worker: 'sw.js' },
    })
    const welcomeDir = writeExtension(join(sources, 'welcome'), welcomeManifest('1.0.0'), {
      'sw.js': installSw,
      'welcome.html': '<!doctype html><title>Boas-vindas</title>',
    })
    const contentDir = writeExtension(
      join(sources, 'content'),
      {
        manifest_version: 3,
        name: 'Facet Teste Conteúdo',
        version: '1.0.0',
        permissions: ['storage'],
        content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['cs.js'] }],
      },
      { 'cs.js': '' },
    )
    const welcome = (await app.services.extensions.importFolder(welcomeDir)).extension
    const content = (await app.services.extensions.importFolder(contentDir)).extension
    app.services.extensions.setConfig(
      welcome.id,
      { area: 'local', mode: 'always', json: '{"theme":"dark","account":{"id":7}}' },
      false,
    )
    app.services.extensions.setConfig(
      content.id,
      { area: 'local', mode: 'once', json: '{"configured":1}' },
      false,
    )
    const profile = app.services.profiles.create({
      name: 'Com extensões',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: { ...structuredClone(DEFAULT_LAUNCH_OPTIONS), startupUrls: [url] },
      extensionIds: [welcome.id, content.id],
    })
    const welcomeUrl = `chrome-extension://${welcome.id}/welcome.html`
    const state = (id: string) =>
      app.repos.extensions.profileState(profile.id).find((item) => item.extensionId === id)
    const connect = async (): Promise<CdpClient> => {
      const client = await CdpClient.connect(app.sessions.get(profile.id)!.wsEndpoint!)
      clients.push(client)
      return client
    }
    const pageUrls = async (client: CdpClient): Promise<string[]> =>
      (await client.send('Target.getTargets', {})).targetInfos
        .filter((t) => t.type === 'page')
        .map((t) => t.url)
    const storage = async (client: CdpClient, id: string) => {
      const extensionPage = await openExtensionPage(client, id)
      try {
        return await readStorage(client, extensionPage.sessionId, 'local', null)
      } finally {
        await extensionPage.close()
      }
    }

    // 1ª abertura: tudo carregado, configuração aplicada por cima dos padrões da extensão
    expect((await app.services.profiles.start([profile.id])).failed).toEqual([])
    expect(app.sessions.get(profile.id)?.extensionDirs).toHaveLength(2)
    let client = await connect()
    expect((await client.send('Extensions.getExtensions', undefined)).extensions.map((e) => e.id)).toEqual(
      expect.arrayContaining([welcome.id, content.id]),
    )
    await vi.waitFor(
      () => {
        expect(state(welcome.id)?.configAppliedAt).not.toBeNull()
        expect(state(content.id)?.configAppliedAt).not.toBeNull()
      },
      { timeout: 20000, interval: 200 },
    )
    expect(await storage(client, welcome.id)).toMatchObject({
      theme: 'dark',
      account: { id: 7 },
      installs: 1,
    })
    expect(await storage(client, content.id)).toEqual({ configured: 1 })
    expect(state(welcome.id)?.firstLoadedAt).not.toBeNull()
    // na primeira abertura com a extensão, a página de boas-vindas fica
    await vi.waitFor(async () => expect(await pageUrls(client)).toContain(welcomeUrl), {
      timeout: 10000,
      interval: 200,
    })
    // o usuário muda a configuração da extensão "só na 1ª abertura" dentro do navegador
    const contentPage = await openExtensionPage(client, content.id)
    await writeStorage(client, contentPage.sessionId, 'local', '{"configured":2}')
    await contentPage.close()
    const firstApplied = state(welcome.id)!.configAppliedAt!
    expect((await app.services.profiles.stop([profile.id])).failed).toEqual([])

    // 2ª abertura: "toda abertura" reaplica, "1ª abertura" não, e a boas-vindas é fechada
    expect((await app.services.profiles.start([profile.id])).failed).toEqual([])
    client = await connect()
    await vi.waitFor(() => expect(state(welcome.id)?.configAppliedAt).toBeGreaterThan(firstApplied), {
      timeout: 20000,
      interval: 200,
    })
    const reapplied = await storage(client, welcome.id)
    expect(reapplied).toMatchObject({ theme: 'dark', installs: 2 })
    expect(await storage(client, content.id)).toEqual({ configured: 2 })
    await new Promise((done) => setTimeout(done, 1500))
    const urls = await pageUrls(client)
    expect(urls).not.toContain(welcomeUrl)
    expect(urls).toContain(url)

    // trocar os arquivos com o perfil aberto: a pasta antiga só sai depois que ele fecha
    const [oldDir] = app.sessions.get(profile.id)!.extensionDirs!.filter((key) => key.startsWith(welcome.id))
    writeExtension(welcomeDir, welcomeManifest('1.1.0'), { 'sw.js': installSw })
    const replaced = await app.services.extensions.replace(welcome.id, 'folder', welcomeDir)
    expect(replaced).toMatchObject({ status: 'updated', extension: { id: welcome.id, version: '1.1.0' } })
    const oldPath = join(app.extensionStore.root, oldDir!)
    expect(fs.existsSync(oldPath)).toBe(true)
    expect((await app.services.profiles.stop([profile.id])).failed).toEqual([])
    expect(fs.existsSync(oldPath)).toBe(false)
    expect(fs.readdirSync(join(app.extensionStore.root, welcome.id))).toHaveLength(1)
    await assertDirectoryIdle(app.files.directory(profile.id))
  }, 150000)

  it('identifica o perfil aberto: ícone fixado, grupo roxo com ID e nome, barra de tarefas e grupo desfeito ao fechar', async () => {
    const profile = create('Identificado')
    const label = `${formatSerial(profile.serial)} · Identificado`
    const tagged: number[] = []
    const stopListening = app.identity.windows.onTagged((pid, windows) => {
      if (windows > 0) tagged.push(pid)
    })
    try {
      expect((await app.services.profiles.start([profile.id])).failed).toEqual([])
      const client = app.runtime.client(profile.id)!
      const evaluate = async (expression: string): Promise<unknown> => {
        const page = await openExtensionPage(client, IDENTITY_EXTENSION_ID)
        try {
          const response = await client.send(
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true },
            page.sessionId,
          )
          if (response.exceptionDetails) throw new Error(response.exceptionDetails.text)
          return response.result.value
        } finally {
          await page.close()
        }
      }
      const groups = async () =>
        (await evaluate('chrome.tabGroups.query({})')) as { id: number; title: string; color: string }[]

      // extensão carregada e fixada; grupos salvos escondidos da barra de favoritos
      const { extensions } = await client.send('Extensions.getExtensions', undefined)
      expect(extensions.map((extension) => extension.id)).toContain(IDENTITY_EXTENSION_ID)
      const prefs = JSON.parse(
        fs.readFileSync(join(app.files.directory(profile.id), 'Default', 'Preferences'), 'utf8'),
      ) as { extensions: { pinned_extensions: string[] }; bookmark_bar: { show_tab_groups: boolean } }
      expect(prefs.extensions.pinned_extensions[0]).toBe(IDENTITY_EXTENSION_ID)
      expect(prefs.bookmark_bar.show_tab_groups).toBe(false)

      // grupo roxo "NN · Nome" com a aba inicial; uma aba nova entra no mesmo grupo
      await vi.waitFor(
        async () =>
          expect(await groups()).toEqual([expect.objectContaining({ title: label, color: 'purple' })]),
        { timeout: 15000, interval: 250 },
      )
      await client.send('Target.createTarget', { url: `${url}?identidade` })
      await vi.waitFor(
        async () => {
          const [ours] = await groups()
          const tabGroups = (await evaluate(
            'chrome.tabs.query({}).then((tabs) => tabs.map((tab) => tab.groupId))',
          )) as number[]
          expect(tabGroups.length).toBeGreaterThanOrEqual(2)
          expect(tabGroups.every((id) => id === ours!.id)).toBe(true)
        },
        { timeout: 10000, interval: 250 },
      )

      // barra de tarefas: o utilitário marcou a janela e o botão próprio aparece com o rótulo
      if (process.platform === 'win32') {
        const pid = app.sessions.get(profile.id)!.pid!
        await vi.waitFor(() => expect(tagged).toContain(pid), { timeout: 15000, interval: 200 })
        const buttons = await taskbarButtons(label)
        if (buttons !== null) expect(buttons.length, `botões com "${label}"`).toBeGreaterThan(0)
      }

      // nome novo com o perfil aberto: o grupo muda na hora
      app.services.profiles.update(profile.id, { name: 'Renomeado' })
      const renamed = `${formatSerial(profile.serial)} · Renomeado`
      await vi.waitFor(async () => expect((await groups()).map((group) => group.title)).toEqual([renamed]), {
        timeout: 10000,
        interval: 250,
      })

      // grupo do usuário fica intacto; o do Facet é desfeito antes do Browser.close
      await evaluate(`chrome.tabs.create({ url: 'about:blank', active: false })
        .then((tab) => new Promise((done) => setTimeout(() => done(tab), 500)))
        .then((tab) => chrome.tabs.group({ tabIds: [tab.id] }))
        .then((groupId) => chrome.tabGroups.update(groupId, { title: 'Do usuário', color: 'green' }))`)
      expect((await groups()).map((group) => group.title).sort()).toEqual([renamed, 'Do usuário'].sort())
      await ungroupIdentityTabs(client)
      expect((await groups()).map((group) => group.title)).toEqual(['Do usuário'])
      const sent: string[] = []
      const send = client.send.bind(client)
      client.send = ((method: string, params?: Record<string, unknown>, ...rest: unknown[]) => {
        sent.push(typeof params?.url === 'string' ? `${method} ${params.url}` : method)
        return (send as (...args: unknown[]) => Promise<unknown>)(method, params, ...rest)
      }) as typeof client.send
      expect((await app.services.profiles.stop([profile.id])).failed).toEqual([])
      const opened = sent.findIndex((entry) =>
        entry.startsWith(`Target.createTarget chrome-extension://${IDENTITY_EXTENSION_ID}/`),
      )
      expect(opened, sent.join('\n')).toBeGreaterThan(-1)
      expect(opened).toBeLessThan(sent.indexOf('Browser.close'))
      expect(app.identity.store.directory(profile.id)).toBe(join(paths.identityDir, profile.id))
    } finally {
      stopListening()
      await app.services.profiles.stop([profile.id]).catch(() => undefined)
    }
  }, 120000)

  it('sem URLs iniciais abre na página inicial das configurações, sem barra de aviso e com webdriver falso; vazio = em branco', async () => {
    const startPage = `${url}inicio`
    const profile = app.services.profiles.create({
      name: 'Página inicial',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
    })
    const pageUrls = async (): Promise<string[]> =>
      (await app.runtime.client(profile.id)!.send('Target.getTargets', {})).targetInfos
        .filter((target) => target.type === 'page')
        .map((target) => target.url)
    try {
      app.services.settings.update({ startPage })
      const before = requests.length
      expect((await app.services.profiles.start([profile.id])).failed).toEqual([])
      const opened = await page(profile.id)
      // só a página configurada: a primeira aba do Brave (em branco, com a barra) foi fechada
      expect(await pageUrls()).toEqual([startPage])
      expect(requests.slice(before)).toContain('/inicio')
      expect(await opened.evaluate('navigator.webdriver')).toBe(false)
      if (process.platform === 'win32') {
        const bars = await browserInfobars(app.sessions.get(profile.id)!.pid!)
        if (bars !== null) expect(bars, 'barras de aviso na janela').toEqual([])
      }
      const localState = JSON.parse(
        fs.readFileSync(join(app.files.directory(profile.id), 'Local State'), 'utf8'),
      ) as { brave: { p3a: Record<string, unknown> } }
      expect(localState.brave.p3a).toMatchObject({ enabled: false, notice_acknowledged: true })
      expect((await app.services.profiles.stop([profile.id])).failed).toEqual([])

      // campo vazio: uma aba em branco, também sem a barra
      app.services.settings.update({ startPage: '' })
      expect((await app.services.profiles.start([profile.id])).failed).toEqual([])
      await vi.waitFor(async () => expect(await pageUrls()).toEqual(['about:blank']), {
        timeout: 5000,
        interval: 100,
      })
      if (process.platform === 'win32') {
        const bars = await browserInfobars(app.sessions.get(profile.id)!.pid!)
        if (bars !== null) expect(bars, 'barras de aviso na janela').toEqual([])
      }
      expect((await app.services.profiles.stop([profile.id])).failed).toEqual([])
      await assertDirectoryIdle(app.files.directory(profile.id))
    } finally {
      app.services.settings.update({ startPage: '' })
      await app.services.profiles.stop([profile.id]).catch(() => undefined)
    }
  }, 120000)

  it.each([
    { scenario: 'sem resposta', delayMs: null },
    { scenario: 'com resposta após 7 segundos', delayMs: 7000 },
  ])(
    'página inicial $scenario não impede o perfil de abrir',
    async ({ delayMs }) => {
      const sockets = new Set<Socket>()
      const timers = new Set<ReturnType<typeof setTimeout>>()
      let received = 0
      const stuck = createServer((_request, response) => {
        received++
        if (delayMs === null) return
        const timer = setTimeout(() => {
          timers.delete(timer)
          response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
          response.end('<!doctype html><title>Facet delayed page</title><h1>Loaded after 7 seconds</h1>')
        }, delayMs)
        timers.add(timer)
      })
      stuck.on('connection', (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
      })
      await new Promise<void>((done) => stuck.listen(0, '127.0.0.1', done))
      const startPage = `http://127.0.0.1:${(stuck.address() as AddressInfo).port}/travada`
      const profile = app.services.profiles.create({
        name: 'Página travada',
        os: 'windows',
        groupId: null,
        proxyId: null,
        tagIds: [],
        color: null,
        notes: '',
        launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
      })
      try {
        app.services.settings.update({ startPage })
        const started = Date.now()
        expect((await app.services.profiles.start([profile.id])).failed).toEqual([])
        // abre sem esperar o prazo do pedido em segundo plano (60 s); antes, falhava em 5 s
        expect(Date.now() - started).toBeLessThan(30000)
        expect(app.runtime.status(profile.id)).toBe('running')
        expect(received).toBeGreaterThan(0)
        // a aba da página continua carregando; a aba em branco do início foi fechada
        const urls = (await app.runtime.client(profile.id)!.send('Target.getTargets', {})).targetInfos
          .filter((target) => target.type === 'page')
          .map((target) => target.url)
        expect(urls).toEqual([startPage])
        if (delayMs !== null) {
          // A navegação continua depois de o perfil ficar rodando: não é cancelada aos 5 s.
          await vi.waitFor(
            async () => {
              const targets = await app.runtime.client(profile.id)!.send('Target.getTargets', {})
              expect(targets.targetInfos.find((target) => target.url === startPage)?.title).toBe(
                'Facet delayed page',
              )
            },
            { timeout: 15000, interval: 100 },
          )
          expect(app.runtime.status(profile.id)).toBe('running')
        }
        expect((await app.services.profiles.stop([profile.id])).failed).toEqual([])
        await assertDirectoryIdle(app.files.directory(profile.id))
      } finally {
        app.services.settings.update({ startPage: '' })
        await app.services.profiles.stop([profile.id]).catch(() => undefined)
        for (const timer of timers) clearTimeout(timer)
        for (const socket of sockets) socket.destroy()
        await new Promise<void>((done) => stuck.close(() => done()))
      }
    },
    120000,
  )
})
