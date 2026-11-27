import type { Logger } from '../logger'
import { ProxyForwarder, type ForwarderHealth, type TrafficSample } from './forwarder'

interface PoolEntry {
  proxyId: string
  forwarder: ProxyForwarder
  healthTimer: ReturnType<typeof setTimeout> | null
}

export interface ForwarderPoolDeps {
  logger: Logger
  /** Falhas do proxy remoto de um perfil aberto (no máximo um aviso por intervalo). */
  onHealth?: (profileId: string, health: ForwarderHealth) => void
  healthIntervalMs?: number
  /** Tráfego com a proxy remota de cada perfil aberto, uma amostra por intervalo. */
  onTraffic?: (profileId: string, sample: TrafficSample) => void
  trafficIntervalMs?: number
  /** Troca a implementação nos testes. */
  openForwarder?: typeof ProxyForwarder.open
}

const HEALTH_INTERVAL_MS = 1000
const TRAFFIC_INTERVAL_MS = 1000

/** Um proxy local por perfil aberto com proxy. */
export class ForwarderPool {
  private readonly entries = new Map<string, PoolEntry>()
  private trafficTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: ForwarderPoolDeps) {}

  /** Uma amostra de tráfego por segundo enquanto houver perfil aberto com proxy. */
  private watchTraffic(): void {
    if (!this.deps.onTraffic) return
    if (this.entries.size === 0) {
      if (this.trafficTimer) clearInterval(this.trafficTimer)
      this.trafficTimer = null
      return
    }
    if (this.trafficTimer) return
    this.trafficTimer = setInterval(() => {
      for (const [profileId, entry] of this.entries)
        this.deps.onTraffic?.(profileId, entry.forwarder.sample())
    }, this.deps.trafficIntervalMs ?? TRAFFIC_INTERVAL_MS)
    this.trafficTimer.unref?.()
  }

  /** Abre (ou reabre) o proxy local do perfil e devolve a porta. */
  async open(profileId: string, proxyId: string, upstreamUrl: string, port?: number): Promise<number> {
    await this.close(profileId)
    const open = this.deps.openForwarder ?? ProxyForwarder.open
    let entry: PoolEntry | null = null
    const forwarder = await open({
      upstreamUrl,
      port,
      logger: this.deps.logger,
      // Um site com muitas requisições gera dezenas de falhas por segundo: agrupa os avisos.
      onFailure: () => {
        const current = entry
        if (!current || current.healthTimer) return
        current.healthTimer = setTimeout(() => {
          current.healthTimer = null
          if (this.entries.get(profileId) === current)
            this.deps.onHealth?.(profileId, current.forwarder.health())
        }, this.deps.healthIntervalMs ?? HEALTH_INTERVAL_MS)
      },
    })
    entry = { proxyId, forwarder, healthTimer: null }
    this.entries.set(profileId, entry)
    this.watchTraffic()
    return forwarder.port
  }

  port(profileId: string): number | null {
    return this.entries.get(profileId)?.forwarder.port ?? null
  }

  health(profileId: string): ForwarderHealth | null {
    return this.entries.get(profileId)?.forwarder.health() ?? null
  }

  profilesUsing(proxyId: string): string[] {
    return [...this.entries.entries()].filter(([, entry]) => entry.proxyId === proxyId).map(([id]) => id)
  }

  /** Derruba as conexões de todos os perfis que usam o proxy e devolve os perfis afetados. */
  closeConnectionsForProxy(proxyId: string): string[] {
    const affected = this.profilesUsing(proxyId)
    for (const profileId of affected) this.entries.get(profileId)?.forwarder.closeConnections()
    return affected
  }

  async close(profileId: string): Promise<void> {
    const entry = this.entries.get(profileId)
    if (!entry) return
    this.entries.delete(profileId)
    if (entry.healthTimer) clearTimeout(entry.healthTimer)
    this.watchTraffic()
    await entry.forwarder.close()
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.entries.keys()].map((id) => this.close(id)))
  }
}
