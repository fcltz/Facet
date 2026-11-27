export const APP_NAME = 'Facet Browsers Antidetect'
/** Nome da pasta de dados original; permanece estável nas atualizações da marca. */
export const APP_DATA_DIRECTORY = 'Facet'
export const APP_USER_MODEL_ID = 'app.facet.desktop'

/** Etapa de desenvolvimento entregue nesta versão (usada na UI para indicar recursos futuros). */
export const CURRENT_STAGE = 6

/** Etapa em que cada recurso ainda não implementado passa a funcionar. */
export const FEATURE_STAGE = {
  braveLaunch: 2,
  profileFolder: 2,
  browserPath: 2,
  proxyManager: 3,
  geoIp: 3,
  extensions: 4,
  fingerprintGenerator: 5,
  cookies: 6,
  exportImport: 6,
  backup: 6,
} as const

export const DESKTOP_OS_LIST = ['windows', 'macos', 'linux'] as const
/** Celulares emulados: User-Agent, Client Hints, tela, toque e GPU de um aparelho real. */
export const MOBILE_OS_LIST = ['android', 'ios'] as const
export const OS_LIST = [...DESKTOP_OS_LIST, ...MOBILE_OS_LIST] as const

/**
 * Navegadores que abrem os perfis, na ordem da interface. O Ungoogled Chromium vem com o Facet
 * e é o padrão; os outros são os instalados nesta máquina.
 */
export const BROWSER_KINDS = ['ungoogled', 'chrome', 'brave', 'opera'] as const
export type BrowserKind = (typeof BROWSER_KINDS)[number]
export const DEFAULT_BROWSER: BrowserKind = 'ungoogled'
export const BROWSER_NAMES: Record<BrowserKind, string> = {
  ungoogled: 'Ungoogled Chromium',
  chrome: 'Google Chrome',
  brave: 'Brave',
  opera: 'Opera',
}

export const THEMES = ['light', 'dark', 'system'] as const
export const LANGUAGES = ['pt-BR', 'en', 'es'] as const

/** Provedores de geo-IP consultados através do proxy (`auto` = cadeia com fallback). */
export const GEOIP_PROVIDERS = ['auto', 'ipwhois', 'geojs', 'ipinfo', 'ipapi'] as const

/** Sem dependências: usado também pelo preload (que não pode carregar o Zod). */
export function isLanguage(value: unknown): value is (typeof LANGUAGES)[number] {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value)
}

/** Paleta de perfis, grupos e tags. A primeira cor é o destaque do app (#5B5BF7). */
export const COLOR_PALETTE = [
  '#5B5BF7',
  '#3B82F6',
  '#06B6D4',
  '#14B8A6',
  '#22C55E',
  '#84CC16',
  '#EAB308',
  '#F97316',
  '#EF4444',
  '#EC4899',
  '#A855F7',
  '#64748B',
] as const

export const DEFAULT_COLOR = COLOR_PALETTE[0]

export const LIMITS = {
  nameMax: 120,
  groupNameMax: 60,
  tagNameMax: 40,
  notesMax: 5000,
  tagsPerProfileMax: 20,
  startupUrlsMax: 20,
  extraArgsMax: 30,
  bulkCreateMax: 500,
  bulkPrefixMax: 60,
  idsPerCallMax: 10000,
  proxyNameMax: 80,
  proxyCredentialMax: 512,
  proxyChangeUrlMax: 2048,
  proxyImportMaxLines: 5000,
  proxyImportMaxChars: 1_000_000,
  extensionsPerProfileMax: 50,
  extensionIdsPerCallMax: 1000,
  /** .zip/.crx enviado ou baixado da Chrome Web Store. */
  extensionArchiveMaxBytes: 200 * 1024 * 1024,
  /** Soma dos arquivos descompactados (proteção contra zip bomb). */
  extensionUnpackedMaxBytes: 500 * 1024 * 1024,
  extensionMaxEntries: 20_000,
  /** Caminho absoluto de cada arquivo instalado (o Brave não abre caminhos longos do Windows). */
  extensionPathMax: 250,
  extensionConfigMaxBytes: 256 * 1024,
  extensionIconMaxBytes: 256 * 1024,
  extensionWebStoreInputMax: 2048,
  /** Texto colado ou arquivo de cookies (JSON ou Netscape). */
  cookiesImportMaxBytes: 20 * 1024 * 1024,
  cookiesImportMax: 50_000,
  /** Nome + valor de um cookie (limite do Chromium). */
  cookieMaxBytes: 4096,
  cookiePathMax: 1024,
  /** Perfis exportados num pacote. */
  transferProfilesMax: 500,
  /** Soma dos arquivos descompactados de um pacote ou backup. */
  transferMaxBytes: 50 * 1024 ** 3,
  transferMaxEntries: 1_000_000,
  /** Manifestos, profile.json e cookies.json lidos para a memória. */
  transferJsonMaxBytes: 32 * 1024 * 1024,
  transferPasswordMin: 8,
  transferPasswordMax: 256,
  backupKeepMax: 100,
  /** Caminho da pasta dos perfis (o Brave não abre caminhos longos do Windows). */
  profilesRootMax: 150,
} as const

/**
 * Versão principal do Chromium usada só enquanto o executável ainda não foi
 * sondado (rascunho de perfil novo). A versão real vem de Browser.getVersion e
 * substitui esta na geração e em cada abertura.
 */
export const PREVIEW_ENGINE_MAJOR = 158

/**
 * Flags controladas pelo próprio app. O campo "flags extras" do perfil não pode
 * sobrescrevê-las, senão o isolamento (pasta, proxy, CDP, fingerprint) quebra.
 */
export const RESERVED_ARG_PREFIXES = [
  '--user-data-dir',
  '--profile-directory',
  '--remote-debugging-',
  '--proxy-',
  '--no-proxy-server',
  '--load-extension',
  '--disable-extensions-except',
  '--enable-unsafe-extension-debugging',
  '--disable-blink-features',
  '--headless',
  '--user-agent',
  '--lang',
  '--restore-last-session',
  '--no-startup-window',
  '--app',
  '--incognito',
  '--guest',
  '--no-sandbox',
  '--disable-web-security',
  '--profile',
] as const
