import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import type { Protocol } from 'devtools-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CdpClient } from '@main/browser/cdp/client'
import { applyFingerprint } from '@main/browser/fingerprint/apply'
import { fallbackBrands } from '@main/browser/fingerprint/capabilities'
import { generateFingerprint } from '@main/browser/fingerprint/generator'
import { documentScript, workerScript } from '@main/browser/fingerprint/scripts'
import { createFlavors } from '@main/browser/flavors'
import { preparePreferences } from '@main/browser/preferences'
import { silentLogger } from '@main/logger'
import { createMemoryRepositories } from '@main/repositories/mock/memory'
import { createMockSeed } from '@main/repositories/mock/seed'
import { MockRuntime } from '@main/runtime/mock-runtime'
import { ProfileService } from '@main/services/profile.service'
import type { BrowserKind } from '@shared/constants'
import { MOBILE_DEVICES } from '@shared/data/mobile-devices'
import {
  createDefaultFingerprint,
  type FingerprintCapabilities,
  type FingerprintConfig,
} from '@shared/schemas/fingerprint'
import { DEFAULT_LAUNCH_OPTIONS, type ProfileCreateInput } from '@shared/schemas/profile'
import { DEFAULT_SETTINGS } from '@shared/schemas/settings'

const base: FingerprintCapabilities = {
  engineMajor: 158,
  product: 'Chrome/158.0.8127.36',
  hostOs: 'windows',
  nativeUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
  uaSuffix: '',
}
const capabilitiesOf = (kind: BrowserKind): FingerprintCapabilities => ({
  ...base,
  browser: kind,
  ...fallbackBrands(kind, base),
})

const roots: string[] = []
const temporary = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-browsers-'))
  roots.push(directory)
  return directory
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('preferências por navegador', () => {
  const read = (file: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>

  it('só o Brave recebe as preferências próprias dele (P3A, Rewards, farbling)', () => {
    for (const browser of ['ungoogled', 'chrome', 'opera', 'brave'] as const) {
      const directory = temporary()
      preparePreferences(directory, ['pt-BR'], silentLogger, {
        browser,
        farbling: true,
        blockGeolocation: true,
      })
      const state = read(path.join(directory, 'Local State'))
      const prefs = read(path.join(directory, 'Default', 'Preferences')) as {
        brave?: unknown
        profile: { default_content_setting_values: Record<string, number> }
      }
      expect('brave' in state, browser).toBe(browser === 'brave')
      expect('brave' in prefs, browser).toBe(browser === 'brave')
      expect(prefs.profile.default_content_setting_values.geolocation).toBe(2)
      expect(prefs.profile.default_content_setting_values.fingerprintingV2).toBe(
        browser === 'brave' ? 3 : undefined,
      )
    }
  })

  it('Android baixa os PDFs; ao voltar ao computador o Facet desfaz só o que ele mudou', () => {
    const directory = temporary()
    const file = path.join(directory, 'Default', 'Preferences')
    preparePreferences(directory, ['pt-BR'], silentLogger, { pdfViewer: false })
    expect(read(file)).toMatchObject({
      plugins: { always_open_pdf_externally: true },
      facet_pdf_download: true,
    })
    preparePreferences(directory, ['pt-BR'], silentLogger, { pdfViewer: true })
    expect(read(file).plugins).toEqual({ always_open_pdf_externally: false })
    expect('facet_pdf_download' in read(file)).toBe(false)
    // escolha do próprio usuário (sem a marca do Facet) fica como está
    fs.writeFileSync(file, JSON.stringify({ plugins: { always_open_pdf_externally: true } }))
    preparePreferences(directory, ['pt-BR'], silentLogger, { pdfViewer: true })
    expect(read(file).plugins).toEqual({ always_open_pdf_externally: true })
  })
})

describe('estado de verificação do navegador', () => {
  it('“verificando” até a primeira procura terminar; a resposta já vem concluída', async () => {
    const { ChromiumEngine } = await import('@main/browser/chromium-engine')
    const flavors = createFlavors({ bundledUngoogled: null })
    const engine = new ChromiumEngine({
      flavor: flavors.ungoogled,
      profilesDir: () => temporary(),
      probeDir: temporary(),
      getPath: () => '',
      logger: silentLogger,
    })
    expect(engine.info().checking).toBe(true)
    const pending = engine.detect()
    expect(engine.info().checking).toBe(true)
    const result = await pending
    // sem o executável empacotado: indisponível, com o motivo, e não mais "verificando"
    expect(result).toMatchObject({ kind: 'ungoogled', available: false, checking: false })
    expect(result.error).toContain('Ungoogled Chromium')
    expect(engine.info().checking).toBe(false)
    const missing = await engine.validate(path.join(temporary(), 'nao-existe.exe'))
    expect(missing).toMatchObject({ available: false, checking: false, source: 'custom' })
  })
})

describe('variantes dos navegadores', () => {
  it('Chrome carrega extensões pelo canal de depuração; os outros pela flag', async () => {
    const flavors = createFlavors({ bundledUngoogled: 'C:/Facet/browsers/ungoogled-chromium/chrome.exe' })
    expect(flavors.chrome.extensionLoading).toBe('pipe')
    for (const kind of ['ungoogled', 'brave', 'opera'] as const)
      expect(flavors[kind].extensionLoading).toBe('flag')
    expect(await flavors.ungoogled.candidates()).toEqual(['C:/Facet/browsers/ungoogled-chromium/chrome.exe'])
    expect(await createFlavors({ bundledUngoogled: null }).ungoogled.candidates()).toEqual([])
  })
  it('ruído nativo: flags do Ungoogled Chromium; Chrome e Opera não têm', () => {
    const flavors = createFlavors({ bundledUngoogled: null })
    expect(flavors.ungoogled.args({ noise: true })).toEqual([
      '--fingerprinting-canvas-image-data-noise',
      '--fingerprinting-canvas-measuretext-noise',
      '--fingerprinting-client-rects-noise',
    ])
    expect(flavors.ungoogled.args({ noise: false })).toEqual([])
    expect([flavors.chrome.nativeNoise, flavors.opera.nativeNoise]).toEqual([false, false])
    expect([flavors.brave.nativeNoise, flavors.ungoogled.nativeNoise]).toEqual([true, true])
  })
})

const target = (type: string, url = 'https://site.test/'): Protocol.Target.TargetInfo => ({
  targetId: 't-1',
  type,
  url,
  title: '',
  attached: true,
  canAccessOpener: false,
})

/** Comandos enviados a um alvo; `fail` recusa um método. */
function recorder(fail?: string) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const client = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params: params ?? {} })
      if (method === fail) throw new Error('unsupported')
      return {}
    }),
  } as unknown as CdpClient
  const params = (method: string) => calls.find((call) => call.method === method)?.params
  return { client, calls, params }
}

const mobile = (os: 'android' | 'ios', device?: string): FingerprintConfig =>
  generateFingerprint(os, capabilitiesOf('chrome'), {
    base: createDefaultFingerprint({ os, engineMajor: 158, timezone: 'UTC', device }),
    choose: () => 0,
  })

describe('emulação de celular pelo CDP', () => {
  it('Android: Client Hints de celular, tela e página do aparelho, toque e mouse como dedo', async () => {
    const config = mobile('android')
    const device = MOBILE_DEVICES.android.find((item) => item.id === config.device)!
    const { client, params } = recorder()
    await applyFingerprint(client, 'page', target('page'), config, vi.fn(), { viewScale: 0.8 })
    expect(params('Network.setUserAgentOverride')).toMatchObject({
      userAgent: config.userAgent,
      platform: 'Linux armv81',
      userAgentMetadata: { mobile: true, platform: 'Android', model: device.model, formFactors: ['Mobile'] },
    })
    expect(params('Emulation.setDeviceMetricsOverride')).toEqual({
      width: device.screen.width,
      height: device.viewportHeight,
      deviceScaleFactor: device.screen.pixelRatio,
      mobile: true,
      screenWidth: device.screen.width,
      screenHeight: device.screen.height,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
      scale: 0.8,
    })
    expect(params('Emulation.setTouchEmulationEnabled')).toEqual({ enabled: true, maxTouchPoints: 5 })
    expect(params('Emulation.setEmitTouchEventsForMouse')).toEqual({ enabled: true, configuration: 'mobile' })
    expect(params('Emulation.setHardwareConcurrencyOverride')).toEqual({ hardwareConcurrency: device.cores })
  })
  it('iPhone: sem Client Hints (como o Safari); escala 1 não vai no comando', async () => {
    const { client, params } = recorder()
    await applyFingerprint(client, 'page', target('page'), mobile('ios'), vi.fn(), { viewScale: 1 })
    expect(params('Network.setUserAgentOverride')).not.toHaveProperty('userAgentMetadata')
    expect(params('Emulation.setDeviceMetricsOverride')).not.toHaveProperty('scale')
  })
  it('computador: Client Hints de desktop, sem toque e sem trocar o tamanho da página', async () => {
    const config = generateFingerprint('macos', capabilitiesOf('ungoogled'), { choose: () => 0 })
    const { client, calls, params } = recorder()
    await applyFingerprint(client, 'page', target('page'), config, vi.fn())
    expect(params('Network.setUserAgentOverride')).toMatchObject({
      userAgentMetadata: { mobile: false, formFactors: ['Desktop'] },
    })
    expect(params('Emulation.setDeviceMetricsOverride')).toMatchObject({ width: 0, height: 0, mobile: false })
    expect(calls.some((call) => call.method.startsWith('Emulation.setTouch'))).toBe(false)
  })
  it('iframe de outro site sem emulação de toque: só um aviso, a página continua', async () => {
    const warn = vi.fn()
    const { client } = recorder('Emulation.setTouchEmulationEnabled')
    await expect(
      applyFingerprint(client, 'frame', target('iframe'), mobile('android'), warn),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('iframeTouch')
    // na página principal a falha continua fechando o perfil (falha fechada)
    await expect(
      applyFingerprint(
        recorder('Emulation.setTouchEmulationEnabled').client,
        'page',
        target('page'),
        mobile('android'),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: 'FINGERPRINT_FAILED' })
  })
  it('workers do celular recebem os complementos antes de rodar', async () => {
    const { client, params } = recorder()
    const config = mobile('ios')
    await applyFingerprint(client, 'worker', target('worker', 'https://site.test/w.js'), config, vi.fn())
    expect(params('Runtime.evaluate')).toEqual({ expression: workerScript(config), silent: true })
  })
})

/** Ambiente mínimo de página: Navigator, Screen e WebGL como no Chromium (atributos no protótipo). */
function pageSandbox(worker = false) {
  const context = vm.createContext({})
  vm.runInContext(
    `
    class Navigator {}
    for (const [key, value] of Object.entries({
      platform: 'Win32', maxTouchPoints: 0, deviceMemory: 16, vendor: 'Google Inc.',
      userAgentData: { brands: [] }, connection: { effectiveType: '4g' }, gpu: {},
    })) Object.defineProperty(Navigator.prototype, key, { configurable: true, enumerable: true, get: () => value });
    class Screen {}
    class WebGLRenderingContext { getParameter(parameter) { return 'real:' + parameter; } }
    class WebGL2RenderingContext { getParameter(parameter) { return 'real2:' + parameter; } }
    globalThis.${worker ? 'WorkerNavigator' : 'Navigator'} = Navigator;
    globalThis.Screen = Screen;
    globalThis.WebGLRenderingContext = WebGLRenderingContext;
    globalThis.WebGL2RenderingContext = WebGL2RenderingContext;
    globalThis.navigator = new Navigator();
    globalThis.chrome = { app: {} };
    globalThis.DOMException = class DOMException extends Error {};
    `,
    context,
  )
  const run = <T>(code: string): T => vm.runInContext(code, context) as T
  return { context, run }
}

describe('complementos de página e de worker no celular', () => {
  it('iPhone: sem userAgentData, deviceMemory, connection, WebGPU e window.chrome; GPU da Apple', () => {
    const config = mobile('ios')
    const { run } = pageSandbox()
    run(documentScript(config))
    expect(
      run<string[]>(
        `['userAgentData', 'deviceMemory', 'connection', 'gpu'].filter((key) => key in navigator)`,
      ),
    ).toEqual([])
    expect(run('navigator.vendor')).toBe('Apple Computer, Inc.')
    expect(run('navigator.platform')).toBe('iPhone')
    expect(run('navigator.maxTouchPoints')).toBe(5)
    expect(run("'chrome' in globalThis")).toBe(false)
    expect(run('new WebGLRenderingContext().getParameter(0x9245)')).toBe('Apple Inc.')
    expect(run('new WebGL2RenderingContext().getParameter(0x9246)')).toBe('Apple GPU')
    // os outros parâmetros continuam os do motor
    expect(run('new WebGLRenderingContext().getParameter(7936)')).toBe('real:7936')
  })
  it('Android: memória e GPU do aparelho, Client Hints mantidas', () => {
    const config = mobile('android')
    const device = MOBILE_DEVICES.android.find((item) => item.id === config.device)!
    const { run } = pageSandbox()
    run(documentScript(config))
    expect(run('navigator.deviceMemory')).toBe(device.memory)
    expect(run("'userAgentData' in navigator")).toBe(true)
    expect(run("'gpu' in navigator")).toBe(false)
    expect(run('new WebGLRenderingContext().getParameter(0x9246)')).toBe(device.gpu.renderer)
    expect(run("'chrome' in globalThis")).toBe(true)
  })
  it('computador: nada de celular (WebGL, WebGPU e Client Hints intactos)', () => {
    const config = generateFingerprint('linux', base, { choose: () => 0 })
    const { run } = pageSandbox()
    run(documentScript(config))
    expect(run('new WebGLRenderingContext().getParameter(0x9246)')).toBe('real:37446')
    expect(run("['gpu', 'userAgentData'].every((key) => key in navigator)")).toBe(true)
    expect(workerScript(config)).toBe('undefined')
  })
  it('worker do iPhone: WorkerNavigator sem o que o Safari não tem', () => {
    const { run } = pageSandbox(true)
    run(workerScript(mobile('ios')))
    expect(
      run<string[]>(
        `['userAgentData', 'deviceMemory', 'connection', 'gpu'].filter((key) => key in navigator)`,
      ),
    ).toEqual([])
    expect(run('new WebGLRenderingContext().getParameter(0x9245)')).toBe('Apple Inc.')
  })
})

describe('perfis e navegadores', () => {
  function setup(defaultBrowser: BrowserKind = 'ungoogled') {
    const seed = createMockSeed({ now: 1, activeProfiles: 0, trashedProfiles: 0 })
    const repos = createMemoryRepositories(seed, {
      load: () => ({ ...DEFAULT_SETTINGS }),
      save: () => undefined,
    })
    let counter = 0
    const profiles = new ProfileService({
      repos,
      runtime: new MockRuntime({ startDelayMs: 1, stopDelayMs: 1, now: () => 1 }),
      emit: vi.fn(),
      now: () => 1,
      newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`,
      hostTimezone: 'UTC',
      engineMajor: 158,
      language: () => 'pt-BR',
      logger: silentLogger,
      capabilities: capabilitiesOf,
      defaultBrowser: () => defaultBrowser,
    })
    return { profiles }
  }
  const input = (overrides: Partial<ProfileCreateInput> = {}): ProfileCreateInput => ({
    name: 'Loja',
    os: 'windows',
    groupId: null,
    proxyId: null,
    tagIds: [],
    color: null,
    notes: '',
    launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
    ...overrides,
  })
  const brandNames = (config: FingerprintConfig) => config.uaData.brands.map((brand) => brand.brand)

  it('perfil sem escolha usa o navegador padrão; a escolha na criação vale', () => {
    const { profiles } = setup('ungoogled')
    const plain = profiles.create(input())
    expect(plain.browser).toBe('ungoogled')
    expect(brandNames(plain.fingerprint)).toEqual(['Not.A/Brand', 'Chromium'])
    const chrome = profiles.create(input({ browser: 'chrome', os: 'android' }))
    expect(chrome.browser).toBe('chrome')
    expect(chrome.os).toBe('android')
    expect(brandNames(chrome.fingerprint)).toContain('Google Chrome')
    expect(chrome.fingerprint.uaData.mobile).toBe(true)
  })
  it('trocar o navegador recalcula as marcas e mantém o hardware; cópia e lote mantêm o navegador', () => {
    const { profiles } = setup('brave')
    const profile = profiles.create(input({ os: 'ios' }))
    expect(profile.browser).toBe('brave')
    const moved = profiles.update(profile.id, { browser: 'opera' })
    expect(moved.browser).toBe('opera')
    expect(brandNames(moved.fingerprint)).toContain('Opera')
    expect(moved.fingerprint.device).toBe(profile.fingerprint.device)
    expect(moved.fingerprint.screen).toEqual(profile.fingerprint.screen)
    expect(profiles.clone(moved.id).browser).toBe('opera')
    const batch = profiles.bulkCreate({
      count: 3,
      namePrefix: 'Lote',
      browser: 'chrome',
      os: 'android',
      groupId: null,
      proxyId: null,
      tagIds: [],
    })
    expect(batch.map((item) => item.browser)).toEqual(['chrome', 'chrome', 'chrome'])
    // cada perfil do lote recebe um aparelho diferente
    expect(new Set(batch.map((item) => profiles.get(item.id).fingerprint.device)).size).toBe(3)
  })
})
