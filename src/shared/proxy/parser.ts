import { LIMITS } from '@shared/constants'
import {
  formatHost,
  isIPv4,
  isIPv6,
  isValidProxyHost,
  type ProxyLineError,
  type ProxyType,
} from '@shared/schemas/proxy'

export interface ParsedProxy {
  type: ProxyType
  host: string
  port: number
  username: string
  password: string
}

export type LineParse = { ok: true; proxy: ParsedProxy } | { ok: false; error: ProxyLineError }

export interface ParsedImportLine {
  line: number
  display: string
  result: LineParse
  /** Já existe outra linha igual (tipo + host + porta + usuário) mais acima na lista. */
  duplicateInList: boolean
}

const SCHEMES: Record<string, ProxyType | null> = {
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5',
  socks4: null,
  socks4a: null,
}

type HostPort = { ok: true; host: string; port: number } | { ok: false; error: ProxyLineError }

function strongHost(host: string): boolean {
  return isIPv4(host) || isIPv6(host) || host.includes('.')
}

function parsePort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null
  const port = Number(raw)
  return port >= 1 && port <= 65535 ? port : null
}

function parseHostPort(raw: string): HostPort {
  let host: string
  let portRaw: string
  const v6 = /^\[([^\]]+)\]:([^:]*)$/.exec(raw)
  if (v6) {
    host = v6[1] ?? ''
    portRaw = v6[2] ?? ''
  } else {
    const index = raw.lastIndexOf(':')
    if (index <= 0) return { ok: false, error: 'invalidFormat' }
    host = raw.slice(0, index)
    portRaw = raw.slice(index + 1)
    if (host.includes(':')) return { ok: false, error: 'invalidFormat' }
  }
  host = host.toLowerCase()
  if (!isValidProxyHost(host)) return { ok: false, error: 'invalidHost' }
  const port = parsePort(portRaw)
  if (port === null) return { ok: false, error: 'invalidPort' }
  return { ok: true, host, port }
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function withCredentials(type: ProxyType, hostPort: HostPort, username: string, password: string): LineParse {
  if (!hostPort.ok) return hostPort
  if (username.length > LIMITS.proxyCredentialMax || password.length > LIMITS.proxyCredentialMax) {
    return { ok: false, error: 'credentialTooLong' }
  }
  if (password && !username) return { ok: false, error: 'passwordWithoutUser' }
  return { ok: true, proxy: { type, host: hostPort.host, port: hostPort.port, username, password } }
}

function splitUserInfo(userInfo: string): { username: string; password: string } {
  const index = userInfo.indexOf(':')
  return index === -1
    ? { username: userInfo, password: '' }
    : { username: userInfo.slice(0, index), password: userInfo.slice(index + 1) }
}

/** `esquema://[usuário:senha@]host:porta` (credenciais podem vir com %XX). */
function parseUrlForm(line: string): LineParse {
  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(line)
  if (!match) return { ok: false, error: 'invalidFormat' }
  const scheme = (match[1] ?? '').toLowerCase()
  if (!(scheme in SCHEMES)) return { ok: false, error: 'unsupportedType' }
  const type = SCHEMES[scheme]
  if (!type) return { ok: false, error: 'unsupportedType' }
  const rest = (match[2] ?? '').replace(/\/+$/, '')
  if (rest.includes('/') || rest.includes('?') || rest.includes('#'))
    return { ok: false, error: 'invalidFormat' }
  const at = rest.lastIndexOf('@')
  const hostPort = parseHostPort(at === -1 ? rest : rest.slice(at + 1))
  if (at === -1) return withCredentials(type, hostPort, '', '')
  const { username, password } = splitUserInfo(rest.slice(0, at))
  const user = decode(username)
  const pass = decode(password)
  if (user === null || pass === null) return { ok: false, error: 'invalidFormat' }
  return withCredentials(type, hostPort, user, pass)
}

/** `usuário:senha@host:porta` ou `host:porta@usuário:senha`. */
function parseAtForm(line: string, type: ProxyType): LineParse {
  const at = line.lastIndexOf('@')
  const left = line.slice(0, at)
  const right = line.slice(at + 1)
  const rightHost = parseHostPort(right)
  if (rightHost.ok) {
    const { username, password } = splitUserInfo(left)
    return withCredentials(type, rightHost, username, password)
  }
  const leftHost = parseHostPort(left)
  if (leftHost.ok) {
    const { username, password } = splitUserInfo(right)
    return withCredentials(type, leftHost, username, password)
  }
  return rightHost
}

/** `host:porta`, `host:porta:usuário:senha`, `usuário:senha:host:porta` e `[ipv6]:porta[:usuário:senha]`. */
function parseColonForm(line: string, type: ProxyType): LineParse {
  if (line.startsWith('[')) {
    const match = /^(\[[^\]]+\]:[^:]*)(?::([^:]*):(.*))?$/.exec(line)
    if (!match) return { ok: false, error: 'invalidFormat' }
    return withCredentials(type, parseHostPort(match[1] ?? ''), match[2] ?? '', match[3] ?? '')
  }
  const parts = line.split(':')
  if (parts.length === 2) return withCredentials(type, parseHostPort(line), '', '')
  if (parts.length < 4) return { ok: false, error: 'invalidFormat' }
  const [p0 = '', p1 = '', p2 = '', p3 = ''] = parts
  const hostFirst = parseHostPort(`${p0}:${p1}`)
  // A senha pode conter ":" no formato host:porta:usuário:senha.
  const asHostFirst = hostFirst.ok ? withCredentials(type, hostFirst, p2, parts.slice(3).join(':')) : null
  const userFirst = parts.length === 4 ? parseHostPort(`${p2}:${p3}`) : null
  const asUserFirst = userFirst?.ok ? withCredentials(type, userFirst, p0, p1) : null
  if (asHostFirst?.ok && asUserFirst?.ok) {
    // Ex.: 1.2.3.4:8080:admin:1234 — "admin:1234" também parece host:porta. Vence o lado
    // cujo host é forte (IP ou nome com ponto); empate continua ambíguo.
    const hostFirstStrong = strongHost(asHostFirst.proxy.host)
    const userFirstStrong = strongHost(asUserFirst.proxy.host)
    if (hostFirstStrong && !userFirstStrong) return asHostFirst
    if (userFirstStrong && !hostFirstStrong) return asUserFirst
    return { ok: false, error: 'ambiguous' }
  }
  if (asHostFirst) return asHostFirst
  if (asUserFirst) return asUserFirst
  return hostFirst.ok ? { ok: false, error: 'invalidFormat' } : hostFirst
}

export function parseProxyLine(raw: string, defaultType: ProxyType): LineParse {
  const line = raw.trim()
  if (!line) return { ok: false, error: 'invalidFormat' }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line)) return parseUrlForm(line)
  if (line.includes('@')) {
    // "@" pode ser só parte da senha em host:porta:usuário:senha
    const atForm = parseAtForm(line, defaultType)
    if (atForm.ok) return atForm
    const colonForm = parseColonForm(line, defaultType)
    return colonForm.ok ? colonForm : atForm
  }
  return parseColonForm(line, defaultType)
}

/** Forma canônica para exibir, sempre com a senha mascarada. */
export function displayProxy(proxy: ParsedProxy): string {
  const auth = proxy.username ? `${proxy.username}${proxy.password ? ':••••' : ''}@` : ''
  return `${proxy.type}://${auth}${formatHost(proxy.host)}:${proxy.port}`
}

/** Mascaramento aproximado para linhas inválidas (podem conter uma senha). */
function maskInvalid(line: string): string {
  const at = line.lastIndexOf('@')
  if (at > 0) {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(line)?.[0] ?? ''
    const userInfo = line.slice(scheme.length, at)
    const colon = userInfo.indexOf(':')
    if (colon !== -1) return `${scheme}${userInfo.slice(0, colon)}:••••${line.slice(at)}`
  }
  // Sem saber o formato, a senha pode ser o 2º campo (user:pass:host:port) ou o 4º em
  // diante (host:port:user:pass, com ":" na senha): mascara as duas posições.
  const parts = line.split(':')
  if (parts.length >= 4) return [parts[0], '••••', parts[2], '••••'].join(':')
  return line
}

export function proxyKey(proxy: Pick<ParsedProxy, 'type' | 'host' | 'port' | 'username'>): string {
  return `${proxy.type}|${proxy.host.toLowerCase()}|${proxy.port}|${proxy.username}`
}

export function parseProxyList(
  text: string,
  defaultType: ProxyType,
  maxLines: number = LIMITS.proxyImportMaxLines,
): { lines: ParsedImportLine[]; truncated: boolean } {
  const lines: ParsedImportLine[] = []
  const seen = new Set<string>()
  let truncated = false
  const rawLines = text.split(/\r?\n/)
  for (let index = 0; index < rawLines.length; index++) {
    const raw = (rawLines[index] ?? '').trim()
    if (!raw || raw.startsWith('#')) continue
    if (lines.length >= maxLines) {
      truncated = true
      break
    }
    const result = parseProxyLine(raw, defaultType)
    let duplicateInList = false
    if (result.ok) {
      const key = proxyKey(result.proxy)
      duplicateInList = seen.has(key)
      seen.add(key)
    }
    lines.push({
      line: index + 1,
      display: result.ok ? displayProxy(result.proxy) : maskInvalid(raw),
      result,
      duplicateInList,
    })
  }
  return { lines, truncated }
}

export interface PastedProxy {
  proxy: ParsedProxy
  /** A linha trazia o tipo (`socks5://…`); sem ele, vale o tipo escolhido no formulário. */
  typed: boolean
}

/**
 * Linha de proxy colada num campo do formulário (`host:porta:usuário:senha` ou qualquer formato
 * da importação). Num campo de endereço (host ou porta) basta `host:porta`. Nos campos de usuário
 * e senha só vale uma linha completa (com tipo, `@` ou quatro partes), para que um valor comum,
 * como uma senha com ":", seja colado normalmente. Fora disso (ou com várias linhas), null.
 */
export function parsePastedProxy(
  text: string,
  defaultType: ProxyType,
  field: 'address' | 'credential',
): PastedProxy | null {
  const line = text.trim()
  if (!line || /[\r\n]/.test(line)) return null
  const typed = /^[a-z][a-z0-9+.-]*:\/\//i.test(line)
  if (field === 'credential' && !typed && !line.includes('@') && line.split(':').length < 4) return null
  const result = parseProxyLine(line, defaultType)
  return result.ok ? { proxy: result.proxy, typed } : null
}
