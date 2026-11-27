import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { AppError, type ErrorCode } from '@shared/ipc/result'

export interface ViaProxyOptions {
  timeoutMs: number
  /** Corpo maior que isso é cortado (as respostas de geo-IP têm poucos KB). */
  maxBytes?: number
  headers?: Record<string, string>
  signal?: AbortSignal
  /** Certificados confiáveis extras para o destino HTTPS (só os testes, com um destino local). */
  ca?: string | Buffer
}

export interface ViaProxyResponse {
  status: number
  body: string
  /** Tempo até o túnel estar pronto (proxy + conexão até o destino): usado como latência. */
  tunnelMs: number
  totalMs: number
}

/** Códigos que o proxy-chain devolve quando o proxy remoto falha. */
const PROXY_STATUS: Record<number, { code: ErrorCode; message: string }> = {
  407: { code: 'PROXY_AUTH_FAILED', message: 'O proxy recusou usuário ou senha' },
  590: { code: 'PROXY_UNREACHABLE', message: 'O proxy respondeu com erro ao abrir a conexão' },
  592: { code: 'PROXY_UNREACHABLE', message: 'O proxy respondeu com um status inválido' },
  593: { code: 'PROXY_UNREACHABLE', message: 'Endereço do proxy ou do destino não encontrado (DNS)' },
  594: { code: 'PROXY_UNREACHABLE', message: 'O proxy recusou a conexão' },
  595: { code: 'PROXY_UNREACHABLE', message: 'A conexão com o proxy foi interrompida' },
  596: { code: 'PROXY_UNREACHABLE', message: 'A conexão com o proxy foi interrompida' },
  597: { code: 'PROXY_AUTH_FAILED', message: 'O proxy recusou usuário ou senha' },
  599: { code: 'PROXY_UNREACHABLE', message: 'Erro no proxy remoto' },
}

/**
 * Falhas do próprio proxy (não adianta tentar outro destino pelo mesmo proxy).
 * 599 entra porque é o que o proxy-chain devolve quando o SOCKS5 remoto está
 * fora do ar ou recusa a conexão.
 */
export const FATAL_PROXY_STATUSES = new Set([407, 593, 594, 595, 596, 597, 599])

export function proxyStatusError(status: number): AppError {
  const known = PROXY_STATUS[status]
  if (known) return new AppError(known.code, known.message, { proxyStatus: status })
  if (status === 504)
    return new AppError('PROXY_TIMEOUT', 'O proxy não respondeu a tempo', { proxyStatus: status })
  return new AppError('PROXY_UNREACHABLE', `O proxy respondeu HTTP ${status}`, { proxyStatus: status })
}

export function isFatalProxyError(error: unknown): boolean {
  if (!(error instanceof AppError)) return false
  if (error.code === 'PROXY_TIMEOUT' || error.code === 'PROXY_AUTH_FAILED' || error.code === 'CANCELLED')
    return true
  const status = (error.details as { proxyStatus?: number } | undefined)?.proxyStatus
  return status !== undefined && FATAL_PROXY_STATUSES.has(status)
}

function networkError(error: NodeJS.ErrnoException): AppError {
  if (error.code === 'ETIMEDOUT') return new AppError('PROXY_TIMEOUT', 'O proxy não respondeu a tempo')
  if (
    error.code?.startsWith('ERR_TLS') ||
    error.code?.includes('CERT') ||
    /certificate/i.test(error.message)
  ) {
    return new AppError('PROXY_UNREACHABLE', `Certificado TLS inválido: ${error.message}`, { tls: true })
  }
  return new AppError('PROXY_UNREACHABLE', error.message || String(error.code ?? 'erro de rede'))
}

const DEFAULT_HEADERS = { 'user-agent': 'Facet proxy check', accept: 'application/json, text/plain, */*' }

/**
 * GET através de um proxy local do Facet (o mesmo caminho do Brave): HTTPS por
 * túnel CONNECT com certificado validado, HTTP com URI absoluta.
 */
export function requestViaProxy(
  proxyPort: number,
  url: string,
  options: ViaProxyOptions,
): Promise<ViaProxyResponse> {
  const target = new URL(url)
  const maxBytes = options.maxBytes ?? 64 * 1024
  const headers = { ...DEFAULT_HEADERS, ...options.headers }
  const started = performance.now()

  return new Promise<ViaProxyResponse>((resolve, reject) => {
    const sockets: net.Socket[] = []
    let settled = false
    let tunnelMs = 0
    const cleanup = (): void => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      for (const socket of sockets) socket.destroy()
    }
    const fail = (error: AppError): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const succeed = (response: ViaProxyResponse): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(response)
    }
    const onAbort = (): void => fail(new AppError('CANCELLED', 'Operação cancelada'))
    const timer = setTimeout(
      () =>
        fail(
          new AppError('PROXY_TIMEOUT', `O proxy não respondeu em ${Math.round(options.timeoutMs / 1000)} s`),
        ),
      options.timeoutMs,
    )
    if (options.signal?.aborted) return onAbort()
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const collect = (request: http.ClientRequest): void => {
      request.on('error', (error) => fail(networkError(error)))
      request.on('socket', (socket) => sockets.push(socket))
      request.on('response', (response) => {
        const status = response.statusCode ?? 0
        if (status >= 590 || status === 407) {
          response.resume()
          return fail(proxyStatusError(status))
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size <= maxBytes) chunks.push(chunk)
        })
        response.on('error', (error) => fail(networkError(error)))
        response.on('end', () =>
          succeed({
            status,
            body: Buffer.concat(chunks).toString('utf8'),
            tunnelMs: tunnelMs || performance.now() - started,
            totalMs: performance.now() - started,
          }),
        )
      })
      request.end()
    }

    if (target.protocol === 'http:') {
      const request = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: target.href,
        headers: { ...headers, host: target.host },
        agent: false,
      })
      request.on('response', () => {
        tunnelMs = performance.now() - started
      })
      return collect(request)
    }
    if (target.protocol !== 'https:') return fail(new AppError('VALIDATION_ERROR', 'Somente URLs http/https'))

    const port = Number(target.port || 443)
    const hostname = target.hostname.replace(/^\[(.*)\]$/, '$1')
    const authority = `${net.isIPv6(hostname) ? `[${hostname}]` : hostname}:${port}`
    const connect = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: { host: authority },
      agent: false,
    })
    connect.on('error', (error) => fail(networkError(error)))
    // Algumas falhas voltam como resposta comum ao CONNECT.
    connect.on('response', (response) => {
      response.resume()
      fail(proxyStatusError(response.statusCode ?? 0))
    })
    connect.on('connect', (response, socket) => {
      sockets.push(socket)
      const status = response.statusCode ?? 0
      if (status !== 200) return fail(proxyStatusError(status))
      tunnelMs = performance.now() - started
      const secure = tls.connect({
        socket,
        host: hostname,
        servername: net.isIP(hostname) ? undefined : hostname,
        ALPNProtocols: ['http/1.1'],
        ...(options.ca ? { ca: options.ca } : {}),
      })
      sockets.push(secure)
      secure.on('error', (error) => fail(networkError(error)))
      // Sem `agent`: com qualquer agente (inclusive `agent: false`, que cria um novo) o Node
      // ignora `createConnection` e abre uma conexão TLS DIRETA com o destino, fora do túnel.
      // Era o que fazia a verificação ver o IP real desta máquina (verificado com um proxy real).
      collect(
        https.request({
          host: hostname,
          port,
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: { ...headers, host: target.host },
          createConnection: () => secure,
        }),
      )
    })
    connect.end()
  })
}
