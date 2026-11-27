import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { capabilitiesFor, fallbackBrands, userAgentSuffix } from '@main/browser/fingerprint/capabilities'
import { operaBrowserExecutable } from '@main/browser/detect'
import { DEFAULT_WINDOW, MIN_WINDOW_WIDTH, profileWindow, WINDOW_FRAME } from '@main/browser/window-size'
import { MOBILE_DEVICES } from '@shared/data/mobile-devices'
import {
  canonicalFingerprint,
  emptyUsage,
  generateFingerprint,
  hardwareCombinations,
  trackFingerprint,
} from '@main/browser/fingerprint/generator'
import { resolveFingerprint } from '@main/browser/fingerprint/resolve'
import { geoPermission } from '@main/browser/fingerprint/apply'
import {
  createDefaultFingerprint,
  fingerprintKey,
  fingerprintSchema,
  fingerprintV2Schema,
  SCREEN_PRESETS,
  screenKey,
  type FingerprintCapabilities,
} from '@shared/schemas/fingerprint'
import { DESKTOP_OS_LIST, OS_LIST } from '@shared/constants'
import type { ProxyGeo } from '@shared/schemas/proxy'

const cap: FingerprintCapabilities = {
  engineMajor: 158,
  product: 'Chrome/158.0.8127.92',
  hostOs: 'windows',
  nativeUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
}
const host = { timezone: 'America/Sao_Paulo', languages: ['pt-BR', 'pt'] }
const tokyo: ProxyGeo = {
  countryCode: 'JP',
  countryName: 'Japan',
  region: 'Tokyo',
  city: 'Tokyo',
  timezone: 'Asia/Tokyo',
  latitude: 35.68,
  longitude: 139.69,
}
const base = () => createDefaultFingerprint({ os: 'windows', engineMajor: 158, timezone: 'UTC' })

describe('fingerprint v2', () => {
  it('lê v1 como emulação preservando os valores, sem modificar o objeto original', () => {
    const { mode: _mode, ...rest } = base()
    const legacy = { ...rest, version: 1 }
    const parsed = fingerprintSchema.parse(legacy)
    expect(parsed).toEqual({ ...rest, version: 2, mode: 'emulated' })
    expect(legacy.version).toBe(1)
  })
  it('recusa fuso, idioma, coordenadas e área útil incoerentes', () => {
    const invalid = [
      { ...base(), timezone: { mode: 'manual', id: 'Mars/Olympus' } },
      { ...base(), languages: { mode: 'manual', list: ['not a language'] } },
      { ...base(), geolocation: { ...base().geolocation, mode: 'manual' } },
      { ...base(), screen: { ...base().screen, availWidth: 7000 } },
      { ...base(), noise: { canvas: 'off', webgl: 'brave', audio: 'brave' } },
    ]
    for (const value of invalid) expect(fingerprintV2Schema.safeParse(value).success).toBe(false)
  })
  it('mantém modo nativo no sistema real e deriva UA/CH da versão do executável', () => {
    const next = canonicalFingerprint({ ...base(), os: 'linux', userAgent: 'x'.repeat(30) }, cap)
    expect(next.os).toBe('windows')
    expect(next.userAgent).toBe(cap.nativeUserAgent)
    expect(next.uaData.fullVersionList.find((value) => value.brand === 'Chromium')?.version).toBe(
      '158.0.8127.92',
    )
    expect(capabilitiesFor({ product: cap.product, userAgent: cap.nativeUserAgent }).engineMajor).toBe(158)
    expect(() => capabilitiesFor({ product: 'unknown', userAgent: null })).toThrow()
  })
  it.each(['windows', 'macos', 'linux'] as const)(
    'gera %s sem repetir a tela e preserva campos manuais',
    (os) => {
      const current = base()
      current.timezone = { mode: 'manual', id: 'Europe/Lisbon' }
      current.languages = { mode: 'manual', list: ['pt-PT', 'en'] }
      current.geolocation = { mode: 'manual', latitude: 38.7, longitude: -9.1, accuracy: 35 }
      const next = generateFingerprint(os, cap, { current, choose: () => 0 })
      expect(fingerprintV2Schema.safeParse(next).success).toBe(true)
      expect(next.mode).toBe('emulated')
      expect(next.os).toBe(os)
      expect(next.screen).not.toEqual(current.screen)
      expect(next.languages).toEqual(current.languages)
      expect(next.timezone).toEqual(current.timezone)
      expect(next.geolocation).toEqual(current.geolocation)
      expect(next).not.toBe(current)
    },
  )
  it.each(DESKTOP_OS_LIST)(
    'telas de %s sem repetição e todas comportam a janela padrão (1280 × 800)',
    (os) => {
      const screens = SCREEN_PRESETS[os]
      expect(new Set(screens.map(screenKey)).size).toBe(screens.length)
      for (const screen of screens) {
        // No Brave 158 a janela padrão mostra a página em 1264 × 711 e o outer em até 1272 × 719.
        expect(screen.availWidth, screenKey(screen)).toBeGreaterThanOrEqual(1280)
        expect(screen.availHeight, screenKey(screen)).toBeGreaterThanOrEqual(720)
      }
      for (const hardware of hardwareCombinations(os))
        expect(hardware.memory === 4 && hardware.cores > 8, hardware.key).toBe(false)
    },
  )
  it('quantidade de combinações realistas por sistema (citada no README)', () => {
    // computadores: tela × núcleos × memória; celulares: um aparelho por combinação
    expect(OS_LIST.map((os) => hardwareCombinations(os).length)).toEqual([154, 64, 72, 9, 8])
    for (const os of OS_LIST) {
      const keys = hardwareCombinations(os).map((hardware) => hardware.key)
      expect(new Set(keys).size).toBe(keys.length)
    }
  })
  it('chave do hardware: emulação (e v1) tem chave; nativo não', () => {
    const emulated = generateFingerprint('linux', cap, { choose: () => 0 })
    expect(fingerprintKey(emulated)).toBe(
      `linux|${emulated.screen.width}x${emulated.screen.height}|${emulated.screen.availWidth}x${emulated.screen.availHeight}|24|${emulated.screen.pixelRatio}|${emulated.navigator.hardwareConcurrency}|${emulated.navigator.deviceMemory}|0`,
    )
    expect(fingerprintKey({ ...emulated, mode: 'native' })).toBeNull()
    const { mode: _mode, ...legacy } = emulated
    expect(fingerprintKey(legacy)).toBe(fingerprintKey(emulated))
    expect(
      fingerprintKey({ ...emulated, navigator: { ...emulated.navigator, deviceMemory: null } }),
    ).toContain('|brave|')
  })
  it.each(OS_LIST)('%s: sorteia combinações nunca usadas até esgotar, depois a menos usada', (os) => {
    const all = hardwareCombinations(os)
    const usage = emptyUsage()
    const keys = new Set<string>()
    for (let i = 0; i < all.length; i++) {
      const next = generateFingerprint(os, cap, { usage })
      const key = fingerprintKey(next)!
      expect(keys.has(key), `repetiu ${key} na rodada ${i}`).toBe(false)
      keys.add(key)
      trackFingerprint(usage, next)
    }
    expect(keys.size).toBe(all.length)
    // Tudo em uso: a próxima é uma das menos usadas (todas com 1), e a seguinte não a repete.
    const first = generateFingerprint(os, cap, { usage })
    trackFingerprint(usage, first)
    const second = generateFingerprint(os, cap, { usage })
    expect(fingerprintKey(second)).not.toBe(fingerprintKey(first))
  })
  it('prefere a combinação de um perfil já excluído à de um perfil existente', () => {
    const all = hardwareCombinations('macos')
    const [deleted, ...rest] = all
    // todas já usadas; só `deleted` não pertence a nenhum perfil existente
    const usage = {
      inUse: new Map(rest.map((hardware) => [hardware.key, 1])),
      used: new Set(all.map((hardware) => hardware.key)),
    }
    const next = generateFingerprint('macos', cap, { usage })
    expect(fingerprintKey(next)).toBe(deleted!.key)
  })
  it('perfil novo pode receber a tela padrão; o botão Gerar sempre troca a tela', () => {
    const draft = createDefaultFingerprint({ os: 'windows', engineMajor: 158, timezone: 'Europe/Lisbon' })
    const fresh = generateFingerprint('windows', cap, { base: draft, choose: () => 0 })
    expect(fresh.screen).toEqual(SCREEN_PRESETS.windows[0])
    expect(fresh.timezone).toEqual(draft.timezone)
    expect(fresh.mode).toBe('emulated')
    const regenerated = generateFingerprint('windows', cap, { current: fresh, choose: () => 0 })
    expect(screenKey(regenerated.screen)).not.toBe(screenKey(fresh.screen))
  })
  it('resolve automáticos e bloqueia coordenadas ausentes sem reaproveitar a localização anterior', () => {
    const config = base()
    const resolved = resolveFingerprint(config, cap, tokyo, host, 123)
    expect(resolved.effective.timezone.id).toBe('Asia/Tokyo')
    expect(resolved.effective.languages.list[0]).toBe('ja-JP')
    expect(geoPermission(resolved.effective)).toBe('granted')
    const missing = resolveFingerprint(
      resolved.effective,
      cap,
      { ...tokyo, latitude: null, longitude: null },
      host,
    )
    expect(missing.effective.geolocation.latitude).toBeNull()
    expect(geoPermission(missing.effective)).toBe('denied')
    const direct = resolveFingerprint(resolved.effective, cap, null, host)
    expect(direct.effective.timezone.id).toBe(host.timezone)
    expect(direct.effective.languages.list).toEqual(host.languages)
    expect(geoPermission(direct.effective)).toBe('denied')
    expect(config.timezone.id).toBe('UTC')
  })
  it('exige geo-IP para fuso/idiomas automáticos mas aceita configuração manual', () => {
    const unavailable = { ...tokyo, timezone: null, countryCode: null }
    expect(() => resolveFingerprint(base(), cap, unavailable, host)).toThrowError(
      expect.objectContaining({ code: 'FINGERPRINT_GEO_REQUIRED' }),
    )
    const config = base()
    config.timezone.mode = 'manual'
    config.languages.mode = 'manual'
    expect(resolveFingerprint(config, cap, unavailable, host).effective.timezone.id).toBe('UTC')
  })
})

/** Marcas lidas na sondagem do Chrome 158 e do Opera 140 (Chromium 157). */
const chrome: FingerprintCapabilities = {
  ...cap,
  product: 'Chrome/158.0.8127.38',
  browser: 'chrome',
  uaSuffix: '',
  brands: [
    { brand: 'Chromium', version: '158' },
    { brand: 'Not.A/Brand', version: '24' },
    { brand: 'Google Chrome', version: '158' },
  ],
  fullVersionList: [
    { brand: 'Chromium', version: '158.0.8127.38' },
    { brand: 'Not.A/Brand', version: '24.0.0.0' },
    { brand: 'Google Chrome', version: '158.0.8127.38' },
  ],
}
const opera: FingerprintCapabilities = {
  engineMajor: 157,
  product: 'Chrome/157.0.8103.79',
  hostOs: 'windows',
  browser: 'opera',
  nativeUserAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36 OPR/140.0.0.0',
  uaSuffix: ' OPR/140.0.0.0',
}

describe('navegadores: marcas das Client Hints e User-Agent', () => {
  it('marcas calculadas iguais às que cada navegador informa (conferidas na sondagem real)', () => {
    expect(fallbackBrands('ungoogled', { engineMajor: 158, product: 'Chrome/158.0.8127.36' })).toEqual({
      brands: [
        { brand: 'Not.A/Brand', version: '24' },
        { brand: 'Chromium', version: '158' },
      ],
      fullVersionList: [
        { brand: 'Not.A/Brand', version: '24.0.0.0' },
        { brand: 'Chromium', version: '158.0.8127.36' },
      ],
    })
    expect(fallbackBrands('chrome', chrome).brands).toEqual(chrome.brands)
    expect(fallbackBrands('chrome', chrome).fullVersionList).toEqual(chrome.fullVersionList)
    // Opera: marca própria com a versão dele, ordem e GREASE pela versão do Chromium (157)
    expect(fallbackBrands('opera', opera).brands).toEqual([
      { brand: 'Not-A.Brand', version: '99' },
      { brand: 'Opera', version: '140' },
      { brand: 'Chromium', version: '157' },
    ])
    expect(fallbackBrands('brave', { engineMajor: 158, product: 'Chrome/158.0.8127.92' }).brands).toEqual([
      { brand: 'Chromium', version: '158' },
      { brand: 'Not.A/Brand', version: '24' },
      { brand: 'Brave', version: '158' },
    ])
  })
  it('sufixo do User-Agent: o do Opera vai junto na emulação de qualquer sistema', () => {
    expect(userAgentSuffix(opera.nativeUserAgent)).toBe(' OPR/140.0.0.0')
    expect(userAgentSuffix(cap.nativeUserAgent)).toBe('')
    const operaCaps = { ...opera, ...fallbackBrands('opera', opera) }
    const mac = generateFingerprint('macos', operaCaps, { choose: () => 0 })
    expect(mac.userAgent).toMatch(/Macintosh.*Chrome\/157\.0\.0\.0 Safari\/537\.36 OPR\/140\.0\.0\.0$/)
    expect(mac.uaData.brands.map((brand) => brand.brand)).toEqual(['Not-A.Brand', 'Opera', 'Chromium'])
    const android = generateFingerprint('android', operaCaps, { choose: () => 0 })
    expect(android.userAgent).toMatch(/Mobile Safari\/537\.36 OPR\/140\.0\.0\.0$/)
    // o Safari do iPhone não tem sufixo de navegador
    expect(generateFingerprint('ios', operaCaps, { choose: () => 0 }).userAgent).not.toContain('OPR')
  })
  it('emulação usa as marcas lidas do navegador (Chrome), não as calculadas para o Brave', () => {
    const next = generateFingerprint('linux', chrome, { choose: () => 0 })
    expect(next.uaData.brands).toEqual(chrome.brands)
    expect(next.uaData.fullVersionList).toEqual(chrome.fullVersionList)
  })
})

describe('celulares emulados (Android e iOS)', () => {
  it('Android: User-Agent reduzido do Chrome, Client Hints, tela, toque e hardware do aparelho', () => {
    const next = generateFingerprint('android', chrome, { choose: () => 0 })
    const device = MOBILE_DEVICES.android[0]!
    expect(fingerprintV2Schema.safeParse(next).success).toBe(true)
    expect(next).toMatchObject({ mode: 'emulated', os: 'android', device: device.id })
    expect(next.userAgent).toBe(
      'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36',
    )
    expect(next.uaData).toMatchObject({
      platform: 'Android',
      platformVersion: device.osVersion,
      model: device.model,
      mobile: true,
      architecture: '',
      bitness: '',
    })
    expect(next.uaData.brands).toEqual(chrome.brands)
    expect(next.navigator).toEqual({
      platform: 'Linux armv81',
      hardwareConcurrency: device.cores,
      deviceMemory: device.memory,
      maxTouchPoints: 5,
    })
    expect(next.screen).toEqual({
      width: device.screen.width,
      height: device.screen.height,
      availWidth: device.screen.width,
      availHeight: device.screen.height,
      colorDepth: 24,
      pixelRatio: device.screen.pixelRatio,
    })
    expect(fingerprintKey(next)).toMatch(new RegExp(`\\|5\\|${device.id}$`))
  })
  it('iOS: User-Agent do Safari, sem deviceMemory, 4 núcleos e plataforma iPhone', () => {
    const next = generateFingerprint('ios', cap, { choose: () => 0 })
    const device = MOBILE_DEVICES.ios[0]!
    const version = device.osVersion
    expect(next.userAgent).toBe(
      `Mozilla/5.0 (iPhone; CPU iPhone OS ${version.replaceAll('.', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`,
    )
    expect(next.navigator).toEqual({
      platform: 'iPhone',
      hardwareConcurrency: 4,
      deviceMemory: null,
      maxTouchPoints: 5,
    })
    expect(next.uaData.mobile).toBe(true)
  })
  it('o aparelho define o hardware: valores editados à mão voltam aos do aparelho', () => {
    const android = generateFingerprint('android', cap, { choose: () => 0 })
    const edited = {
      ...android,
      screen: { ...android.screen, width: 1920, availWidth: 1920 },
      navigator: { ...android.navigator, hardwareConcurrency: 32, maxTouchPoints: 0 },
    }
    const canonical = canonicalFingerprint(edited, cap)
    expect(canonical.screen).toEqual(android.screen)
    expect(canonical.navigator).toEqual(android.navigator)
  })
  it('celular não existe no modo nativo; computador não guarda aparelho', () => {
    const android = generateFingerprint('android', cap, { choose: () => 0 })
    const native = canonicalFingerprint({ ...android, mode: 'native' }, cap)
    expect(native.os).toBe(cap.hostOs)
    expect('device' in native).toBe(false)
    const desktop = canonicalFingerprint({ ...base(), mode: 'emulated', device: 'pixel-8' }, cap)
    expect('device' in desktop).toBe(false)
    expect(fingerprintKey(desktop)).not.toContain('pixel-8')
  })
  it('recusa celular sem aparelho válido', () => {
    const android = generateFingerprint('android', cap, { choose: () => 0 })
    const result = fingerprintV2Schema.safeParse({ ...android, device: 'nao-existe' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]).toMatchObject({ path: ['device'], message: 'invalidDevice' })
    expect(fingerprintV2Schema.safeParse({ ...android, device: MOBILE_DEVICES.ios[0]!.id }).success).toBe(
      false,
    )
  })
  it('Gerar sempre troca o aparelho, mesmo entre modelos com a mesma tela (iPhone 15 e 16)', () => {
    const iphone16 = MOBILE_DEVICES.ios.find((device) => device.id === 'iphone-16')!
    const current = createDefaultFingerprint({
      os: 'ios',
      engineMajor: 158,
      timezone: 'UTC',
      device: iphone16.id,
    })
    for (let i = 0; i < MOBILE_DEVICES.ios.length; i++) {
      const next = generateFingerprint('ios', cap, { current, choose: (max) => i % max })
      expect(next.device).not.toBe(iphone16.id)
    }
  })
  it('aparelhos do catálogo: ids únicos e valores coerentes', () => {
    for (const os of ['android', 'ios'] as const) {
      const ids = MOBILE_DEVICES[os].map((device) => device.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const device of MOBILE_DEVICES[os]) {
        expect(device.screen.width).toBeGreaterThanOrEqual(360)
        expect(device.screen.width).toBeLessThanOrEqual(440)
        expect(device.viewportHeight).toBeLessThan(device.screen.height)
        expect(device.memory === null).toBe(os === 'ios')
        expect(device.model === '').toBe(os === 'ios')
      }
    }
  })
})

describe('janela do perfil', () => {
  it('computador: a das opções ou a padrão, sem escala', () => {
    expect(profileWindow(base(), null, null)).toEqual({ window: DEFAULT_WINDOW, scale: 1 })
    expect(profileWindow(base(), { width: 900, height: 700 }, { width: 800, height: 600 })).toEqual({
      window: { width: 900, height: 700 },
      scale: 1,
    })
  })
  it('celular: janela do tamanho do aparelho; numa tela baixa a imagem da página encolhe', () => {
    const android = generateFingerprint('android', cap, { choose: () => 0 })
    const device = MOBILE_DEVICES.android[0]!
    const roomy = profileWindow(android, null, { width: 1920, height: 1040 })
    expect(roomy.window).toEqual({
      width: Math.max(device.screen.width + WINDOW_FRAME.width, MIN_WINDOW_WIDTH),
      height: device.viewportHeight + WINDOW_FRAME.height,
    })
    expect(roomy.scale).toBe(1)
    const small = profileWindow(android, null, { width: 1366, height: 728 })
    expect(small.window.height).toBe(728)
    // arredondada para baixo: a página sempre cabe
    expect(small.scale).toBe(Math.floor(((728 - WINDOW_FRAME.height) / device.viewportHeight) * 100) / 100)
    expect(small.scale).toBeLessThan(1)
  })
})

describe('detecção do Opera', () => {
  it('troca o lançador pelo navegador da versão mais nova instalada', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'facet-opera-'))
    try {
      fs.writeFileSync(path.join(root, 'opera.exe'), '')
      for (const version of ['139.0.6033.10', '140.0.6074.36', '99.0.1.1']) {
        fs.mkdirSync(path.join(root, version))
        fs.writeFileSync(path.join(root, version, 'opera.exe'), '')
      }
      fs.mkdirSync(path.join(root, 'assistant'))
      const resolved = await operaBrowserExecutable(path.join(root, 'opera.exe'))
      if (process.platform === 'win32')
        expect(resolved.toLowerCase()).toBe(
          fs.realpathSync.native(path.join(root, '140.0.6074.36', 'opera.exe')).toLowerCase(),
        )
      // o navegador já resolvido continua o mesmo
      expect(await operaBrowserExecutable(path.join(root, '140.0.6074.36', 'opera.exe'))).toBe(
        path.join(root, '140.0.6074.36', 'opera.exe'),
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
