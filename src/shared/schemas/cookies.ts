import { z } from 'zod'
import { LIMITS } from '../constants'
import { idSchema } from './common'

export const COOKIE_SAME_SITE = ['Strict', 'Lax', 'None'] as const
export type CookieSameSite = (typeof COOKIE_SAME_SITE)[number]

/** Partição CHIPS: o site de topo (`https://exemplo.com`) que isola o cookie. */
export const cookiePartitionKeySchema = z.object({
  topLevelSite: z.string().min(1).max(512),
  hasCrossSiteAncestor: z.boolean(),
})
export type CookiePartitionKey = z.infer<typeof cookiePartitionKeySchema>

/**
 * Modelo único de cookie do Facet (equivale ao `Cookie` do CDP). `domain` com ponto
 * inicial é cookie de domínio (vale para os subdomínios); sem ponto, só para o host
 * (verificado no Brave 158). `expires` em segundos Unix; `null` = cookie de sessão.
 */
export const cookieSchema = z.object({
  name: z.string().max(LIMITS.cookieMaxBytes),
  value: z.string().max(LIMITS.cookieMaxBytes),
  domain: z.string().min(1).max(255),
  path: z.string().min(1).max(LIMITS.cookiePathMax),
  expires: z.number().finite().nullable(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(COOKIE_SAME_SITE).nullable(),
  partitionKey: cookiePartitionKeySchema.nullable(),
})
export type BrowserCookie = z.infer<typeof cookieSchema>

export const COOKIE_FORMATS = ['json', 'netscape'] as const
export type CookieFormat = (typeof COOKIE_FORMATS)[number]

/** Formatos reconhecidos na importação. */
export type CookieSourceFormat = 'editThisCookie' | 'cdp' | 'playwright' | 'netscape'

export const COOKIE_REJECT_REASONS = [
  'invalidFormat',
  'invalidName',
  'invalidValue',
  'invalidDomain',
  'invalidPath',
  'tooLarge',
  'hostPrefix',
  'securePrefix',
  'sameSiteNoneInsecure',
  'partitionedInsecure',
  'invalidPartition',
] as const
export type CookieRejectReason = (typeof COOKIE_REJECT_REASONS)[number]

export interface CookieRejection {
  /** Posição no arquivo: item do JSON ou linha do Netscape (a partir de 1). */
  position: number
  reason: CookieRejectReason
  name: string | null
  domain: string | null
}

export type CookieParseError = 'empty' | 'tooLarge' | 'invalidJson' | 'unknownFormat' | 'tooMany'

export type CookieParseOutcome =
  | {
      ok: true
      format: CookieSourceFormat
      cookies: BrowserCookie[]
      rejected: CookieRejection[]
      /** Já vencidos: ignorados sem erro. */
      expired: number
      /** Mesmo nome, domínio, caminho e partição: vale o último. */
      duplicates: number
    }
  | { ok: false; error: CookieParseError }

export const cookieImportSchema = z.object({
  id: idSchema,
  cookies: z.array(cookieSchema).min(1, 'required').max(LIMITS.cookiesImportMax, 'tooMany'),
})
export type CookieImportInput = z.infer<typeof cookieImportSchema>

export const cookieExportSchema = z.object({
  id: idSchema,
  format: z.enum(COOKIE_FORMATS),
  target: z.enum(['file', 'clipboard']),
})
export type CookieExportInput = z.infer<typeof cookieExportSchema>

export interface CookieFailure {
  name: string
  domain: string
  /** Motivo da validação ou a mensagem do Brave ao recusar. */
  reason: string
}

export interface CookieImportResult {
  /** `now`: perfil aberto, gravado na hora. `pending`: vale na próxima abertura. */
  applied: 'now' | 'pending'
  imported: number
  failed: CookieFailure[]
  /** Total à espera da próxima abertura (pendentes acumulam até lá). */
  pending: number
}

export interface CookieExportResult {
  count: number
  /** Nome do arquivo salvo; null = cancelado ou cópia. */
  file: string | null
  /** Só para `clipboard`. */
  text: string | null
}

export interface CookieStatus {
  /** Cookies à espera da próxima abertura. */
  pending: number
  pendingAt: number | null
  running: boolean
}

/** Emitido quando os cookies pendentes são aplicados ao abrir o perfil. */
export interface CookiesAppliedEvent {
  profileId: string
  imported: number
  failed: number
  error: string | null
}
