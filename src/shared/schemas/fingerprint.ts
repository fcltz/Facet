import { z } from 'zod'
import type { BrowserKind } from '../constants'
import { MOBILE_DEVICES, mobileDevice, type MobileDevice } from '../data/mobile-devices'
import { browserKindSchema, isMobileOs, osSchema, type DesktopOs, type OsName } from './common'

export const valueModeSchema = z.enum(['auto', 'manual'])
export type ValueMode = z.infer<typeof valueModeSchema>

export const geoModeSchema = z.enum(['auto', 'manual', 'block', 'prompt'])
export type GeoMode = z.infer<typeof geoModeSchema>

export const webrtcModeSchema = z.enum(['proxy_only', 'disabled', 'real'])
export type WebrtcMode = z.infer<typeof webrtcModeSchema>

export const noiseModeSchema = z.enum(['brave', 'off'])
export type NoiseMode = z.infer<typeof noiseModeSchema>

const brandSchema = z.object({ brand: z.string().min(1), version: z.string().min(1) })
export type UaBrand = z.infer<typeof brandSchema>

/** Larguras a partir de 320: telas de celular (360–440 px CSS). */
const screenSchema = z.object({
  width: z.number().int().min(320).max(7680),
  height: z.number().int().min(480).max(4320),
  availWidth: z.number().int().min(320).max(7680),
  availHeight: z.number().int().min(400).max(4320),
  colorDepth: z.number().int().min(8).max(48),
  pixelRatio: z.number().min(1).max(4),
})
export type ScreenConfig = z.infer<typeof screenSchema>

/**
 * Formato v1 do fingerprint (pré-visualização das Etapas 1 a 4), lido como emulação.
 * O v2 acrescenta o modo; os campos "auto" são resolvidos de novo em cada abertura.
 */
const legacyFingerprintSchema = z.object({
  version: z.literal(1),
  os: osSchema,
  engineMajor: z.number().int().min(100).max(999),
  userAgent: z.string().min(20).max(512),
  uaData: z.object({
    brands: z.array(brandSchema).min(1).max(5),
    fullVersionList: z.array(brandSchema).min(1).max(5),
    platform: z.string().min(1),
    platformVersion: z.string(),
    architecture: z.string(),
    bitness: z.string(),
    model: z.string(),
    mobile: z.boolean(),
    wow64: z.boolean(),
  }),
  navigator: z.object({
    platform: z.string().min(1),
    hardwareConcurrency: z.number().int().min(1).max(128),
    /** null = deixar o Brave controlar o valor; não significa propriedade oculta. */
    deviceMemory: z.number().positive().nullable(),
    maxTouchPoints: z.number().int().min(0).max(10),
  }),
  screen: screenSchema,
  languages: z.object({ mode: valueModeSchema, list: z.array(z.string().min(2).max(35)).min(1).max(10) }),
  timezone: z.object({ mode: valueModeSchema, id: z.string().min(1) }),
  geolocation: z.object({
    mode: geoModeSchema,
    latitude: z.number().min(-90).max(90).nullable(),
    longitude: z.number().min(-180).max(180).nullable(),
    accuracy: z.number().positive().max(100000),
  }),
  webrtc: z.object({ mode: webrtcModeSchema }),
  noise: z.object({ canvas: noiseModeSchema, webgl: noiseModeSchema, audio: noiseModeSchema }),
})
export function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}
export function validLanguage(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1
  } catch {
    return false
  }
}
export const fingerprintV2Schema = legacyFingerprintSchema
  .extend({
    version: z.literal(2),
    mode: z.enum(['native', 'emulated']),
    /** Aparelho emulado no Android e no iOS (`MOBILE_DEVICES`); ausente ou null nos computadores. */
    device: z.string().min(1).max(64).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (!validTimezone(value.timezone.id))
      ctx.addIssue({ code: 'custom', path: ['timezone', 'id'], message: 'invalidTimezone' })
    value.languages.list.forEach((language, index) => {
      if (!validLanguage(language))
        ctx.addIssue({ code: 'custom', path: ['languages', 'list', index], message: 'invalidLanguage' })
    })
    if (value.screen.availWidth > value.screen.width || value.screen.availHeight > value.screen.height)
      ctx.addIssue({ code: 'custom', path: ['screen'], message: 'invalidScreen' })
    if (
      value.geolocation.mode === 'manual' &&
      (value.geolocation.latitude === null || value.geolocation.longitude === null)
    )
      ctx.addIssue({ code: 'custom', path: ['geolocation'], message: 'coordinatesRequired' })
    if (new Set(Object.values(value.noise)).size !== 1)
      ctx.addIssue({ code: 'custom', path: ['noise'], message: 'coupledFarbling' })
    if (isMobileOs(value.os) && !mobileDevice(value.device, value.os))
      ctx.addIssue({ code: 'custom', path: ['device'], message: 'invalidDevice' })
  })
export type FingerprintConfig = z.infer<typeof fingerprintV2Schema>
/** A leitura não regrava o legado. A próxima edição/abertura persiste v2. */
export const fingerprintSchema = z.union([
  fingerprintV2Schema,
  legacyFingerprintSchema.transform((value): FingerprintConfig => ({
    ...value,
    version: 2,
    mode: 'emulated',
  })),
])
export const fingerprintGenerateSchema = z.object({
  os: osSchema,
  /** Navegador do perfil: marcas das Client Hints e sufixo do User-Agent (ausente = o padrão). */
  browser: browserKindSchema.optional(),
  /** Rascunho atual: fuso, idiomas, geolocalização, WebRTC e ruído continuam os dele. */
  current: fingerprintV2Schema.optional(),
  /**
   * Rascunho novo (perfil novo, troca de sistema ou de modo): nada a evitar. Sem ele, o
   * resultado sempre troca a tela do rascunho atual (botão Gerar).
   */
  fresh: z.boolean().optional(),
})
export interface FingerprintCapabilities {
  engineMajor: number
  product: string
  hostOs: OsName
  nativeUserAgent: string
  /** Navegador sondado; ausente na pré-visualização (antes da sondagem). */
  browser?: BrowserKind
  /**
   * Marcas das Client Hints exatamente como o navegador informa (lidas na sondagem): Chromium,
   * "Google Chrome", "Brave" ou "Opera" (com a versão do Opera), e a marca GREASE.
   */
  brands?: UaBrand[]
  fullVersionList?: UaBrand[]
  /** O que o navegador acrescenta ao User-Agent depois de "Safari/537.36" (Opera: " OPR/140.0.0.0"). */
  uaSuffix?: string
  /**
   * Ruído nativo de canvas, WebGL e áudio: o farbling do Brave ou as flags de fingerprinting do
   * Ungoogled Chromium. Chrome e Opera não têm (o modo "ruído" não muda nada neles).
   */
  nativeNoise?: boolean
}
export interface FingerprintSnapshot {
  configured: FingerprintConfig
  effective: FingerprintConfig
  engineProduct: string
  createdAt: number
}
export const fingerprintSnapshotSchema = z.object({
  configured: fingerprintV2Schema,
  effective: fingerprintV2Schema,
  engineProduct: z.string().min(1),
  createdAt: z.number().finite(),
})
export interface FingerprintObservation {
  targetType: string
  userAgent: string
  platform: string
  languages: string[]
  timezone: string
  hardwareConcurrency: number
  deviceMemory: number | null
  /** navigator.maxTouchPoints (5 nos celulares emulados). */
  maxTouchPoints?: number
  screen: {
    width: number
    height: number
    availWidth: number
    availHeight: number
    pixelRatio: number
    colorDepth: number
  } | null
}
export interface FingerprintSessionState {
  snapshot: FingerprintSnapshot | null
  active: boolean
  pendingRestart: boolean
  observations: FingerprintObservation[]
  warnings: string[]
}

interface OsPreset {
  /**
   * User-Agent com a versão principal do motor e o sufixo do navegador (Opera: " OPR/140.0.0.0").
   * Nos celulares, o aparelho define a versão do sistema (iOS) e fica nas Client Hints (Android).
   */
  userAgent: (major: string, suffix: string, device: MobileDevice | null) => string
  uaPlatform: string
  platformVersion: (device: MobileDevice | null) => string
  navigatorPlatform: string
  architecture: string
  bitness: string
}

const OS_PRESETS: Record<OsName, OsPreset> = {
  windows: {
    userAgent: (m, suffix) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36${suffix}`,
    uaPlatform: 'Windows',
    platformVersion: () => '10.0.0',
    navigatorPlatform: 'Win32',
    architecture: 'x86',
    bitness: '64',
  },
  macos: {
    userAgent: (m, suffix) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36${suffix}`,
    uaPlatform: 'macOS',
    platformVersion: () => '15.5.0',
    navigatorPlatform: 'MacIntel',
    architecture: 'x86',
    bitness: '64',
  },
  linux: {
    userAgent: (m, suffix) =>
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36${suffix}`,
    uaPlatform: 'Linux',
    platformVersion: () => '6.8.0',
    navigatorPlatform: 'Linux x86_64',
    architecture: 'x86',
    bitness: '64',
  },
  android: {
    // User-Agent reduzido do Chrome para Android: modelo e versão do sistema só nas Client Hints.
    userAgent: (m, suffix) =>
      `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Mobile Safari/537.36${suffix}`,
    uaPlatform: 'Android',
    platformVersion: (device) => device?.osVersion ?? '15.0.0',
    // Chrome nos celulares ARM de 64 bits; arquitetura e bits ficam vazios nas Client Hints.
    navigatorPlatform: 'Linux armv81',
    architecture: '',
    bitness: '',
  },
  ios: {
    // Safari: todo navegador do iPhone usa o WebKit da Apple, sem Client Hints.
    userAgent: (_m, _suffix, device) => {
      const version = device?.osVersion ?? '18.6'
      return `Mozilla/5.0 (iPhone; CPU iPhone OS ${version.replaceAll('.', '_')} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${version} Mobile/15E148 Safari/604.1`
    },
    uaPlatform: 'iOS',
    platformVersion: (device) => device?.osVersion ?? '18.6',
    navigatorPlatform: 'iPhone',
    architecture: '',
    bitness: '',
  },
}

function screen(
  width: number,
  height: number,
  reserved: number,
  pixelRatio: number,
  colorDepth = 24,
): ScreenConfig {
  return { width, height, availWidth: width, availHeight: height - reserved, colorDepth, pixelRatio }
}

/**
 * Resoluções comuns por sistema, em px CSS (área útil já descontando barra de tarefas/menu).
 * Todas comportam a janela padrão do perfil (1280 × 800): no Brave 158 a página dessa janela
 * mede 1264 × 711 e o outerWidth/outerHeight, arredondado pelo farbling, até 1272 × 719 — numa
 * tela menor a janela ficaria maior que a tela, uma incoerência visível para os sites.
 */
export const SCREEN_PRESETS: Record<DesktopOs, readonly ScreenConfig[]> = {
  windows: [
    screen(1920, 1080, 48, 1),
    screen(1366, 768, 40, 1),
    screen(1536, 864, 48, 1.25),
    screen(2560, 1440, 48, 1),
    screen(1440, 900, 40, 1),
    screen(1600, 900, 40, 1),
    screen(1680, 1050, 40, 1),
    screen(1920, 1200, 48, 1),
    screen(1280, 1024, 40, 1),
    screen(1280, 800, 40, 1),
    screen(1360, 768, 40, 1),
    screen(2048, 1152, 48, 1.25),
    screen(2560, 1440, 48, 1.5),
    screen(1920, 1080, 48, 2),
  ],
  macos: [
    screen(1512, 982, 38, 2, 30),
    screen(1440, 900, 38, 2, 30),
    screen(1728, 1117, 38, 2, 30),
    screen(1920, 1080, 25, 1, 24),
    screen(1470, 956, 38, 2, 30),
    screen(1680, 1050, 25, 2, 30),
    screen(1280, 800, 25, 2, 30),
    screen(2560, 1440, 25, 1, 24),
  ],
  linux: [
    screen(1920, 1080, 27, 1),
    screen(2560, 1440, 27, 1),
    screen(1366, 768, 27, 1),
    screen(1920, 1200, 27, 1),
    screen(1600, 900, 27, 1),
    screen(1680, 1050, 27, 1),
    screen(1440, 900, 27, 1),
    screen(1920, 1080, 27, 2),
  ],
}

/** Núcleos lógicos (navigator.hardwareConcurrency) comuns em cada sistema. */
export const HARDWARE_CONCURRENCY_PRESETS: Record<DesktopOs, readonly number[]> = {
  windows: [4, 6, 8, 12, 16, 20, 24, 32],
  macos: [4, 8, 10, 12, 14, 16],
  linux: [4, 8, 12, 16, 20, 24, 32],
}

/** navigator.deviceMemory em GB: o Chrome arredonda para potência de 2 e limita a 8. */
export const DEVICE_MEMORY_PRESETS = [4, 8] as const

/** Tela do aparelho como os sites a veem: no celular, a área útil é a tela inteira. */
export function deviceScreen(device: MobileDevice): ScreenConfig {
  const { width, height, pixelRatio } = device.screen
  return { width, height, availWidth: width, availHeight: height, colorDepth: 24, pixelRatio }
}

/** Aparelho de um fingerprint de celular (o primeiro da lista se o gravado não existir mais). */
export function fingerprintDevice(config: Pick<FingerprintConfig, 'os' | 'device'>): MobileDevice | null {
  if (!isMobileOs(config.os)) return null
  return mobileDevice(config.device, config.os) ?? MOBILE_DEVICES[config.os][0] ?? null
}

/** Memória "4" (4 a 7 GB) só em máquinas modestas: com 12 núcleos lógicos ou mais, sempre 8. */
export function plausibleHardware(cores: number, memory: number): boolean {
  return memory >= 8 || cores <= 8
}

/** Mesma tela para o editor e o gerador: resolução e densidade (a área útil vem do preset). */
export function sameScreen(a: ScreenConfig, b: ScreenConfig): boolean {
  return a.width === b.width && a.height === b.height && a.pixelRatio === b.pixelRatio
}

/** Valor do seletor de resolução do editor: "1920x1080@1.25". */
export function screenKey(value: ScreenConfig): string {
  return `${value.width}x${value.height}@${value.pixelRatio}`
}

type HardwareFields = Pick<FingerprintConfig, 'os' | 'screen'> & {
  /** Ausente no formato v1 (lido como emulação). */
  mode?: FingerprintConfig['mode']
  device?: string | null
  navigator: Pick<FingerprintConfig['navigator'], 'hardwareConcurrency' | 'deviceMemory' | 'maxTouchPoints'>
}

/** Combinações de hardware emulado já atribuídas (chaves de `fingerprintKey`). */
export interface FingerprintUsage {
  /** Perfis existentes (inclusive na lixeira) por combinação. */
  inUse: Map<string, number>
  /** Toda combinação já gravada em algum perfil, inclusive nos que já foram excluídos. */
  used: Set<string>
}

/**
 * Combinação de hardware que a emulação mostra aos sites (sistema, tela, núcleos, memória e
 * toque). Dois perfis com a mesma chave aparecem com o mesmo hardware. Nativo = null: os
 * valores são os desta máquina, que o próprio Brave varia.
 */
export function fingerprintKey(config: HardwareFields): string | null {
  if (config.mode === 'native') return null
  const { screen: s, navigator: n } = config
  const parts = [
    config.os,
    `${s.width}x${s.height}`,
    `${s.availWidth}x${s.availHeight}`,
    s.colorDepth,
    s.pixelRatio,
    n.hardwareConcurrency,
    n.deviceMemory ?? 'brave',
    n.maxTouchPoints,
  ]
  // Celular: o aparelho separa modelos com a mesma tela e o mesmo hardware (iPhone 15 e 16).
  if (isMobileOs(config.os) && config.device) parts.push(config.device)
  return parts.join('|')
}

const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'] as const
const GREASE_VERSIONS = ['8', '99', '24'] as const
const BRAND_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const

/**
 * Lista de marcas das Client Hints no formato do Chromium (marca "GREASE" derivada da versão),
 * para quando a sondagem do navegador não as informou. Conferida no Brave 158 (`Chromium/158,
 * Not.A/Brand/24, Brave/158`), no Chrome 158 (`Chromium, Not.A/Brand, Google Chrome`) e no
 * Ungoogled Chromium 158 (`Not.A/Brand/24, Chromium/158`: sem marca própria, só duas).
 */
export function buildUaBrands(
  engineMajor: number,
  fullVersion?: string,
  brand: string | null = 'Brave',
): { brands: UaBrand[]; fullVersionList: UaBrand[] } {
  const major = String(engineMajor)
  const full = fullVersion ?? `${major}.0.0.0`
  const grease = {
    brand: `Not${GREASE_CHARS[engineMajor % 11]}A${GREASE_CHARS[(engineMajor + 1) % 11]}Brand`,
    version: GREASE_VERSIONS[engineMajor % 3] ?? '99',
  }
  const order = BRAND_ORDERS[engineMajor % 6] ?? BRAND_ORDERS[0]
  const slots: UaBrand[] = []
  if (brand) {
    slots[order[0]] = grease
    slots[order[1]] = { brand: 'Chromium', version: major }
    slots[order[2]] = { brand, version: major }
  } else {
    slots[engineMajor % 2] = grease
    slots[(engineMajor + 1) % 2] = { brand: 'Chromium', version: major }
  }
  const brands = slots.filter((b): b is UaBrand => Boolean(b))
  const fullVersionList = brands.map((b) =>
    b.brand === grease.brand
      ? { brand: b.brand, version: `${grease.version}.0.0.0` }
      : { brand: b.brand, version: full },
  )
  return { brands, fullVersionList }
}

export interface DefaultFingerprintOptions {
  mode?: 'native' | 'emulated'
  os: OsName
  engineMajor: number
  timezone: string
  languages?: string[]
  screen?: ScreenConfig
  hardwareConcurrency?: number
  /** Aparelho do Android/iOS (padrão: o primeiro da lista); ignorado nos computadores. */
  device?: string | null
  /** Marcas e sufixo do User-Agent do navegador sondado (`FingerprintCapabilities`). */
  browser?: Pick<FingerprintCapabilities, 'brands' | 'fullVersionList' | 'uaSuffix'>
}

/**
 * Fingerprint inicial coerente com o sistema escolhido. É o ponto de partida
 * de todo perfil novo; o gerador do processo principal (`generateFingerprint`)
 * varia tela e hardware na emulação e recalcula UA/CH pela versão instalada.
 */
export function createDefaultFingerprint(options: DefaultFingerprintOptions): FingerprintConfig {
  const { os } = options
  const preset = OS_PRESETS[os]
  const major = String(options.engineMajor)
  const device = isMobileOs(os) ? (mobileDevice(options.device, os) ?? MOBILE_DEVICES[os][0]!) : null
  const { brands, fullVersionList } =
    options.browser?.brands?.length && options.browser.fullVersionList?.length
      ? { brands: options.browser.brands, fullVersionList: options.browser.fullVersionList }
      : buildUaBrands(options.engineMajor)
  const baseScreen = device ? deviceScreen(device) : (options.screen ?? SCREEN_PRESETS[os as DesktopOs][0])
  if (!baseScreen) throw new Error(`Sem resolução padrão para ${os}`)
  return {
    version: 2,
    // Celular é sempre emulado: o Facet roda num computador.
    mode: device ? 'emulated' : (options.mode ?? 'native'),
    os,
    engineMajor: options.engineMajor,
    userAgent: preset.userAgent(major, options.browser?.uaSuffix ?? '', device),
    uaData: {
      brands: brands.map((brand) => ({ ...brand })),
      fullVersionList: fullVersionList.map((brand) => ({ ...brand })),
      platform: preset.uaPlatform,
      platformVersion: preset.platformVersion(device),
      architecture: preset.architecture,
      bitness: preset.bitness,
      model: device?.model ?? '',
      mobile: device !== null,
      wow64: false,
    },
    navigator: {
      platform: preset.navigatorPlatform,
      hardwareConcurrency: device?.cores ?? options.hardwareConcurrency ?? 8,
      deviceMemory: device ? device.memory : null,
      maxTouchPoints: device ? 5 : 0,
    },
    screen: { ...baseScreen },
    ...(device ? { device: device.id } : {}),
    languages: { mode: 'auto', list: options.languages ?? ['en-US', 'en'] },
    timezone: { mode: 'auto', id: options.timezone },
    geolocation: { mode: 'auto', latitude: null, longitude: null, accuracy: 100 },
    webrtc: { mode: 'proxy_only' },
    noise: { canvas: 'brave', webgl: 'brave', audio: 'brave' },
  }
}
