import { z } from 'zod'
import { LIMITS } from '../constants'
import { idSchema } from './common'

/** ID de extensão do Chrome: 32 letras de "a" a "p" (derivado da chave pública). */
const EXTENSION_ID = /^[a-p]{32}$/

export function isExtensionId(value: string): boolean {
  return EXTENSION_ID.test(value)
}

export const extensionIdSchema = z.string().regex(EXTENSION_ID, 'invalidExtensionId')

export const EXTENSION_SOURCES = ['webstore', 'crx', 'zip', 'folder', 'builtin'] as const
export type ExtensionSource = (typeof EXTENSION_SOURCES)[number]

/** `archive` = arquivo .zip ou .crx; `folder` = pasta descompactada. */
export const EXTENSION_FILE_KINDS = ['archive', 'folder'] as const
export type ExtensionFileKind = (typeof EXTENSION_FILE_KINDS)[number]

export const EXTENSION_STORAGE_AREAS = ['local', 'sync'] as const
export type ExtensionStorageArea = (typeof EXTENSION_STORAGE_AREAS)[number]

/**
 * O Brave trata extensões carregadas por --load-extension como recém-instaladas a
 * cada abertura. `once` aplica a configuração só na primeira abertura de cada perfil;
 * `always` reaplica sempre (para extensões que voltam aos padrões ao serem carregadas).
 */
export const EXTENSION_CONFIG_MODES = ['once', 'always'] as const
export type ExtensionConfigMode = (typeof EXTENSION_CONFIG_MODES)[number]
/** Autoconfiguração nova: em toda abertura, porque muitas extensões voltam aos padrões ao serem carregadas. */
export const DEFAULT_EXTENSION_CONFIG_MODE: ExtensionConfigMode = 'always'

const WEBSTORE_HOSTS = new Set(['chromewebstore.google.com', 'chrome.google.com'])

/**
 * Aceita o ID ou a URL da página da extensão na Chrome Web Store
 * (chromewebstore.google.com/detail/<nome>/<id> ou chrome.google.com/webstore/detail/…).
 */
export function parseWebStoreInput(input: string): string | null {
  const value = input.trim()
  if (EXTENSION_ID.test(value.toLowerCase())) return value.toLowerCase()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !WEBSTORE_HOSTS.has(host)) return null
  if (host === 'chrome.google.com' && !url.pathname.startsWith('/webstore/')) return null
  return url.pathname.split('/').find((part) => EXTENSION_ID.test(part)) ?? null
}

export const EXTENSION_WARNINGS = [
  'proxy',
  'privacy',
  'allSites',
  'debugger',
  'nativeMessaging',
  'cookies',
  'management',
] as const
export type ExtensionWarning = (typeof EXTENSION_WARNINGS)[number]

/**
 * Permissões que desfazem garantias do Facet: `proxy` pode trocar o proxy do perfil
 * (preferência de extensão vence o --proxy-server) e `privacy` pode afrouxar a
 * política de WebRTC que impede o vazamento do IP real.
 */
export const CRITICAL_EXTENSION_WARNINGS: readonly ExtensionWarning[] = ['proxy', 'privacy']

const ALL_SITES = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*'])
const NAMED_WARNINGS = ['debugger', 'nativeMessaging', 'cookies', 'management'] as const

export function extensionWarnings(permissions: readonly string[]): ExtensionWarning[] {
  const set = new Set(permissions)
  const warnings: ExtensionWarning[] = []
  if (set.has('proxy')) warnings.push('proxy')
  if (set.has('privacy')) warnings.push('privacy')
  if (permissions.some((permission) => ALL_SITES.has(permission))) warnings.push('allSites')
  for (const name of NAMED_WARNINGS) if (set.has(name)) warnings.push(name)
  return warnings
}

/**
 * Avisos de uma extensão da biblioteca. A Facet, que vem com o app, não gera avisos: ela pede
 * "privacy" só para desligar o pré-carregamento de páginas (não mexe na política de WebRTC).
 */
export function permissionWarnings(extension: {
  permissions: readonly string[]
  source: string
}): ExtensionWarning[] {
  return extension.source === 'builtin' ? [] : extensionWarnings(extension.permissions)
}

export function hasCriticalWarning(extension: { permissions: readonly string[]; source: string }): boolean {
  return permissionWarnings(extension).some((warning) => CRITICAL_EXTENSION_WARNINGS.includes(warning))
}

/** Cotas do chrome.storage.sync (iguais às do Chrome). */
const SYNC_QUOTA_BYTES = 102_400
const SYNC_QUOTA_BYTES_PER_ITEM = 8_192
const SYNC_MAX_ITEMS = 512

const encoder = new TextEncoder()

function fitsSyncQuota(values: Record<string, unknown>): boolean {
  const entries = Object.entries(values)
  if (entries.length > SYNC_MAX_ITEMS) return false
  let total = 0
  for (const [key, value] of entries) {
    const size = encoder.encode(key).length + encoder.encode(JSON.stringify(value) ?? '').length
    if (size > SYNC_QUOTA_BYTES_PER_ITEM) return false
    total += size
  }
  return total <= SYNC_QUOTA_BYTES
}

export type ExtensionConfigJsonError = 'invalidJson' | 'jsonNotObject' | 'jsonEmpty' | 'syncQuota'

/** O JSON de autoconfiguração é um objeto: cada chave de primeiro nível vira um item do chrome.storage. */
export function parseExtensionConfig(
  text: string,
  area: ExtensionStorageArea,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: ExtensionConfigJsonError } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'invalidJson' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'jsonNotObject' }
  }
  const values = parsed as Record<string, unknown>
  if (Object.keys(values).length === 0) return { ok: false, error: 'jsonEmpty' }
  if (area === 'sync' && !fitsSyncQuota(values)) return { ok: false, error: 'syncQuota' }
  return { ok: true, values }
}

export interface ExtensionConfigInfo {
  area: ExtensionStorageArea
  mode: ExtensionConfigMode
  /** Aumenta a cada alteração; cada perfil guarda a revisão que já recebeu. */
  revision: number
  /** Chaves de primeiro nível (o conteúdo fica cifrado no processo principal). */
  keys: number
  updatedAt: number
}

/** Extensão da biblioteca do Facet, como a interface vê. */
export interface ExtensionSummary {
  id: string
  name: string
  version: string
  description: string
  manifestVersion: number
  source: ExtensionSource
  /** Ícone como data URL (PNG, JPEG ou WebP) ou null. */
  icon: string | null
  /** Permissões e acessos a sites declarados no manifest. */
  permissions: string[]
  /** Tem a permissão "storage": só assim a autoconfiguração faz sentido. */
  hasStorage: boolean
  /** Instalada automaticamente em todo perfil novo. */
  isDefault: boolean
  applyMode: ExtensionConfigMode
  config: ExtensionConfigInfo | null
  /** Perfis (inclusive na lixeira) que usam a extensão. */
  profileCount: number
  sizeBytes: number
  createdAt: number
  updatedAt: number
}

export const extensionFileKindSchema = z.enum(EXTENSION_FILE_KINDS)
export const extensionImportFileSchema = z.object({ kind: extensionFileKindSchema })

export const extensionImportWebStoreSchema = z.object({
  input: z
    .string()
    .trim()
    .min(1, 'required')
    .max(LIMITS.extensionWebStoreInputMax, 'tooLong')
    .refine((value) => parseWebStoreInput(value) !== null, 'invalidWebStoreInput'),
})

export const extensionIdInputSchema = z.object({ id: extensionIdSchema })
export const extensionReplaceSchema = z.object({ id: extensionIdSchema, kind: extensionFileKindSchema })

export type ExtensionImportStatus = 'added' | 'updated' | 'reinstalled'

export interface ExtensionImportResult {
  extension: ExtensionSummary
  /** `updated` = outra versão; `reinstalled` = mesma versão com os arquivos trocados. */
  status: ExtensionImportStatus
  previousVersion: string | null
}

const extensionIdsSchema = z
  .array(extensionIdSchema)
  .min(1, 'required')
  .max(LIMITS.extensionIdsPerCallMax, 'tooMany')

export const extensionSetDefaultSchema = z.object({ ids: extensionIdsSchema, isDefault: z.boolean() })
export const extensionPreferencesSchema = z.object({
  id: extensionIdSchema,
  mode: z.enum(EXTENSION_CONFIG_MODES),
  isDefault: z.boolean(),
})

/** Liga ou desliga uma extensão em vários perfis (ou em todos os perfis ativos). */
export const extensionAssignSchema = z.object({
  extensionId: extensionIdSchema,
  profileIds: z.union([
    z.literal('allActive'),
    z.array(idSchema).min(1, 'required').max(LIMITS.idsPerCallMax, 'tooMany'),
  ]),
  enabled: z.boolean(),
})
export type ExtensionAssignInput = z.input<typeof extensionAssignSchema>

export interface ExtensionAssignResult {
  /** Perfis em que a lista de extensões mudou. */
  changed: number
  /** Perfis alterados que estão abertos: valem depois de reiniciar. */
  runningIds: string[]
}

export const extensionDeleteSchema = z.object({ ids: extensionIdsSchema, confirmInUse: z.boolean() })
export interface ExtensionDeleteResult {
  count: number
  /** Perfis que usavam alguma das extensões removidas. */
  detachedProfiles: number
}

export const extensionConfigInputSchema = z
  .object({
    area: z.enum(EXTENSION_STORAGE_AREAS),
    mode: z.enum(EXTENSION_CONFIG_MODES),
    json: z.string().max(LIMITS.extensionConfigMaxBytes, 'tooLong'),
  })
  .superRefine((value, ctx) => {
    const parsed = parseExtensionConfig(value.json, value.area)
    if (!parsed.ok) ctx.addIssue({ code: 'custom', path: ['json'], message: parsed.error })
  })
export type ExtensionConfigInput = z.input<typeof extensionConfigInputSchema>

/** `config: null` remove a autoconfiguração; `reapply` faz os perfis que já a receberam recebê-la de novo. */
export const extensionSetConfigSchema = z.object({
  id: extensionIdSchema,
  config: extensionConfigInputSchema.nullable(),
  reapply: z.boolean(),
})

export interface ExtensionConfigData {
  area: ExtensionStorageArea
  mode: ExtensionConfigMode
  /** JSON formatado, como foi salvo. */
  json: string
  revision: number
  updatedAt: number
}

export const extensionCaptureSchema = z.object({
  id: extensionIdSchema,
  profileId: idSchema,
  area: z.enum(EXTENSION_STORAGE_AREAS),
})
export interface ExtensionCaptureResult {
  json: string
  keys: number
}

export const extensionProfileStateSchema = z.object({ profileId: idSchema })

/** Situação de uma extensão dentro de um perfil. */
export interface ProfileExtensionState {
  extensionId: string
  addedAt: number
  /** Primeira abertura em que o Brave carregou a extensão neste perfil. */
  firstLoadedAt: number | null
  /** Revisão da autoconfiguração já aplicada; null = nunca aplicada. */
  configRevision: number | null
  configAppliedAt: number | null
  configError: string | null
}

export const extensionReapplySchema = z.object({
  profileId: idSchema,
  extensionIds: z.array(extensionIdSchema).min(1, 'required').max(LIMITS.extensionsPerProfileMax, 'tooMany'),
})
