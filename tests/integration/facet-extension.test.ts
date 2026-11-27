import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createContainer, type Container } from '@main/container'
import { CdpClient } from '@main/browser/cdp/client'
import { silentLogger } from '@main/logger'
import { TEST_BROWSER, testBrowserDeps, useTestBrowser } from '../helpers/browser'
import { ensureBaseDirs, resolveAppPaths } from '@main/paths'
import { GEO_PROVIDERS, type GeoProvider, type GeoProviderId } from '@main/proxy/geoip/providers'
import { createTestSecretBox } from '@main/security/secrets'
import { FACET_EXTENSION_ID } from '@shared/facet-extension'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import { proxyCreateSchema } from '@shared/schemas/proxy'
import {
  fakeGeoServer,
  fakeRemoteProxy,
  type FakeGeoServer,
  type FakeRemoteProxy,
} from '../helpers/fake-network'

const BUNDLE = resolve('resources/facet-extension')
const POPUP = `chrome-extension://${FACET_EXTENSION_ID}/popup.html`
const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')

interface Session {
  sessionId: string
  evaluate: (expression: string) => Promise<unknown>
}
interface Rule {
  id: number
  priority: number
  action: { type: string }
  condition: Record<string, unknown>
}
interface Cosmetic {
  highly: string[]
  lowly: Record<string, string[]>
  specific: Record<string, string[]>
  exceptions: Record<string, string[]>
}

function localProviders(url: string): Record<GeoProviderId, GeoProvider> {
  const local = (provider: GeoProvider): GeoProvider => ({ ...provider, url: () => url })
  return {
    ipwhois: local(GEO_PROVIDERS.ipwhois),
    geojs: local(GEO_PROVIDERS.geojs),
    ipinfo: local(GEO_PROVIDERS.ipinfo),
    ipapi: local(GEO_PROVIDERS.ipapi),
  }
}

/**
 * Extensão Facet carregada pelo launcher real no Brave instalado, sem internet: o trace e a
 * velocidade vão para um servidor local (cópia da extensão com esses endereços trocados), um
 * domínio de teste (facet-ads.localhost, que o Chromium resolve para esta máquina) entra numa
 * regra de bloqueio e seletores de teste entram nos cosméticos. Uma regra e um seletor reais
 * das listas do uBlock Origin também são conferidos, e o gasto vem do proxy local do perfil.
 */
describe.skipIf(process.env.SKIP_BRAVE_TESTS === '1')('extensão Facet no Brave real', () => {
  let directory: string
  let app: Container
  let server: Server
  let port: number
  let geo: FakeGeoServer
  let remote: FakeRemoteProxy
  /** Caminho de uma regra de bloqueio real (EasyList/uBlock) e uma classe escondida pelos genéricos. */
  let realPath: string
  let realClass: string
  /** `host/caminho` de cada pedido recebido pelo servidor local. */
  const hits: string[] = []
  const clients: CdpClient[] = []
  const pageUrl = () => `http://127.0.0.1:${port}/page`
  const hit = (entry: string) => hits.includes(entry)

  beforeAll(async () => {
    // ícones gerados pelo build (o manifest aponta para eles)
    if (!fs.existsSync(join(BUNDLE, 'icon128.png'))) {
      const built = spawnSync(process.execPath, [resolve('scripts', 'make-icon.mjs')], { encoding: 'utf8' })
      expect(built.status, built.stderr).toBe(0)
    }
    fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
    directory = fs.mkdtempSync(resolve('.tmp-tests', 'facet-'))
    const bundle = join(directory, 'bundle')
    fs.cpSync(BUNDLE, bundle, { recursive: true })

    // regra real: caminho sem domínio nem tipo (vale para uma imagem de terceiros)
    const ads = JSON.parse(fs.readFileSync(join(bundle, 'rules', 'ads.json'), 'utf8')) as Rule[]
    const real = ads.find(
      (rule) =>
        rule.action.type === 'block' &&
        Object.keys(rule.condition).every((key) => key === 'urlFilter') &&
        typeof rule.condition.urlFilter === 'string' &&
        /^\/[a-z][a-z0-9_-]{3,}\/[a-z0-9_-]+\.[a-z]{2,4}$/i.test(rule.condition.urlFilter),
    )
    expect(real, 'regra de caminho na lista').toBeDefined()
    realPath = real!.condition.urlFilter as string
    ads.push({
      id: Math.max(...ads.map((rule) => rule.id)) + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { requestDomains: ['facet-ads.localhost'] },
    })
    fs.writeFileSync(join(bundle, 'rules', 'ads.json'), JSON.stringify(ads))
    // Como no EasyPrivacy (`||cloudflare.com/cdn-cgi/trace`, de terceiros): a consulta de IP do
    // service worker da extensão conta como de terceiro. A regra de sessão da Facet a libera.
    const privacy = JSON.parse(fs.readFileSync(join(bundle, 'rules', 'privacy.json'), 'utf8')) as Rule[]
    privacy.push({
      id: Math.max(...privacy.map((rule) => rule.id)) + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: '/cdn-cgi/trace', domainType: 'thirdParty' },
    })
    fs.writeFileSync(join(bundle, 'rules', 'privacy.json'), JSON.stringify(privacy))
    // cosméticos: um seletor real (classe) e os de teste (do site, genérico, tardio e amplo)
    const cosmetic = JSON.parse(fs.readFileSync(join(bundle, 'cosmetic.json'), 'utf8')) as Cosmetic
    const realToken = Object.entries(cosmetic.lowly).find(
      ([token, selectors]) => /^\.[a-z][a-z0-9-]{5,}$/.test(token) && selectors.includes(token),
    )?.[0]
    expect(realToken, 'seletor genérico na lista').toBeDefined()
    realClass = realToken!.slice(1)
    cosmetic.lowly['.facet-test-generic'] = ['.facet-test-generic']
    cosmetic.lowly['.facet-test-late'] = ['.facet-test-late']
    cosmetic.specific['127.0.0.1'] = ['#facet-test-specific']
    cosmetic.highly.push('[data-facet-test-highly]')
    fs.writeFileSync(join(bundle, 'cosmetic.json'), JSON.stringify(cosmetic))

    server = createServer((request, response) => {
      const host = (request.headers.host ?? '').replace(/:\d+$/, '')
      const url = new URL(request.url ?? '/', 'http://local')
      hits.push(`${host}${url.pathname}`)
      if (url.pathname === '/page') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(`<!doctype html><html><head><title>Facet</title></head><body><h1 id="title">Fixture</h1>
<img id="ad" src="http://facet-ads.localhost:${port}/ad.gif">
<img id="ok" src="http://facet-ok.localhost:${port}/ok.gif">
<img id="real" src="http://facet-ok.localhost:${port}${realPath}">
<div id="facet-test-specific">específico</div>
<div class="facet-test-generic">genérico</div>
<div data-facet-test-highly>amplo</div>
<div class="${realClass}">real</div>
<div class="facet-test-visible">visível</div>
<script>
  window.__mutations = []
  window.__events = []
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'])
    addEventListener(type, (event) => window.__events.push(type + ':' + event.target.nodeName), true)
  addEventListener('load', () => {
    new MutationObserver((records) => {
      for (const record of records) window.__mutations.push(record.type + ':' + record.target.nodeName)
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    navigator.sendBeacon('http://facet-beacon.localhost:${port}/beacon', 'x')
  })
</script></body></html>`)
      } else if (url.pathname === '/cdn-cgi/trace') {
        response.writeHead(200, { 'Content-Type': 'text/plain' })
        response.end('fl=1\nh=www.cloudflare.com\nip=203.0.113.7\nts=1\nloc=BR\n')
      } else if (url.pathname === '/__down') {
        const bytes = Math.min(Number(url.searchParams.get('bytes')) || 0, 4 * 1024 * 1024)
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes })
        response.end(Buffer.alloc(bytes, 1))
      } else if (/\.(gif|png|jpg|js)$/.test(url.pathname)) {
        response.writeHead(200, { 'Content-Type': 'image/gif' })
        response.end(GIF)
      } else {
        response.writeHead(204)
        response.end()
      }
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Porta HTTP indisponível')
    port = address.port
    const core = fs.readFileSync(join(bundle, 'core.js'), 'utf8')
    const patched = core
      .replace('https://www.cloudflare.com/cdn-cgi/trace', `http://127.0.0.1:${port}/cdn-cgi/trace`)
      .replace('https://speed.cloudflare.com/__down?bytes=', `http://127.0.0.1:${port}/__down?bytes=`)
    expect(patched.match(/127\.0\.0\.1/g)).toHaveLength(2)
    fs.writeFileSync(join(bundle, 'core.js'), patched)

    geo = await fakeGeoServer()
    remote = await fakeRemoteProxy({ username: 'user', password: 'senha' })
    const paths = resolveAppPaths(directory)
    ensureBaseDirs(paths)
    app = useTestBrowser(
      createContainer({
        ...testBrowserDeps,
        paths,
        migrationsFolder: resolve('drizzle'),
        emit: vi.fn(),
        logger: silentLogger,
        hostTimezone: 'America/Sao_Paulo',
        secrets: createTestSecretBox(),
        bundledExtensionDir: bundle,
        network: {
          traceUrl: geo.traceUrl,
          geoProviders: localProviders(geo.geoUrl),
          realIpUrls: [geo.realIpUrl],
          realIpTtlMs: 0,
        },
      }),
    )
    await app.initialize()
    app.services.settings.update({ startPage: '' })
    expect(app.browsers.info(TEST_BROWSER), 'navegador instalado').toMatchObject({ available: true })
  }, 60000)

  afterAll(async () => {
    for (const client of clients) client.close()
    if (app) {
      await app.runtime.stopAll()
      await app.close()
    }
    if (server) await new Promise<void>((done) => server.close(() => done()))
    await remote?.close()
    await geo?.close()
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }, 60000)

  async function browser(profileId: string): Promise<CdpClient> {
    const endpoint = app.sessions.get(profileId)?.wsEndpoint
    if (!endpoint) throw new Error('Sessão sem endpoint')
    const client = await CdpClient.connect(endpoint)
    clients.push(client)
    return client
  }

  async function attach(client: CdpClient, targetId: string): Promise<Session> {
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    return {
      sessionId,
      evaluate: async (expression) => {
        const response = await client.send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId,
        )
        if (response.exceptionDetails)
          throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
        return response.result.value
      },
    }
  }

  /** A aba da página de teste, já carregada. */
  async function page(client: CdpClient): Promise<Session> {
    let targetId = ''
    await vi.waitFor(
      async () => {
        const target = (await client.send('Target.getTargets', {})).targetInfos.find(
          (info) => info.type === 'page' && info.url.startsWith(pageUrl()),
        )
        expect(target).toBeDefined()
        targetId = target!.targetId
      },
      { timeout: 15000, interval: 100 },
    )
    const session = await attach(client, targetId)
    await vi.waitFor(async () => expect(await session.evaluate('document.readyState')).toBe('complete'), {
      timeout: 15000,
      interval: 100,
    })
    return session
  }

  /** O popup da extensão aberto numa aba (mesmas mensagens que o popup da barra envia). */
  async function popup(client: CdpClient) {
    const { targetId } = await client.send('Target.createTarget', { url: POPUP })
    const session = await attach(client, targetId)
    // a aba nasce em about:blank (que já está "complete"): espera o popup da extensão carregar
    await vi.waitFor(
      async () =>
        expect(
          await session.evaluate(
            `location.href === ${JSON.stringify(POPUP)} && document.readyState === 'complete' && Boolean(globalThis.chrome?.privacy)`,
          ),
        ).toBe(true),
      { timeout: 10000, interval: 100 },
    )
    const send = async (message: Record<string, unknown>) => {
      const result = (await session.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`)) as {
        ok: boolean
        data: {
          settings: Record<string, boolean>
          metrics: { ip: string } | null
          usage: { total: number } | null
        }
      }
      expect(result.ok, JSON.stringify(result)).toBe(true)
      return result.data
    }
    return {
      send,
      evaluate: session.evaluate,
      prediction: () =>
        session.evaluate('chrome.privacy.network.networkPredictionEnabled.get({})') as Promise<{
          value: boolean
          levelOfControl: string
        }>,
      close: () => client.send('Target.closeTarget', { targetId }),
    }
  }

  const indicator = (session: Session) =>
    session.evaluate(`(() => {
      const style = getComputedStyle(document.documentElement, '::after')
      return { content: style.content, position: style.position, left: style.left, bottom: style.bottom,
        width: parseFloat(style.width), height: parseFloat(style.height), cursor: style.cursor,
        viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight } }
    })()`) as Promise<{
      content: string
      position: string
      left: string
      bottom: string
      width: number
      height: number
      cursor: string
      viewport: { width: number; height: number }
    }>
  const hidden = (session: Session, selector: string) =>
    session.evaluate(
      `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).display === 'none'`,
    )

  async function reload(session: Session): Promise<void> {
    await session.evaluate('location.reload()')
    await vi.waitFor(
      async () =>
        expect(
          await session.evaluate("document.readyState === 'complete' && Array.isArray(window.__mutations)"),
        ).toBe(true),
      { timeout: 15000, interval: 100 },
    )
  }

  async function mouse(client: CdpClient, session: Session, type: string, x: number, y: number) {
    await client.send(
      'Input.dispatchMouseEvent',
      {
        type: type as 'mousePressed' | 'mouseMoved' | 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: type === 'mouseReleased' ? 0 : 1,
        clickCount: 1,
      },
      session.sessionId,
    )
  }

  it('bloqueia como o uBlock Origin, mostra IP, velocidade e gasto da proxy, arrasta sem tocar na página e desliga cada recurso', async () => {
    const proxy = app.services.proxies.create(
      proxyCreateSchema.parse({
        name: 'Remoto',
        type: 'http',
        host: '127.0.0.1',
        port: remote.port,
        username: 'user',
        password: 'senha',
        changeIpUrl: '',
        notes: '',
      }),
    )
    const profile = app.services.profiles.create({
      name: 'Com Facet',
      os: 'windows',
      groupId: null,
      proxyId: proxy.id,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: { ...structuredClone(DEFAULT_LAUNCH_OPTIONS), startupUrls: [pageUrl()] },
    })
    // instalada pelo app como padrão: o perfil novo já vem com ela
    expect(profile.extensionIds).toEqual([FACET_EXTENSION_ID])
    const started = await app.services.profiles.start([profile.id])
    expect(started.failed, JSON.stringify(started.failed)).toEqual([])
    let client = await browser(profile.id)
    let tab = await page(client)

    // indicador: país, IP, latência, velocidade medida sozinha e o gasto da proxy (proxy local)
    await vi.waitFor(
      async () =>
        expect((await indicator(tab)).content).toMatch(
          /^"BR 203\.0\.113\.7 · \d+ ms · ↓ [\d.,]+ Mbps · ⇅ [\d.,]+ (B|KB|MB)"$/,
        ),
      { timeout: 25000, interval: 200 },
    )
    expect(await indicator(tab)).toMatchObject({
      position: 'fixed',
      left: '8px',
      bottom: '8px',
      cursor: 'grab',
    })
    const shot = await client.send('Page.captureScreenshot', { format: 'png' }, tab.sessionId)
    fs.mkdirSync(resolve('test-results'), { recursive: true })
    fs.writeFileSync(resolve('test-results', 'facet-indicator.png'), Buffer.from(shot.data, 'base64'))

    // invisível para a página: nenhum nó, folha de estilo ou mutação de DOM novos
    expect(
      await tab.evaluate(`({
        elements: document.querySelectorAll('*').length,
        sheets: document.styleSheets.length,
        mutations: window.__mutations,
      })`),
    ).toEqual({ elements: 14, sheets: 0, mutations: [] })
    // rede: anúncio (domínio de teste e regra real da EasyList/uBlock) e beacon de terceiros bloqueados
    await vi.waitFor(() => expect(hit('facet-ok.localhost/ok.gif')).toBe(true), { timeout: 5000 })
    await new Promise((done) => setTimeout(done, 800))
    expect(hit('facet-ads.localhost/ad.gif')).toBe(false)
    expect(hit(`facet-ok.localhost${realPath}`), realPath).toBe(false)
    expect(hit('facet-beacon.localhost/beacon')).toBe(false)
    expect(await tab.evaluate("document.getElementById('ok').naturalWidth")).toBe(1)
    // cosméticos: do site, genérico por classe, amplo e um seletor real; o resto continua visível
    await vi.waitFor(
      async () => {
        expect(await hidden(tab, '#facet-test-specific')).toBe(true)
        expect(await hidden(tab, '.facet-test-generic')).toBe(true)
        expect(await hidden(tab, '[data-facet-test-highly]')).toBe(true)
        expect(await hidden(tab, `.${realClass}`), realClass).toBe(true)
      },
      { timeout: 5000, interval: 100 },
    )
    expect(await hidden(tab, '.facet-test-visible')).toBe(false)

    // arrastar o indicador: os eventos não chegam à página e a nova posição fica salva
    const before = await indicator(tab)
    const startX = 8 + before.width / 2
    const startY = before.viewport.height - 8 - before.height / 2
    await mouse(client, tab, 'mouseMoved', startX, startY)
    await mouse(client, tab, 'mousePressed', startX, startY)
    for (let step = 1; step <= 8; step++)
      await mouse(client, tab, 'mouseMoved', startX + step * 60, startY - step * 40)
    await mouse(client, tab, 'mouseReleased', startX + 480, startY - 320)
    await vi.waitFor(
      async () => {
        const after = await indicator(tab)
        expect(parseFloat(after.left)).toBeGreaterThan(200)
        expect(parseFloat(after.bottom)).toBeGreaterThan(150)
      },
      { timeout: 5000, interval: 100 },
    )
    expect(await tab.evaluate('window.__events')).toEqual([])
    // clique fora do indicador continua chegando à página
    await mouse(client, tab, 'mousePressed', 300, 30)
    await mouse(client, tab, 'mouseReleased', 300, 30)
    await vi.waitFor(async () => expect(await tab.evaluate('window.__events')).toContain('click:H1'), {
      timeout: 3000,
    })
    // classe que aparece depois da carga também é escondida (só lendo o DOM)
    await tab.evaluate(
      "document.body.insertAdjacentHTML('beforeend', '<div class=\"facet-test-late\">tardio</div>')",
    )
    await vi.waitFor(async () => expect(await hidden(tab, '.facet-test-late')).toBe(true), { timeout: 5000 })

    // popup do ícone: pré-carregamento controlado, gasto da proxy e a posição salva
    let controls = await popup(client)
    expect(await controls.prediction()).toEqual({
      value: false,
      levelOfControl: 'controlled_by_this_extension',
    })
    const status = await controls.send({ type: 'STATUS', refresh: true })
    expect(status.settings).toEqual({ enabled: true, adblock: true, optimize: true, indicator: true })
    expect(status.metrics).toMatchObject({ ip: '203.0.113.7', country: 'BR', error: false })
    expect(status.usage?.total).toBeGreaterThan(0)
    const saved = (await controls.evaluate("chrome.storage.local.get('position')")) as {
      position: { x: number; y: number }
    }
    expect(saved.position.x).toBeGreaterThan(0.2)
    expect(saved.position.y).toBeGreaterThan(0.2)
    expect(await controls.evaluate('chrome.declarativeNetRequest.getEnabledRulesets()')).toEqual([
      'ads',
      'privacy',
      'malware',
      'unbreak',
      'optimize',
    ])

    // desligar cada recurso pelo popup
    await controls.send({ type: 'SET', settings: { indicator: false } })
    await vi.waitFor(async () => expect((await indicator(tab)).content).toBe('none'), {
      timeout: 5000,
      interval: 100,
    })
    await controls.send({ type: 'SET', settings: { adblock: false, optimize: false } })
    expect((await controls.prediction()).levelOfControl).toBe('controllable_by_this_extension')
    hits.length = 0
    await reload(tab)
    await vi.waitFor(() => expect(hit('facet-ads.localhost/ad.gif')).toBe(true), { timeout: 5000 })
    await vi.waitFor(() => expect(hit('facet-beacon.localhost/beacon')).toBe(true), { timeout: 5000 })
    expect(hit(`facet-ok.localhost${realPath}`)).toBe(true)
    expect(await hidden(tab, '.facet-test-generic')).toBe(false)
    expect(await hidden(tab, '#facet-test-specific')).toBe(false)
    await controls.close()

    // as escolhas ficam no perfil: valem depois de reiniciar
    await app.services.profiles.stop([profile.id])
    const preferences = JSON.parse(
      fs.readFileSync(join(app.files.directory(profile.id), 'Default', 'Preferences'), 'utf8'),
    ) as { extensions?: { pinned_extensions?: string[] } }
    expect(preferences.extensions?.pinned_extensions).toContain(FACET_EXTENSION_ID)
    hits.length = 0
    const restarted = await app.services.profiles.start([profile.id])
    expect(restarted.failed, JSON.stringify(restarted.failed)).toEqual([])
    client = await browser(profile.id)
    tab = await page(client)
    controls = await popup(client)
    expect((await controls.send({ type: 'STATUS', refresh: false })).settings).toEqual({
      enabled: true,
      adblock: false,
      optimize: false,
      indicator: false,
    })
    await vi.waitFor(() => expect(hit('facet-ads.localhost/ad.gif')).toBe(true), { timeout: 5000 })
    expect((await indicator(tab)).content).toBe('none')

    // religar tudo: volta a bloquear e o indicador volta na posição salva; voltar ao canto
    await controls.send({ type: 'SET', settings: { adblock: true, optimize: true, indicator: true } })
    await vi.waitFor(
      async () => {
        const style = await indicator(tab)
        expect(style.content).toMatch(/^"BR 203\.0\.113\.7 · /)
        expect(parseFloat(style.left)).toBeGreaterThan(200)
      },
      { timeout: 10000, interval: 200 },
    )
    await controls.send({ type: 'RESET_POSITION' })
    await vi.waitFor(async () => expect((await indicator(tab)).left).toBe('8px'), {
      timeout: 5000,
      interval: 100,
    })
    hits.length = 0
    await reload(tab)
    await vi.waitFor(() => expect(hit('facet-ok.localhost/ok.gif')).toBe(true), { timeout: 5000 })
    await new Promise((done) => setTimeout(done, 800))
    expect(hit('facet-ads.localhost/ad.gif')).toBe(false)
    await vi.waitFor(async () => expect(await hidden(tab, '.facet-test-generic')).toBe(true), {
      timeout: 5000,
    })
    // "Facet ligada" desligada desfaz tudo
    await controls.send({ type: 'SET', settings: { enabled: false } })
    await vi.waitFor(async () => expect((await indicator(tab)).content).toBe('none'), { timeout: 5000 })
    expect((await controls.prediction()).levelOfControl).toBe('controllable_by_this_extension')
    expect(await controls.evaluate('chrome.declarativeNetRequest.getEnabledRulesets()')).toEqual([])
    hits.length = 0
    await reload(tab)
    await vi.waitFor(() => expect(hit('facet-ads.localhost/ad.gif')).toBe(true), { timeout: 5000 })
    await controls.send({ type: 'SET', settings: { enabled: true } })
    await app.services.profiles.stop([profile.id])
  }, 150000)

  it('perfil sem a Facet abre sem ela: nada de indicador, bloqueio ou cosmético', async () => {
    const profile = app.services.profiles.create({
      name: 'Sem Facet',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      extensionIds: [],
      launchOptions: { ...structuredClone(DEFAULT_LAUNCH_OPTIONS), startupUrls: [pageUrl()] },
    })
    hits.length = 0
    const started = await app.services.profiles.start([profile.id])
    expect(started.failed, JSON.stringify(started.failed)).toEqual([])
    const client = await browser(profile.id)
    const tab = await page(client)
    await vi.waitFor(() => expect(hit('facet-ads.localhost/ad.gif')).toBe(true), { timeout: 5000 })
    expect((await indicator(tab)).content).toBe('none')
    expect(await hidden(tab, '.facet-test-generic')).toBe(false)
    expect(hit('127.0.0.1/cdn-cgi/trace')).toBe(false)
    const preferences = JSON.parse(
      fs.readFileSync(join(app.files.directory(profile.id), 'Default', 'Preferences'), 'utf8'),
    ) as { extensions?: { pinned_extensions?: string[] } }
    expect(preferences.extensions?.pinned_extensions ?? []).not.toContain(FACET_EXTENSION_ID)
    await app.services.profiles.stop([profile.id])
  }, 60000)
})
