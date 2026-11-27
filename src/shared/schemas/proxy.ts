import { z } from 'zod'
import { LIMITS } from '../constants'
import type { AppErrorPayload } from '../ipc/result'
import { idSchema, idsInputSchema } from './common'

export const PROXY_TYPES = ['http', 'https', 'socks5'] as const
export const proxyTypeSchema = z.enum(PROXY_TYPES)
export type ProxyType = z.infer<typeof proxyTypeSchema>

export const PROXY_CHECK_STATUSES = ['unknown', 'online', 'offline'] as const
export type ProxyCheckStatus = (typeof PROXY_CHECK_STATUSES)[number]

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/i

export function isIPv4(value: string): boolean {
  return IPV4.test(value)
}

/** IPv6 sem colchetes. Usa o parser de URL (igual no Node e no Chromium). */
export function isIPv6(value: string): boolean {
  if (!value.includes(':') || /[[\]/@\s]/.test(value)) return false
  try {
    return new URL(`http://[${value}]/`).hostname.length > 2
  } catch {
    return false
  }
}

export function isValidProxyHost(value: string): boolean {
  if (isIPv4(value) || isIPv6(value)) return true
  // só dígitos e pontos que não formam um IPv4 válido (ex.: 999.1.1.1) não são hostname
  if (/^[\d.]+$/.test(value)) return false
  return HOSTNAME.test(value)
}

/** IPv6 vai entre colchetes em `host:porta` e em URLs. */
export function formatHost(host: string): string {
  return isIPv6(host) ? `[${host}]` : host
}

export function proxyEndpoint(proxy: Pick<ProxySummary, 'host' | 'port'>): string {
  return `${formatHost(proxy.host)}:${proxy.port}`
}

/** Nome do proxy na página de proxies (o IP de saída tem coluna própria): o apelido ou o endereço. */
export function proxyLabel(proxy: Pick<ProxySummary, 'name' | 'host' | 'port'>): string {
  return proxy.name?.trim() || proxyEndpoint(proxy)
}

/** Nome do proxy nos perfis e seletores: o apelido; sem ele, o IP de saída ou o endereço. */
export function proxyTitle(proxy: Pick<ProxySummary, 'name' | 'exitIp' | 'host' | 'port'>): string {
  return proxy.name?.trim() || proxy.exitIp || proxyEndpoint(proxy)
}

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Visão de um proxy que pode ir para a interface. Senha e URL de troca de IP
 * ficam cifradas no processo principal: o renderer só sabe se existem.
 */
export interface ProxySummary {
  id: string
  name: string | null
  type: ProxyType
  host: string
  port: number
  username: string
  hasPassword: boolean
  /** Proxy rotativo: tem URL de troca de IP (cifrada; aqui só o domínio, para exibir). */
  rotating: boolean
  changeIpHost: string | null
  notes: string
  checkStatus: ProxyCheckStatus
  checkedAt: number | null
  latencyMs: number | null
  exitIp: string | null
  countryCode: string | null
  countryName: string | null
  region: string | null
  city: string | null
  timezone: string | null
  latitude: number | null
  longitude: number | null
  lastError: string | null
  lastErrorCode: string | null
  createdAt: number
  updatedAt: number
}

const nameSchema = z.string().trim().max(LIMITS.proxyNameMax, 'tooLong')
const hostSchema = z
  .string()
  .trim()
  .min(1, 'required')
  .max(253, 'tooLong')
  .transform((value) => value.replace(/^\[(.*)\]$/, '$1'))
  .refine(isValidProxyHost, 'invalidHost')
const portSchema = z
  .number({ error: 'invalidNumber' })
  .int('invalidNumber')
  .min(1, 'outOfRange')
  .max(65535, 'outOfRange')
const usernameSchema = z.string().max(LIMITS.proxyCredentialMax, 'tooLong')
const passwordSchema = z.string().max(LIMITS.proxyCredentialMax, 'tooLong')
const changeIpUrlSchema = z
  .string()
  .trim()
  .max(LIMITS.proxyChangeUrlMax, 'tooLong')
  .refine((value) => value === '' || isHttpUrl(value), 'invalidUrl')

/** Senha e URL de troca vazias = não existem. */
export const proxyCreateSchema = z.object({
  name: nameSchema,
  type: proxyTypeSchema,
  host: hostSchema,
  port: portSchema,
  username: usernameSchema,
  password: passwordSchema,
  changeIpUrl: changeIpUrlSchema,
  notes: z.string().max(LIMITS.notesMax, 'tooLong'),
})
export type ProxyCreateInput = z.input<typeof proxyCreateSchema>
export type ProxyCreateData = z.output<typeof proxyCreateSchema>

/** Edição de segredo sem nunca mandar o valor atual para a interface. */
export const passwordChangeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep') }),
  z.object({ mode: z.literal('clear') }),
  z.object({ mode: z.literal('set'), value: passwordSchema.min(1, 'required') }),
])
export type PasswordChange = z.infer<typeof passwordChangeSchema>

export const changeIpUrlChangeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep') }),
  z.object({ mode: z.literal('clear') }),
  z.object({ mode: z.literal('set'), value: changeIpUrlSchema.refine((value) => value !== '', 'required') }),
])
export type ChangeIpUrlChange = z.infer<typeof changeIpUrlChangeSchema>

export const proxyUpdateSchema = z.object({
  id: idSchema,
  patch: z
    .object({
      name: nameSchema,
      type: proxyTypeSchema,
      host: hostSchema,
      port: portSchema,
      username: usernameSchema,
      notes: z.string().max(LIMITS.notesMax, 'tooLong'),
      password: passwordChangeSchema,
      changeIpUrl: changeIpUrlChangeSchema,
    })
    .partial(),
})
export type ProxyUpdateInput = z.input<typeof proxyUpdateSchema>
export type ProxyUpdateData = z.output<typeof proxyUpdateSchema>

export const proxyDeleteSchema = idsInputSchema.extend({ confirmInUse: z.boolean() })
export interface ProxyDeleteResult {
  count: number
  /** Perfis que estavam com algum dos proxies e ficaram com conexão direta. */
  detachedProfiles: number
}

export const proxyParseImportSchema = z.object({
  text: z.string().max(LIMITS.proxyImportMaxChars, 'tooLong'),
  defaultType: proxyTypeSchema,
})
export const proxyImportSchema = proxyParseImportSchema.extend({ checkAfter: z.boolean() })

export const PROXY_LINE_ERRORS = [
  'invalidFormat',
  'invalidHost',
  'invalidPort',
  'unsupportedType',
  'credentialTooLong',
  'passwordWithoutUser',
  'ambiguous',
  'duplicateInList',
  'alreadyExists',
] as const
export type ProxyLineError = (typeof PROXY_LINE_ERRORS)[number]

export interface ProxyImportLine {
  line: number
  /** Linha original com a senha mascarada. */
  display: string
  status: 'ok' | 'invalid' | 'duplicate'
  error: ProxyLineError | null
  type: ProxyType | null
  endpoint: string | null
  username: string
}

export interface ProxyImportPreview {
  lines: ProxyImportLine[]
  valid: number
  invalid: number
  duplicates: number
  /** Mais linhas que o limite: o excedente foi ignorado. */
  truncated: boolean
}

export interface ProxyImportResult {
  created: ProxySummary[]
  invalid: number
  duplicates: number
}

export interface ProxyGeo {
  countryCode: string | null
  countryName: string | null
  region: string | null
  city: string | null
  timezone: string | null
  latitude: number | null
  longitude: number | null
}

export interface ProxyCheckOutcome extends ProxyGeo {
  status: 'online' | 'offline'
  latencyMs: number | null
  exitIp: string | null
  error: AppErrorPayload | null
  checkedAt: number
}

export interface ProxyCheckResult {
  id: string
  outcome: ProxyCheckOutcome
}

export interface ProxyCheckProgress {
  running: boolean
  total: number
  done: number
  online: number
  offline: number
}

/** Testa um proxy ainda não salvo; com `id` e senha `keep`, usa a senha guardada. */
export const proxyTestDraftSchema = z.object({
  id: idSchema.nullable(),
  type: proxyTypeSchema,
  host: hostSchema,
  port: portSchema,
  username: usernameSchema,
  password: passwordChangeSchema,
})
export type ProxyTestDraftInput = z.input<typeof proxyTestDraftSchema>

export interface ProxyRotateResult {
  proxy: ProxySummary
  previousIp: string | null
  currentIp: string | null
  changed: boolean
  countryChanged: boolean
  fingerprintChanged: boolean
  /** Perfis abertos com este proxy: as conexões antigas foram encerradas. */
  runningProfileIds: string[]
}

/** Senha salva de um proxy, decifrada só para o formulário de edição (null = sem senha). */
export interface ProxyPassword {
  password: string | null
}
