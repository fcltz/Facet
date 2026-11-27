import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createContainer, type Container } from '@main/container'
import { CdpClient } from '@main/browser/cdp/client'
import { assertDirectoryIdle, inspectProcess } from '@main/browser/process'
import { TEST_BROWSER, testBrowserDeps, testLogger, useTestBrowser } from '../helpers/browser'
import { ensureBaseDirs, resolveAppPaths, type AppPaths } from '@main/paths'
import { createTestSecretBox } from '@main/security/secrets'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import { createDefaultFingerprint, type FingerprintConfig } from '@shared/schemas/fingerprint'
import { fingerprintFixture, READ_FINGERPRINT } from '../helpers/fingerprint-fixture'
import { gatherCandidates, stunServer } from '../helpers/stun'

interface Reading {
  ua: string
  webdriver: boolean | null
  platform: string
  language: string
  languages: string[]
  locale: string
  timezone: string
  cores: number
  memory: number | null
  hints: { platform: string; brands: { brand: string; version: string }[] }
  screen: number[] | null
  webrtc: string
}

describe.skipIf(process.env.SKIP_BRAVE_TESTS === '1')('Fingerprint no Brave real', () => {
  let directory: string
  let paths: AppPaths
  let app: Container
  let site: Awaited<ReturnType<typeof fingerprintFixture>>
  const clients: CdpClient[] = []
  const secrets = createTestSecretBox()
  const make = (): Container =>
    useTestBrowser(
      createContainer({
        ...testBrowserDeps,
        paths,
        migrationsFolder: resolve('drizzle'),
        emit: vi.fn(),
        logger: testLogger('fingerprint'),
        hostTimezone: 'America/Sao_Paulo',
        hostLanguages: ['pt-BR', 'pt'],
        secrets,
      }),
    )
  const create = (name: string, fingerprint?: FingerprintConfig) =>
    app.services.profiles.create({
      name,
      os: fingerprint?.os ?? 'windows',
      fingerprint,
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: {
        ...structuredClone(DEFAULT_LAUNCH_OPTIONS),
        startupUrls: [`${site.url}/page?${name}`],
        restoreTabs: true,
      },
    })
  async function page(id: string, urlPart = '/page') {
    const endpoint = app.sessions.get(id)?.wsEndpoint
    if (!endpoint) throw new Error('Sem sessão')
    const client = await CdpClient.connect(endpoint)
    clients.push(client)
    let targetId = ''
    await vi.waitFor(
      async () => {
        const found = (await client.send('Target.getTargets', {})).targetInfos.find(
          (value) => value.type === 'page' && value.url.includes(urlPart),
        )
        expect(found).toBeDefined()
        targetId = found!.targetId
      },
      { timeout: 10000 },
    )
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    const evaluate = async <T = unknown>(expression: string, awaitPromise = false): Promise<T> => {
      const result = await client.send(
        'Runtime.evaluate',
        { expression, awaitPromise, returnByValue: true, userGesture: true },
        sessionId,
        12000,
      )
      if (result.exceptionDetails)
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result.value as T
    }
    await vi.waitFor(async () => expect(await evaluate('Boolean(window.first)')).toBe(true), {
      timeout: 12000,
    })
    return { evaluate, client, targetId, sessionId }
  }
  beforeAll(async () => {
    fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
    directory = fs.mkdtempSync(resolve('.tmp-tests', 'fingerprint-'))
    paths = resolveAppPaths(directory)
    ensureBaseDirs(paths)
    site = await fingerprintFixture()
    app = make()
    await app.initialize()
    expect(app.browsers.info(TEST_BROWSER).available).toBe(true)
  }, 60000)
  afterAll(async () => {
    for (const client of clients) client.close()
    if (app) {
      await app.runtime.stopAll()
      await app.close()
    }
    await site?.close()
    if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
  }, 60000)

  it('Nativo mantém UA/CH e aplica idioma/fuso antes do primeiro script, com geolocalização bloqueada', async () => {
    // Perfil novo vem em Emulação: o modo Nativo é escolhido de propósito.
    const native = createDefaultFingerprint({ os: 'windows', engineMajor: 158, timezone: 'UTC' })
    expect(native.mode).toBe('native')
    const profile = create('native', native)
    expect(profile.fingerprint.mode).toBe('native')
    await app.runtime.start(profile.id)
    const tab = await page(profile.id)
    const first = await tab.evaluate<Reading>('window.first')
    // Depuração remota marcaria navigator.webdriver = true; a flag reservada devolve false.
    expect(first.webdriver).toBe(false)
    const identity = await inspectProcess(app.sessions.get(profile.id)!.pid!)
    expect(identity!.args).toContain('--disable-blink-features=AutomationControlled')
    expect(first.ua).toBe(app.browsers.info(TEST_BROWSER).fingerprintCapabilities!.nativeUserAgent)
    expect(first.platform).toBe('Win32')
    expect(first.hints.platform).toBe('Windows')
    expect(first.timezone).toBe('America/Sao_Paulo')
    // Com a proteção padrão do Brave (fingerprintingV2=3) os sites veem só o idioma principal;
    // o cabeçalho mantém a lista com pesos reduzidos (verificado no Brave 158).
    expect(first.language).toBe('pt-BR')
    expect(first.languages).toEqual(['pt-BR'])
    expect(
      await tab.evaluate(
        "navigator.permissions.query({name:'geolocation'}).then(value => value.state)",
        true,
      ),
    ).toBe('denied')
    // Controle do teste de WebRTC: sem proxy, "Restringir UDP ao proxy" não restringe nada.
    const stun = await stunServer()
    try {
      expect((await tab.evaluate<string[]>(gatherCandidates(stun.port), true)).length).toBeGreaterThan(0)
    } finally {
      await stun.close()
    }
    const initial = site.requests.find((request) => request.path === '/page?native')!
    expect(initial.headers['user-agent']).toBe(first.ua)
    expect(initial.headers['sec-ch-ua-platform']).toBe('"Windows"')
    expect(initial.headers['accept-language']).toMatch(/^pt-BR/)
    await vi.waitFor(
      async () => {
        const reports = await tab.evaluate<Record<string, Reading>>('window.reports')
        for (const type of ['worker', 'shared', 'service', '127.0.0.1', 'localhost']) {
          expect(reports[type], type).toBeDefined()
          expect(reports[type]!.timezone, type).toBe(first.timezone)
        }
      },
      { timeout: 20000 },
    )
    // Alvos que somem durante a preparação (iframes de outro site removidos na hora, como os
    // de anúncios, e um pop-up fechado logo ao abrir) não têm o que proteger: o perfil segue.
    await tab.evaluate(`(() => {
      for (let i = 0; i < 20; i++) {
        const frame = document.createElement('iframe')
        frame.src = location.protocol + '//localhost:' + location.port + '/frame?gone=' + i
        document.body.append(frame)
        setTimeout(() => frame.remove(), i % 4)
      }
      window.open('/plain?gone')?.close()
    })()`)
    await new Promise((done) => setTimeout(done, 3000))
    expect(app.runtime.status(profile.id)).toBe('running')
    const snapshot = app.sessions.get(profile.id)!.fingerprintSnapshot!
    expect(snapshot.effective.mode).toBe('native')
    const state = await app.services.fingerprint.session(profile.id)
    expect(state.pendingRestart).toBe(false)
    expect(state.observations.some((value) => value.userAgent === first.ua)).toBe(true)
    await app.runtime.stop(profile.id)
    await assertDirectoryIdle(app.files.directory(profile.id))
  }, 90000)

  it('Emulação aplica primeira requisição, documentos e geo manual; edição e recuperação preservam a sessão antiga até reiniciar', async () => {
    const fingerprint = await app.services.fingerprint.generate('linux')
    fingerprint.timezone = { mode: 'manual', id: 'Asia/Tokyo' }
    fingerprint.languages = { mode: 'manual', list: ['ja-JP', 'ja', 'en-US'] }
    fingerprint.navigator.hardwareConcurrency = 6
    fingerprint.navigator.deviceMemory = 4
    fingerprint.geolocation = { mode: 'manual', latitude: 35.68, longitude: 139.69, accuracy: 42 }
    fingerprint.webrtc.mode = 'disabled'
    const profile = create('emulated', fingerprint)
    await app.runtime.start(profile.id)
    let tab = await page(profile.id)
    const first = await tab.evaluate<Reading>('window.first')
    expect(first.webdriver).toBe(false)
    expect(first).toMatchObject({
      platform: 'Linux x86_64',
      timezone: 'Asia/Tokyo',
      cores: 6,
      memory: 4,
      webrtc: 'blocked',
      hints: { platform: 'Linux' },
    })
    expect(first.screen?.slice(0, 2)).toEqual([fingerprint.screen.width, fingerprint.screen.height])
    const request = site.requests.find((request) => request.path === '/page?emulated')!
    expect(request.headers['user-agent']).toBe(fingerprint.userAgent)
    expect(request.headers['sec-ch-ua-platform']).toBe('"Linux"')
    expect(request.headers['accept-language']).toMatch(/^ja-JP/)
    expect(
      await tab.evaluate(
        `new Promise(resolve => navigator.geolocation.getCurrentPosition(p => resolve([p.coords.latitude,p.coords.longitude,p.coords.accuracy]),e => resolve({error:e.code})))`,
        true,
      ),
    ).toEqual([35.68, 139.69, 42])
    await vi.waitFor(
      async () => {
        const reports = await tab.evaluate<Record<string, Reading>>('window.reports')
        for (const type of ['worker', 'shared', 'service', '127.0.0.1', 'localhost'])
          expect(reports[type], type).toBeDefined()
        for (const type of ['127.0.0.1', 'localhost'])
          expect(reports[type]).toMatchObject({
            platform: 'Linux x86_64',
            timezone: 'Asia/Tokyo',
            webrtc: 'blocked',
          })
      },
      { timeout: 20000 },
    )
    // Bloquear, sem proxy: o bloqueio da API alcança até o construtor de um iframe novo, e a
    // preferência nativa cobre o que ele não alcança. Um mundo isolado (como o content script
    // de uma extensão) tem o RTCPeerConnection nativo, e mesmo assim nenhum pacote STUN sai.
    const preferences = JSON.parse(
      fs.readFileSync(join(app.sessions.get(profile.id)!.userDataDir, 'Default', 'Preferences'), 'utf8'),
    )
    expect(preferences.webrtc.ip_handling_policy).toBe('disable_non_proxied_udp')
    const stun = await stunServer()
    try {
      const fromFrame =
        "document.body.appendChild(document.createElement('iframe')).contentWindow.RTCPeerConnection"
      expect(
        await tab.evaluate(`${gatherCandidates(stun.port, fromFrame)}.catch(error => error.name)`, true),
      ).toBe('NotAllowedError')
      const { executionContextId } = await tab.client.send(
        'Page.createIsolatedWorld',
        { frameId: tab.targetId, worldName: 'facet-webrtc-test' },
        tab.sessionId,
      )
      const isolated = await tab.client.send(
        'Runtime.evaluate',
        {
          expression: gatherCandidates(stun.port),
          contextId: executionContextId,
          awaitPromise: true,
          returnByValue: true,
        },
        tab.sessionId,
        12000,
      )
      expect(isolated.exceptionDetails?.exception?.description).toBeUndefined()
      expect(isolated.result.value).toEqual([])
      expect(stun.requests(), 'nenhum pacote STUN pode sair no modo Bloquear').toBe(0)
    } finally {
      await stun.close()
    }
    const snapshot = app.sessions.get(profile.id)!.fingerprintSnapshot
    const next = structuredClone(app.services.profiles.get(profile.id).fingerprint)
    next.timezone.id = 'Europe/Lisbon'
    next.navigator.hardwareConcurrency = 10
    app.services.profiles.update(profile.id, { fingerprint: next })
    expect((await app.services.fingerprint.session(profile.id)).pendingRestart).toBe(true)
    expect(await tab.evaluate<Reading>(READ_FINGERPRINT)).toMatchObject({ timezone: 'Asia/Tokyo', cores: 6 })
    // `void`: o Window devolvido por window.open não é serializável por valor.
    await tab.evaluate(`void window.open(${JSON.stringify(site.url + '/plain?popup')})`)
    const popup = await page(profile.id, '/plain?popup')
    expect(await popup.evaluate<Reading>(READ_FINGERPRINT)).toMatchObject({
      timezone: 'Asia/Tokyo',
      cores: 6,
    })
    // Nova instância simula reabrir o app com o processo Brave sobrevivente.
    app.runtime.client(profile.id)!.close()
    const recovered = make()
    try {
      await recovered.initialize()
      expect(recovered.sessions.get(profile.id)!.fingerprintSnapshot).toEqual(snapshot)
      expect((await recovered.services.fingerprint.session(profile.id)).pendingRestart).toBe(true)
      const observations = await recovered.services.fingerprint.session(profile.id)
      expect(observations.observations.find((value) => value.targetType === 'page')?.timezone).toBe(
        'Asia/Tokyo',
      )
      await recovered.runtime.stop(profile.id)
    } finally {
      await recovered.close()
    }
    await vi.waitFor(() => expect(app.runtime.status(profile.id)).toBe('stopped'), { timeout: 15000 })
    await app.runtime.start(profile.id)
    tab = await page(profile.id)
    expect(await tab.evaluate<Reading>('window.first')).toMatchObject({
      timezone: 'Europe/Lisbon',
      cores: 10,
    })
    expect((await app.services.fingerprint.session(profile.id)).pendingRestart).toBe(false)
    await app.runtime.stop(profile.id)
  }, 120000)
})
