import { AppError, type AppErrorPayload } from '@shared/ipc/result'
import type { ProxyCheckOutcome } from '@shared/schemas/proxy'
import type { Logger } from '../logger'
import { ProxyForwarder } from './forwarder'
import { parseTrace, type GeoIpClient, type GeoResult } from './geoip'
import { isFatalProxyError, requestViaProxy } from './http-via-proxy'
import type { RealIpProbe } from './real-ip'
import { redactSecrets, upstreamUrl, type UpstreamProxy } from './upstream'

export interface CheckerOptions {
  geo: GeoIpClient
  /** URL de teste de conectividade (Cloudflare trace; os testes usam um servidor local). */
  traceUrl: () => string
  logger: Logger
  /** IP real desta conexão (sem proxy): um proxy que sai por ele é recusado. */
  realIp?: Pick<RealIpProbe, 'isRealIp'> & Partial<Pick<RealIpProbe, 'warm'>>
  now?: () => number
  checkTimeoutMs?: number
  openForwarder?: typeof ProxyForwarder.open
}

/** Proxy que sai pelo IP real desta conexão: os sites veriam o IP verdadeiro do usuário. */
export function realIpError(ip: string): AppError {
  return new AppError(
    'PROXY_REAL_IP',
    `O proxy está saindo pelo IP real desta conexão (${ip}): os sites veriam o seu IP verdadeiro`,
    { ip, reason: 'realIp' },
  )
}

/**
 * O que impede abrir um perfil depois da checagem feita pelo proxy local dele (`checkPort`): falha
 * do próprio proxy (senha, recusa, tempo, proxy remoto fora do ar) ou saída pelo IP real desta
 * conexão. Um proxy que só bloqueia o destino de teste, ou um geo-IP fora do ar, não impedem.
 */
export function launchBlocker(outcome: ProxyCheckOutcome): AppError | null {
  if (!outcome.error) return null
  const error = AppError.fromPayload(outcome.error)
  return error.code === 'PROXY_REAL_IP' || isFatalProxyError(error) ? error : null
}

const englishRegions = new Intl.DisplayNames(['en'], { type: 'region' })

function regionName(code: string | null): string | null {
  try {
    return code ? (englishRegions.of(code) ?? null) : null
  } catch {
    return null
  }
}

function toPayload(error: unknown, secrets: readonly (string | null)[]): AppErrorPayload {
  if (error instanceof AppError) {
    const payload = error.toPayload()
    return { ...payload, message: redactSecrets(payload.message, secrets) }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: 'PROXY_UNREACHABLE', message: redactSecrets(message, secrets) }
}

/** Limita verificações simultâneas (todas as chamadas compartilham o mesmo limite). */
export class CheckLimiter {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const next = (): void => {
          signal?.removeEventListener('abort', abort)
          resolve()
        }
        const abort = (): void => {
          const index = this.waiting.indexOf(next)
          if (index !== -1) this.waiting.splice(index, 1)
          reject(new AppError('CANCELLED', 'Verificação cancelada'))
        }
        this.waiting.push(next)
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      })
    } else {
      this.active++
    }
    try {
      signal?.throwIfAborted()
      return await task()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active--
    }
  }
}

export class ProxyChecker {
  private readonly now: () => number

  constructor(private readonly options: CheckerOptions) {
    this.now = options.now ?? Date.now
  }

  /** Primeiro IP visto pelo proxy que é o IP real desta conexão (null = nenhum ou sem comparação). */
  private async leakedIp(
    candidates: readonly (string | null)[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    const probe = this.options.realIp
    if (!probe) return null
    for (const ip of new Set(candidates)) {
      if (ip && (await probe.isRealIp(ip, signal))) return ip
    }
    return null
  }

  /** Verificação completa: online/offline, latência, IP de saída e geolocalização. */
  async check(proxy: UpstreamProxy, signal?: AbortSignal): Promise<ProxyCheckOutcome> {
    const secrets = [proxy.password, proxy.username]
    const open = this.options.openForwarder ?? ProxyForwarder.open
    let forwarder: ProxyForwarder | null = null
    try {
      forwarder = await open({ upstreamUrl: upstreamUrl(proxy), logger: this.options.logger })
      return await this.checkPort(forwarder.port, signal, secrets)
    } catch (error) {
      return this.offline(error, secrets)
    } finally {
      await forwarder?.close()
    }
  }

  /** Consulta o mesmo proxy local que será usado pelo navegador desta sessão. */
  async checkPort(
    port: number,
    signal?: AbortSignal,
    secrets: readonly (string | null)[] = [],
  ): Promise<ProxyCheckOutcome> {
    // o IP real (sem proxy) é consultado enquanto o trace passa pelo proxy: a comparação no fim
    // não espera mais uma consulta (antes, ela só começava depois do trace)
    this.options.realIp?.warm?.()
    try {
      let exitIp: string | null = null
      let traceCountry: string | null = null
      let latencyMs: number | null = null
      let traceError: unknown = null
      try {
        const response = await requestViaProxy(port, this.options.traceUrl(), {
          timeoutMs: this.options.checkTimeoutMs ?? 10000,
          signal,
        })
        if (response.status !== 200)
          throw new AppError('PROXY_UNREACHABLE', `Destino de teste respondeu HTTP ${response.status}`)
        const trace = parseTrace(response.body)
        exitIp = trace.ip
        traceCountry = trace.countryCode
        latencyMs = Math.round(response.tunnelMs)
      } catch (error) {
        if (isFatalProxyError(error)) throw error
        traceError = error
      }
      let geo: (GeoResult & { tunnelMs: number | null }) | null = null
      let geoError: unknown = null
      try {
        geo = await this.options.geo.lookup(port, exitIp, signal)
        if (latencyMs === null && geo.tunnelMs !== null) latencyMs = Math.round(geo.tunnelMs)
      } catch (error) {
        // Nada passou pelo proxy: offline, com o erro mais claro dos dois.
        if (!exitIp) throw isFatalProxyError(error) ? error : (traceError ?? error)
        if (error instanceof AppError && error.code === 'CANCELLED') throw error
        // O trace já passou pelo proxy: ele funciona, só falta a geolocalização.
        geoError =
          error instanceof AppError && error.code === 'GEOIP_FAILED'
            ? error
            : new AppError(
                'GEOIP_FAILED',
                `Geolocalização indisponível: ${error instanceof Error ? error.message : String(error)}`,
              )
      }
      const countryCode = geo?.countryCode ?? traceCountry
      const location = {
        countryCode,
        countryName: geo?.countryName ?? regionName(countryCode),
        region: geo?.region ?? null,
        city: geo?.city ?? null,
        timezone: geo?.timezone ?? null,
        latitude: geo?.latitude ?? null,
        longitude: geo?.longitude ?? null,
      }
      // O geo-IP pode ter visto outro endereço (IPv6, por exemplo): os dois são comparados.
      const leaked = await this.leakedIp([exitIp, geo?.ip ?? null], signal)
      if (leaked) {
        // Funciona, mas não protege: fica como offline, com o IP e o local para explicar.
        return {
          status: 'offline',
          latencyMs: null,
          exitIp: leaked,
          ...location,
          error: toPayload(realIpError(leaked), secrets),
          checkedAt: this.now(),
        }
      }
      return {
        status: 'online',
        latencyMs,
        // Proxy rotativo troca de IP a cada conexão: o IP exibido é o que o geo-IP viu, para
        // combinar com o local; sem geolocalização, o do trace.
        exitIp: geo?.ip ?? exitIp ?? null,
        ...location,
        error: geoError ? toPayload(geoError, secrets) : null,
        checkedAt: this.now(),
      }
    } catch (error) {
      return this.offline(error, secrets)
    }
  }
  private offline(error: unknown, secrets: readonly (string | null)[]): ProxyCheckOutcome {
    return {
      status: 'offline',
      latencyMs: null,
      exitIp: null,
      countryCode: null,
      countryName: null,
      region: null,
      city: null,
      timezone: null,
      latitude: null,
      longitude: null,
      error: toPayload(error, secrets),
      checkedAt: this.now(),
    }
  }
}
