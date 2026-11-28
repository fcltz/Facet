import { AppError } from '@shared/ipc/result'
import type { ProxyGeo } from '@shared/schemas/proxy'
import type { GeoIpProvider } from '@shared/schemas/settings'
import { isFatalProxyError, requestViaProxy } from '../http-via-proxy'
import { redactSecrets } from '../upstream'
import {
  AUTO_PROVIDER_ORDER,
  GEO_PROVIDERS,
  type GeoProvider,
  type GeoProviderId,
  type GeoResult,
} from './providers'

export { parseTrace } from './providers'
export type { GeoResult } from './providers'

export const DEFAULT_TRACE_URL = 'https://1.1.1.1/cdn-cgi/trace'

export interface GeoIpOptions {
  provider: () => GeoIpProvider
  token: () => string | null
  /** Provedores (os testes trocam por servidores locais). */
  providers?: Record<GeoProviderId, GeoProvider>
  ttlMs?: number
  timeoutMs?: number
  now?: () => number
}

/**
 * Consulta de geolocalização sempre através do proxy (o provedor vê só o IP do
 * proxy, nunca o IP real), com cadeia de fallback e cache por IP de saída.
 */
export class GeoIpClient {
  private readonly cache = new Map<string, { at: number; geo: GeoResult }>()
  private readonly providers: Record<GeoProviderId, GeoProvider>
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly now: () => number

  constructor(private readonly options: GeoIpOptions) {
    this.providers = options.providers ?? GEO_PROVIDERS
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000
    this.timeoutMs = options.timeoutMs ?? 8000
    this.now = options.now ?? Date.now
  }

  /** Geolocalização já conhecida de um IP (checagem gravada no banco), contada desde `at`. */
  remember(ip: string, geo: ProxyGeo, at: number): void {
    const current = this.cache.get(ip)
    if (current && current.at >= at) return
    const { countryCode, countryName, region, city, timezone, latitude, longitude } = geo
    this.cache.set(ip, {
      at,
      geo: { ip, countryCode, countryName, region, city, timezone, latitude, longitude },
    })
  }

  cached(ip: string | null): GeoResult | null {
    if (!ip) return null
    const hit = this.cache.get(ip)
    if (!hit || this.now() - hit.at > this.ttlMs) return null
    return hit.geo
  }

  /** `knownIp` (do trace) permite usar o cache sem nova consulta. */
  async lookup(
    proxyPort: number,
    knownIp: string | null,
    signal?: AbortSignal,
  ): Promise<GeoResult & { tunnelMs: number | null }> {
    const hit = this.cached(knownIp)
    if (hit) return { ...hit, tunnelMs: null }
    const choice = this.options.provider()
    const order = choice === 'auto' ? AUTO_PROVIDER_ORDER : [choice]
    const token = this.options.token()
    const errors: string[] = []
    for (const id of order) {
      const provider = this.providers[id]
      try {
        const response = await requestViaProxy(proxyPort, provider.url(token), {
          timeoutMs: this.timeoutMs,
          signal,
        })
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`)
        let body: unknown
        try {
          body = JSON.parse(response.body)
        } catch {
          throw new Error('resposta não é JSON')
        }
        const geo = provider.parse(body)
        const ip = geo.ip ?? knownIp
        if (ip) this.cache.set(ip, { at: this.now(), geo: { ...geo, ip } })
        return { ...geo, ip, tunnelMs: response.tunnelMs }
      } catch (error) {
        // Falha do próprio proxy: os outros provedores falhariam pelo mesmo motivo.
        if (isFatalProxyError(error)) throw error
        errors.push(
          `${id}: ${redactSecrets(error instanceof Error ? error.message : String(error), [token])}`,
        )
      }
    }
    throw new AppError('GEOIP_FAILED', `Nenhum provedor de geo-IP respondeu (${errors.join('; ')})`)
  }
}
