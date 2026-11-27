import { z } from 'zod'
import { BROWSER_KINDS, DEFAULT_BROWSER, GEOIP_PROVIDERS, LANGUAGES, THEMES } from '../constants'
import { backupConfigSchema, backupStateSchema, DEFAULT_BACKUP_CONFIG, DEFAULT_BACKUP_STATE } from './backup'
import { jobIdSchema } from './jobs'
import { browserKindSchema } from './common'
import { isHttpUrl } from './proxy'
import { DEFAULT_PROFILE_TABLE, profileTableSchema } from './profile-table'

export { GEOIP_PROVIDERS, isLanguage, LANGUAGES, THEMES } from '../constants'

export type Theme = (typeof THEMES)[number]
export type Language = (typeof LANGUAGES)[number]
export type GeoIpProvider = (typeof GEOIP_PROVIDERS)[number]

export const appSettingsSchema = z.object({
  theme: z.enum(THEMES),
  language: z.enum(LANGUAGES),
  sidebarCollapsed: z.boolean(),
  profileTable: profileTableSchema,
  /** Navegador dos perfis novos (na criação, cada perfil pode escolher outro). */
  defaultBrowser: browserKindSchema,
  /**
   * Executável escolhido para cada navegador; vazio = o que o Facet encontra sozinho (o Ungoogled
   * Chromium que vem com ele; os outros, pela instalação no sistema).
   */
  browserPaths: z.object(
    Object.fromEntries(BROWSER_KINDS.map((kind) => [kind, z.string().max(4096)])) as Record<
      (typeof BROWSER_KINDS)[number],
      z.ZodString
    >,
  ),
  geoIpProvider: z.enum(GEOIP_PROVIDERS),
  /**
   * Fecha, ao abrir um perfil, as abas que as extensões abrem sozinhas (o Brave as trata
   * como recém-instaladas a cada abertura). Nunca na 1ª abertura com uma extensão nova.
   */
  closeExtensionStartupTabs: z.boolean(),
  /**
   * Página aberta quando o perfil não tem páginas iniciais próprias nem abas a restaurar;
   * vazio = página em branco. Só http/https.
   */
  startPage: z
    .string()
    .trim()
    .max(2048, 'tooLong')
    .refine((value) => value === '' || isHttpUrl(value), 'invalidUrl'),
  /** Pasta raiz dos perfis; vazio = `<dados do app>/profiles`. Muda só pela mudança de pasta. */
  profilesRoot: z.string().max(4096),
  /**
   * Identificação dos perfis abertos: no navegador, grupo de abas "01 · Nome" e ícone "01"
   * fixado; no Windows, botão próprio na barra de tarefas com o número. Vale na próxima abertura.
   */
  profileIdentity: z.object({ inBrowser: z.boolean(), taskbar: z.boolean() }),
  backup: backupConfigSchema,
  /** Resultado do último backup, gravado pelo processo principal. */
  backupState: backupStateSchema,
  /**
   * Boas-vindas concluídas (idioma, tema e navegador padrão). Falso só na primeira abertura de
   * uma instalação nova; quem já usava o Facet antes da tela de boas-vindas não passa por ela.
   */
  onboardingCompleted: z.boolean(),
})
export type AppSettings = z.infer<typeof appSettingsSchema>

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  language: 'pt-BR',
  sidebarCollapsed: false,
  profileTable: DEFAULT_PROFILE_TABLE,
  defaultBrowser: DEFAULT_BROWSER,
  browserPaths: { ungoogled: '', chrome: '', brave: '', opera: '' },
  geoIpProvider: 'auto',
  closeExtensionStartupTabs: true,
  startPage: 'https://browserscan.net/',
  profilesRoot: '',
  profileIdentity: { inBrowser: true, taskbar: true },
  backup: DEFAULT_BACKUP_CONFIG,
  backupState: DEFAULT_BACKUP_STATE,
  onboardingCompleted: false,
}

/**
 * Idioma da interface mais próximo das preferências do sistema, na ordem delas ("es-MX" → es,
 * "pt-PT" → pt-BR); null quando nenhuma é um idioma do Facet.
 */
export function interfaceLanguageFor(locales: readonly string[]): Language | null {
  for (const locale of locales) {
    const base = locale.trim().toLowerCase().split(/[-_]/)[0]
    if (base === 'pt') return 'pt-BR'
    if (base === 'es') return 'es'
    if (base === 'en') return 'en'
  }
  return null
}

/** A pasta dos perfis e o estado do backup não são editáveis pelo renderer. */
export const settingsPatchSchema = appSettingsSchema.omit({ profilesRoot: true, backupState: true }).partial()
export type SettingsPatch = z.infer<typeof settingsPatchSchema>

export const profilesRootPickSchema = z.object({ target: z.enum(['choose', 'default']) })

export const PROFILES_ROOT_PROBLEMS = [
  'same',
  'notEmpty',
  'insideData',
  'link',
  'tooLong',
  'notWritable',
  'noSpace',
  'running',
] as const
export type ProfilesRootProblem = (typeof PROFILES_ROOT_PROBLEMS)[number]

/** Pasta escolhida, já conferida: a mudança usa o `token`, nunca um caminho vindo do renderer. */
export interface ProfilesRootCandidate {
  token: string
  path: string
  isDefault: boolean
  profiles: number
  bytes: number
  /** null = o sistema não informou o espaço livre. */
  freeBytes: number | null
  sameVolume: boolean
  problem: ProfilesRootProblem | null
}

export const profilesRootMoveSchema = z.object({ jobId: jobIdSchema, token: z.uuid('invalidId') })

export interface ProfilesRootMoveResult {
  root: string
  moved: number
}

/** O token fica cifrado no processo principal; a interface só sabe se existe. */
export const geoIpTokenSchema = z.object({ token: z.string().trim().max(200, 'tooLong').nullable() })
export interface GeoIpTokenStatus {
  configured: boolean
}

export interface AppInfo {
  name: string
  version: string
  stage: number
  platform: string
  arch: string
  versions: { electron: string; chrome: string; node: string; v8: string }
  userDataDir: string
  isPackaged: boolean
  hostTimezone: string
  previewEngineMajor: number
}
