import { LIMITS } from '../constants'
import type {
  BrowserCookie,
  CookieFormat,
  CookieParseOutcome,
  CookiePartitionKey,
  CookieRejection,
  CookieRejectReason,
  CookieSameSite,
  CookieSourceFormat,
} from '../schemas/cookies'

/**
 * Leitura, validação e escrita de cookies, sem dependências do Node (também roda no
 * renderer para a prévia). Formatos aceitos: EditThisCookie/Cookie-Editor (JSON),
 * CDP/Puppeteer (JSON), Playwright `storageState` e Netscape `cookies.txt`.
 */

type Draft = BrowserCookie
type Parsed = { position: number; draft: Draft } | { position: number; reason: CookieRejectReason }

const encoder = new TextEncoder()

function hasControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function isIPv4(host: string): boolean {
  const parts = host.split('.')
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/

function validHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (isIPv4(host)) return true
  if (host.startsWith('[') && host.endsWith(']')) return /^\[[0-9a-f:.]+\]$/.test(host)
  return host.split('.').every((label) => label.length > 0 && label.length <= 63 && LABEL.test(label))
}

function isIp(host: string): boolean {
  return isIPv4(host) || host.startsWith('[')
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function sameSiteFrom(value: unknown): CookieSameSite | null {
  if (typeof value !== 'string') return null
  switch (value.trim().toLowerCase()) {
    case 'strict':
      return 'Strict'
    case 'lax':
      return 'Lax'
    case 'none':
    case 'no_restriction':
      return 'None'
    default:
      return null
  }
}

/** Segundos Unix; zero, negativo ou ausente = cookie de sessão. */
function expiresFrom(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : null
}

/** Objeto do CDP atual ou texto (site de topo) dos formatos antigos do Puppeteer. */
function partitionFrom(value: unknown): CookiePartitionKey | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string') return { topLevelSite: value, hasCrossSiteAncestor: true }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.topLevelSite !== 'string') return 'invalid'
    return {
      topLevelSite: record.topLevelSite,
      hasCrossSiteAncestor:
        typeof record.hasCrossSiteAncestor === 'boolean' ? record.hasCrossSiteAncestor : true,
    }
  }
  return 'invalid'
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase()
}

/** Item de um JSON: EditThisCookie usa `hostOnly`/`expirationDate`; CDP e Playwright, `expires`. */
function fromJsonItem(item: unknown, kind: 'editThisCookie' | 'cdp', position: number): Parsed {
  if (typeof item !== 'object' || item === null || Array.isArray(item))
    return { position, reason: 'invalidFormat' }
  const record = item as Record<string, unknown>
  const name = text(record.name)
  const value = text(record.value) ?? ''
  const rawDomain = typeof record.domain === 'string' ? normalizeDomain(record.domain) : ''
  if (name === null || !rawDomain) return { position, reason: 'invalidFormat' }
  let domain = rawDomain
  let expires: number | null
  if (kind === 'editThisCookie') {
    if (record.hostOnly === true) domain = domain.replace(/^\.+/, '')
    else if (record.hostOnly === false && !domain.startsWith('.')) domain = `.${domain}`
    expires = record.session === true ? null : expiresFrom(record.expirationDate)
  } else {
    expires = record.session === true ? null : expiresFrom(record.expires)
  }
  const partitionKey = partitionFrom(record.partitionKey)
  if (partitionKey === 'invalid') return { position, reason: 'invalidPartition' }
  return {
    position,
    draft: {
      name,
      value,
      domain,
      path: typeof record.path === 'string' && record.path ? record.path : '/',
      expires,
      httpOnly: record.httpOnly === true,
      secure: record.secure === true,
      sameSite: sameSiteFrom(record.sameSite),
      partitionKey,
    },
  }
}

/** Netscape: domínio, subdomínios, caminho, seguro, validade, nome e valor, separados por tab. */
function fromNetscape(source: string): Parsed[] {
  const parsed: Parsed[] = []
  source.split(/\r?\n/).forEach((raw, index) => {
    const position = index + 1
    let line = raw
    if (!line.trim()) return
    let httpOnly = false
    if (line.startsWith('#HttpOnly_')) {
      httpOnly = true
      line = line.slice('#HttpOnly_'.length)
    } else if (line.trimStart().startsWith('#')) {
      return
    }
    const fields = line.split('\t')
    if (fields.length < 7) {
      parsed.push({ position, reason: 'invalidFormat' })
      return
    }
    const [rawDomain = '', subdomains = '', path = '', secure = '', expiry = '', name = '', ...rest] = fields
    let domain = normalizeDomain(rawDomain)
    if (subdomains.trim().toUpperCase() === 'TRUE') {
      if (!domain.startsWith('.')) domain = `.${domain}`
    } else {
      domain = domain.replace(/^\.+/, '')
    }
    parsed.push({
      position,
      draft: {
        name,
        value: rest.join('\t'),
        domain,
        path: path || '/',
        expires: expiresFrom(expiry),
        httpOnly,
        secure: secure.trim().toUpperCase() === 'TRUE',
        sameSite: null,
        partitionKey: null,
      },
    })
  })
  return parsed
}

/** Mesmas regras do Chromium para recusar um cookie (validade é tratada à parte). */
export function validateCookie(cookie: BrowserCookie): CookieRejectReason | null {
  const { name, value, domain, path } = cookie
  if (hasControl(name) || name.includes(';') || name.includes('=') || (!name && !value)) return 'invalidName'
  if (hasControl(value) || value.includes(';')) return 'invalidValue'
  if (encoder.encode(name + value).length > LIMITS.cookieMaxBytes) return 'tooLarge'
  const host = domain.startsWith('.') ? domain.slice(1) : domain
  if (!validHost(host) || (domain.startsWith('.') && isIp(host))) return 'invalidDomain'
  if (!path.startsWith('/') || hasControl(path) || path.includes(';') || path.length > LIMITS.cookiePathMax)
    return 'invalidPath'
  const lower = name.toLowerCase()
  if (lower.startsWith('__secure-') && !cookie.secure) return 'securePrefix'
  if (lower.startsWith('__host-') && (!cookie.secure || domain.startsWith('.') || path !== '/'))
    return 'hostPrefix'
  if (cookie.sameSite === 'None' && !cookie.secure) return 'sameSiteNoneInsecure'
  if (cookie.partitionKey) {
    if (!/^https?:\/\/[^/\s]+$/i.test(cookie.partitionKey.topLevelSite)) return 'invalidPartition'
    if (!cookie.secure) return 'partitionedInsecure'
  }
  return null
}

export function isExpired(cookie: BrowserCookie, nowMs = Date.now()): boolean {
  return cookie.expires !== null && cookie.expires * 1000 <= nowMs
}

/** Identidade de um cookie no navegador: gravar o mesmo nome, domínio, caminho e partição substitui. */
export function cookieKey(cookie: BrowserCookie): string {
  return [cookie.name, cookie.domain, cookie.path, cookie.partitionKey?.topLevelSite ?? ''].join('\u0000')
}

/** `extra` substitui os cookies de mesma identidade em `base`. */
export function mergeCookies(
  base: readonly BrowserCookie[],
  extra: readonly BrowserCookie[],
): BrowserCookie[] {
  const merged = new Map<string, BrowserCookie>()
  for (const cookie of [...base, ...extra]) merged.set(cookieKey(cookie), cookie)
  return [...merged.values()]
}

function detect(
  source: string,
): { format: CookieSourceFormat; parsed: Parsed[] } | { error: 'invalidJson' | 'unknownFormat' } {
  if (source.startsWith('[') || source.startsWith('{')) {
    let data: unknown
    try {
      data = JSON.parse(source)
    } catch {
      return { error: 'invalidJson' }
    }
    if (Array.isArray(data)) {
      const editThisCookie = data.some(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          ('expirationDate' in item || 'hostOnly' in item || 'storeId' in item),
      )
      const kind = editThisCookie ? 'editThisCookie' : 'cdp'
      return { format: kind, parsed: data.map((item, index) => fromJsonItem(item, kind, index + 1)) }
    }
    if (typeof data === 'object' && data !== null && Array.isArray((data as { cookies?: unknown }).cookies)) {
      const record = data as { cookies: unknown[]; origins?: unknown }
      return {
        format: 'origins' in record ? 'playwright' : 'cdp',
        parsed: record.cookies.map((item, index) => fromJsonItem(item, 'cdp', index + 1)),
      }
    }
    return { error: 'unknownFormat' }
  }
  const parsed = fromNetscape(source)
  if (!parsed.some((entry) => 'draft' in entry)) return { error: 'unknownFormat' }
  return { format: 'netscape', parsed }
}

/** Lê o texto colado ou o arquivo e separa válidos, recusados (com motivo) e vencidos. */
export function parseCookies(source: string, nowMs = Date.now()): CookieParseOutcome {
  if (source.length > LIMITS.cookiesImportMaxBytes) return { ok: false, error: 'tooLarge' }
  const trimmed = source.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return { ok: false, error: 'empty' }
  const detected = detect(trimmed)
  if ('error' in detected) return { ok: false, error: detected.error }
  if (detected.parsed.length > LIMITS.cookiesImportMax) return { ok: false, error: 'tooMany' }
  const rejected: CookieRejection[] = []
  const valid = new Map<string, BrowserCookie>()
  let expired = 0
  let duplicates = 0
  for (const entry of detected.parsed) {
    if ('reason' in entry) {
      rejected.push({ position: entry.position, reason: entry.reason, name: null, domain: null })
      continue
    }
    const reason = validateCookie(entry.draft)
    if (reason) {
      rejected.push({ position: entry.position, reason, name: entry.draft.name, domain: entry.draft.domain })
      continue
    }
    if (isExpired(entry.draft, nowMs)) {
      expired++
      continue
    }
    const key = cookieKey(entry.draft)
    if (valid.has(key)) duplicates++
    valid.set(key, entry.draft)
  }
  return { ok: true, format: detected.format, cookies: [...valid.values()], rejected, expired, duplicates }
}

function sorted(cookies: readonly BrowserCookie[]): BrowserCookie[] {
  const host = (cookie: BrowserCookie): string => cookie.domain.replace(/^\./, '')
  return [...cookies].sort(
    (a, b) => host(a).localeCompare(host(b)) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path),
  )
}

const SAME_SITE_OUT: Record<CookieSameSite, string> = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' }

/**
 * `json`: formato do EditThisCookie/Cookie-Editor (aceito pela maioria das ferramentas),
 * com `partitionKey` quando houver. `netscape`: `cookies.txt`, sem SameSite nem partição.
 */
export function serializeCookies(cookies: readonly BrowserCookie[], format: CookieFormat): string {
  const list = sorted(cookies)
  if (format === 'json') {
    return JSON.stringify(
      list.map((cookie, index) => ({
        domain: cookie.domain,
        ...(cookie.expires === null ? {} : { expirationDate: cookie.expires }),
        hostOnly: !cookie.domain.startsWith('.'),
        httpOnly: cookie.httpOnly,
        name: cookie.name,
        path: cookie.path,
        sameSite: cookie.sameSite ? SAME_SITE_OUT[cookie.sameSite] : 'unspecified',
        secure: cookie.secure,
        session: cookie.expires === null,
        storeId: '0',
        value: cookie.value,
        id: index + 1,
        ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
      })),
      null,
      2,
    )
  }
  const lines = list.map((cookie) =>
    [
      `${cookie.httpOnly ? '#HttpOnly_' : ''}${cookie.domain}`,
      cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE',
      cookie.path,
      cookie.secure ? 'TRUE' : 'FALSE',
      cookie.expires === null ? '0' : String(Math.floor(cookie.expires)),
      cookie.name,
      cookie.value,
    ].join('\t'),
  )
  return [
    '# Netscape HTTP Cookie File',
    '# Exportado pelo Facet (sem SameSite e sem partição CHIPS).',
    '',
    ...lines,
    '',
  ].join('\n')
}
