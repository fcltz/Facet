import fs from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createContainer, type Container } from '@main/container'
import { CdpClient } from '@main/browser/cdp/client'
import { inspectProcess } from '@main/browser/process'
import { silentLogger } from '@main/logger'
import { ensureBaseDirs, resolveAppPaths, type AppPaths } from '@main/paths'
import { createTestSecretBox } from '@main/security/secrets'
import { BROWSER_KINDS, type BrowserKind } from '@shared/constants'
import { MOBILE_DEVICES } from '@shared/data/mobile-devices'
import { FACET_EXTENSION_ID } from '@shared/facet-extension'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import type { OsName } from '@shared/schemas/common'
import { fingerprintFixture } from '../helpers/fingerprint-fixture'
import { hasBundledBrowser, testBrowserDeps } from '../helpers/browser'

/** O que a página vê de um celular (lido depois de carregar). */
const READ_DEVICE = `(async () => {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl');
  const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
  const hints = navigator.userAgentData
    ? await navigator.userAgentData.getHighEntropyValues(['model', 'platformVersion', 'formFactors', 'architecture', 'bitness'])
    : null;
  return {
    ua: navigator.userAgent, platform: navigator.platform, vendor: navigator.vendor, webdriver: navigator.webdriver,
    hints, uaData: 'userAgentData' in navigator, memory: navigator.deviceMemory ?? null, cores: navigator.hardwareConcurrency,
    touch: navigator.maxTouchPoints, ontouchstart: 'ontouchstart' in window,
    coarse: matchMedia('(pointer: coarse)').matches, hoverNone: matchMedia('(hover: none)').matches,
    screen: [screen.width, screen.height, screen.availWidth, screen.availHeight], dpr: devicePixelRatio,
    inner: [innerWidth, innerHeight], orientation: screen.orientation && screen.orientation.type,
    windowOrientation: window.orientation ?? null, plugins: navigator.plugins.length, pdf: navigator.pdfViewerEnabled,
    gpu: 'gpu' in navigator, chrome: 'chrome' in window,
    webgl: info ? [gl.getParameter(info.UNMASKED_VENDOR_WEBGL), gl.getParameter(info.UNMASKED_RENDERER_WEBGL)] : null,
  };
})()`

interface DeviceReading {
  ua: string
  platform: string
  vendor: string
  webdriver: boolean
  hints: {
    platform: string
    mobile: boolean
    model: string
    platformVersion: string
    formFactors: string[]
  } | null
  uaData: boolean
  memory: number | null
  cores: number
  touch: number
  ontouchstart: boolean
  coarse: boolean
  hoverNone: boolean
  screen: number[]
  dpr: number
  inner: number[]
  orientation: string
  windowOrientation: number | null
  plugins: number
  pdf: boolean
  gpu: boolean
  chrome: boolean
  webgl: [string, string] | null
}

interface WorkerReading {
  hints: { platform: string; mobile: boolean } | null
  memory: number | null
  platform: string
}

// Abre navegadores de verdade. CI sem navegadores pode definir SKIP_BRAVE_TESTS=1.
describe.skipIf(process.env.SKIP_BRAVE_TESTS === '1')('vários navegadores e celulares emulados', () => {
  let directory: string
  let paths: AppPaths
  let app: Container
  let site: Awaited<ReturnType<typeof fingerprintFixture>>
  const clients: CdpClient[] = []

  const create = (name: string, browser: BrowserKind, os: OsName, extensionIds?: string[]) =>
    app.services.profiles.create({
      name,
      browser,
      os,
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      extensionIds,
      launchOptions: {
        ...structuredClone(DEFAULT_LAUNCH_OPTIONS),
        startupUrls: [`${site.url}/page?${name}&viewport`, `${site.url}/page?${name}`],
      },
    })

  async function page(id: string, plain = false) {
    const endpoint = app.sessions.get(id)?.wsEndpoint
    if (!endpoint) throw new Error('Sem sessão')
    const client = await CdpClient.connect(endpoint)
    clients.push(client)
    let targetId = ''
    await vi.waitFor(
      async () => {
        const found = (await client.send('Target.getTargets', {})).targetInfos.find(
          (value) =>
            value.type === 'page' && value.url.includes('/page') && value.url.includes('viewport') !== plain,
        )
        expect(found).toBeDefined()
        targetId = found!.targetId
      },
      { timeout: 15000 },
    )
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    const evaluate = async <T = unknown>(expression: string, awaitPromise = false): Promise<T> => {
      const result = await client.send(
        'Runtime.evaluate',
        { expression, awaitPromise, returnByValue: true },
        sessionId,
        15000,
      )
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value as T
    }
    await vi.waitFor(async () => expect(await evaluate("document.readyState === 'complete'")).toBe(true), {
      timeout: 15000,
    })
    return { client, targetId, evaluate }
  }

  beforeAll(async () => {
    fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
    directory = fs.mkdtempSync(resolve('.tmp-tests', 'browsers-'))
    paths = resolveAppPaths(directory)
    ensureBaseDirs(paths)
    site = await fingerprintFixture()
    app = createContainer({
      ...testBrowserDeps,
      paths,
      migrationsFolder: resolve('drizzle'),
      emit: vi.fn(),
      logger: silentLogger,
      hostTimezone: 'America/Sao_Paulo',
      hostLanguages: ['pt-BR', 'pt'],
      secrets: createTestSecretBox(),
      // a extensão Facet entra em todo perfil novo (padrão): confere a carga em cada navegador
      bundledExtensionDir: resolve('resources/facet-extension'),
    })
    await app.initialize()
    app.services.settings.update({ startPage: '' })
    await app.browsers.detectAll()
  }, 180000)

  afterAll(async () => {
    for (const client of clients) client.close()
    if (app) {
      await app.runtime.stopAll()
      await app.close()
    }
    await site?.close()
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }, 60000)

  it('o Ungoogled Chromium que vem com o Facet é o padrão e está pronto', () => {
    expect(hasBundledBrowser, 'rode node scripts/fetch-ungoogled-chromium.mjs').toBe(true)
    const info = app.browsers.info('ungoogled')
    expect(info).toMatchObject({ available: true, source: 'bundled', name: 'Ungoogled Chromium' })
    expect(app.services.settings.get().defaultBrowser).toBe('ungoogled')
    // sem marca própria nas Client Hints: só Chromium e a GREASE
    expect(info.fingerprintCapabilities!.brands!.map((brand) => brand.brand)).toEqual([
      'Not.A/Brand',
      'Chromium',
    ])
  })

  it.for(BROWSER_KINDS)(
    '%s instalado: abre com a extensão Facet, sem webdriver e com as marcas reais na emulação do macOS',
    { timeout: 180000 },
    async (kind, context) => {
      const info = app.browsers.info(kind)
      if (!info.available) {
        context.skip(`${info.name} não está instalado nesta máquina`)
        return
      }
      const capabilities = info.fingerprintCapabilities!
      const expectedBrand = { ungoogled: null, chrome: 'Google Chrome', brave: 'Brave', opera: 'Opera' }[kind]
      const names = capabilities.brands!.map((brand) => brand.brand)
      if (expectedBrand) expect(names).toContain(expectedBrand)
      else expect(names).toHaveLength(2)
      const profile = create(`macos-${kind}`, kind, 'macos')
      expect(profile.extensionIds).toContain(FACET_EXTENSION_ID)
      const result = await app.services.profiles.start([profile.id])
      expect(result.failed, JSON.stringify(result.failed)).toEqual([])
      const tab = await page(profile.id)
      const first = await tab.evaluate<{
        ua: string
        webdriver: boolean
        platform: string
        hints: { brands: unknown; platform: string }
      }>('window.first')
      expect(first.webdriver).toBe(false)
      expect(first.platform).toBe('MacIntel')
      expect(first.ua).toContain('Macintosh')
      expect(first.ua.endsWith(capabilities.uaSuffix ?? '')).toBe(true)
      if (kind === 'opera') expect(first.ua).toMatch(/OPR\/\d+\.0\.0\.0$/)
      expect(first.hints.platform).toBe('macOS')
      expect(first.hints.brands).toEqual(capabilities.brands)
      // a Facet carregou (no Chrome, pelo canal de depuração; nos outros, pela flag)
      const { extensions } = await tab.client.send('Extensions.getExtensions', undefined)
      expect(extensions.map((extension) => extension.id)).toContain(FACET_EXTENSION_ID)
      const identity = await inspectProcess(app.sessions.get(profile.id)!.pid!)
      if (kind === 'chrome') expect(identity!.args).toContain('--remote-debugging-pipe')
      else expect(identity!.args.some((arg) => arg.startsWith('--load-extension='))).toBe(true)
      if (kind === 'ungoogled') expect(identity!.args).toContain('--fingerprinting-canvas-image-data-noise')
      await app.services.profiles.stop([profile.id])
      expect(app.runtime.status(profile.id)).toBe('stopped')
    },
  )

  it('Android: tudo o que a página vê é do aparelho (Client Hints, tela, toque, GPU, PDF)', async () => {
    const profile = create('android', 'ungoogled', 'android', [])
    const device = MOBILE_DEVICES.android.find((item) => item.id === profile.fingerprint.device)!
    expect(device).toBeDefined()
    expect((await app.services.profiles.start([profile.id])).failed).toEqual([])
    const tab = await page(profile.id)
    const reading = await tab.evaluate<DeviceReading>(READ_DEVICE, true)
    expect(reading).toMatchObject({
      ua: profile.fingerprint.userAgent,
      platform: 'Linux armv81',
      webdriver: false,
      uaData: true,
      hints: {
        platform: 'Android',
        mobile: true,
        model: device.model,
        platformVersion: device.osVersion,
        formFactors: ['Mobile'],
        architecture: '',
        bitness: '',
      },
      memory: device.memory,
      cores: device.cores,
      touch: 5,
      ontouchstart: true,
      coarse: true,
      hoverNone: true,
      screen: [device.screen.width, device.screen.height, device.screen.width, device.screen.height],
      dpr: device.screen.pixelRatio,
      inner: [device.screen.width, device.viewportHeight],
      orientation: 'portrait-primary',
      windowOrientation: 0,
      plugins: 0,
      pdf: false,
      gpu: false,
      webgl: [device.gpu.vendor, device.gpu.renderer],
    })
    expect(reading.ua).toContain('Linux; Android 10; K')
    // página sem meta viewport: largura de 980 px, como num celular de verdade
    const plain = await page(profile.id, true)
    // (o Blink arredonda pela densidade: 980 ou 981)
    const [layoutWidth, screenWidth] = await plain.evaluate<number[]>('[innerWidth, screen.width]')
    expect(layoutWidth).toBeGreaterThanOrEqual(980)
    expect(layoutWidth).toBeLessThanOrEqual(981)
    expect(screenWidth).toBe(device.screen.width)
    // os cabeçalhos do primeiro pedido já eram de celular
    const request = site.requests.find((entry) => entry.path === '/page?android&viewport')!
    expect(request.headers['sec-ch-ua-mobile']).toBe('?1')
    expect(request.headers['sec-ch-ua-platform']).toBe('"Android"')
    // workers: mesma memória e Client Hints de celular
    await vi.waitFor(async () => expect(await tab.evaluate('Boolean(window.reports.worker)')).toBe(true), {
      timeout: 15000,
    })
    const worker = await tab.evaluate<WorkerReading>('window.reports.worker')
    expect(worker).toMatchObject({ memory: device.memory, hints: { platform: 'Android', mobile: true } })
    // janela do tamanho do aparelho
    const { bounds } = await tab.client.send('Browser.getWindowForTarget', { targetId: tab.targetId })
    expect(bounds.height).toBe(device.viewportHeight + 89)
    await app.services.profiles.stop([profile.id])
  }, 180000)

  it('iPhone: Safari sem Client Hints, sem deviceMemory nem window.chrome, GPU da Apple', async () => {
    const profile = create('ios', 'ungoogled', 'ios', [])
    const device = MOBILE_DEVICES.ios.find((item) => item.id === profile.fingerprint.device)!
    expect((await app.services.profiles.start([profile.id])).failed).toEqual([])
    const tab = await page(profile.id)
    const reading = await tab.evaluate<DeviceReading>(READ_DEVICE, true)
    expect(reading).toMatchObject({
      ua: profile.fingerprint.userAgent,
      platform: 'iPhone',
      vendor: 'Apple Computer, Inc.',
      webdriver: false,
      uaData: false,
      hints: null,
      memory: null,
      cores: 4,
      touch: 5,
      ontouchstart: true,
      coarse: true,
      screen: [device.screen.width, device.screen.height, device.screen.width, device.screen.height],
      dpr: device.screen.pixelRatio,
      inner: [device.screen.width, device.viewportHeight],
      gpu: false,
      chrome: false,
      webgl: ['Apple Inc.', 'Apple GPU'],
    })
    expect(reading.ua).toMatch(
      /^Mozilla\/5\.0 \(iPhone; CPU iPhone OS \d+_\d+ like Mac OS X\).*Safari\/604\.1$/,
    )
    // sem metadados o Chromium não manda Sec-CH-UA (o Safari não manda)
    const request = site.requests.find((entry) => entry.path === '/page?ios&viewport')!
    expect(request.headers['sec-ch-ua']).toBeUndefined()
    expect(request.headers['sec-ch-ua-mobile']).toBeUndefined()
    expect(request.headers['user-agent']).toBe(profile.fingerprint.userAgent)
    await vi.waitFor(async () => expect(await tab.evaluate('Boolean(window.reports.worker)')).toBe(true), {
      timeout: 15000,
    })
    expect(await tab.evaluate<WorkerReading>('window.reports.worker')).toMatchObject({
      hints: null,
      memory: null,
    })
    const state = await app.services.fingerprint.session(profile.id)
    expect(state.warnings).toContain('iosEngine')
    await app.services.profiles.stop([profile.id])
  }, 180000)
})
