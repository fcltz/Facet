import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { AppError } from '@shared/ipc/result'
import type { Logger } from '../logger'
import { parseTrace } from './geoip'

/**
 * Trace da Cloudflare consultado sem proxy, em IPv4 e em IPv6: descobre o IP real desta
 * conexão. É o mesmo serviço da verificação dos proxies, então os dois IPs são comparáveis.
 */
export const DEFAULT_REAL_IP_URLS: readonly string[] = [
  'https://1.1.1.1/cdn-cgi/trace',
  'https://[2606:4700:4700::1111]/cdn-cgi/trace',
]

const TTL_MS = 5 * 60 * 1000
/** Sem resposta (sem internet, 1.1.1.1 bloqueado): tenta de novo depois de 1 min. */
const FAILURE_TTL_MS = 60 * 1000
/** Antes de acusar um proxy, um resultado mais velho que isso é confirmado (IP dinâmico). */
const CONFIRM_AFTER_MS = 60 * 1000
const TIMEOUT_MS = 5000
const MAX_BYTES = 16 * 1024

/** Busca o texto de uma URL; os testes trocam por um servidor local ou por uma função. */
export type TraceFetcher = (url: string, timeoutMs: number) => Promise<string>

/**
 * Forma canônica de um IP para comparar: IPv6 compactado e em minúsculas, IPv4 mapeado em
 * IPv6 (`::ffff:a.b.c.d`) vira IPv4. Texto que não é IP devolve null.
 */
export function normalizeIp(value: string | null | undefined): string | null {
  if (!value) return null
  const ip = value.trim().replace(/^\[(.*)\]$/, '$1')
  const family = net.isIP(ip)
  if (family === 4) return ip
  if (family !== 6) return null
  // O parser de URL compacta e põe em minúsculas; o IPv4 embutido sai em hexadecimal.
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1)
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical)
  if (!mapped) return canonical
  const high = Number.parseInt(mapped[1]!, 16)
  const low = Number.parseInt(mapped[2]!, 16)
  return [high >> 8, high & 255, low >> 8, low & 255].join('.')
}

/** GET direto, sem proxy e sem agente compartilhado, com prazo total e limite de tamanho. */
export const fetchDirect: TraceFetcher = (url, timeoutMs) =>
  new Promise<string>((resolve, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'https:' ? https : target.protocol === 'http:' ? http : null
    if (!client) return reject(new Error('Somente URLs http/https'))
    let settled = false
    const done = (error: Error | null, body?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(body ?? '')
    }
    const request = client.get(
      target,
      { agent: false, headers: { 'user-agent': 'Facet real IP check', accept: 'text/plain' } },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          return done(new Error(`HTTP ${response.statusCode ?? 0}`))
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_BYTES) request.destroy(new Error('resposta grande demais'))
          else chunks.push(chunk)
        })
        response.on('end', () => done(null, Buffer.concat(chunks).toString('utf8')))
        response.on('error', (error) => done(error))
      },
    )
    const timer = setTimeout(
      () => request.destroy(new Error(`sem resposta em ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    )
    request.on('error', (error) => done(error))
  })

function cancelled(): AppError {
  return new AppError('CANCELLED', 'Operação cancelada')
}

/** Espera a promessa compartilhada, mas libera quem cancelou sem cancelar os outros. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelled())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export interface RealIpOptions {
  /** URLs do trace consultadas sem proxy. Lista vazia desliga a comparação. */
  urls: readonly string[]
  /** Validade do resultado (padrão 5 min; os testes usam 0 para trocar o "IP real" na hora). */
  ttlMs?: number
  timeoutMs?: number
  now?: () => number
  fetch?: TraceFetcher
  logger?: Logger
}

interface Snapshot {
  ips: ReadonlySet<string>
  at: number
  failed: boolean
}

/**
 * IP real desta conexão (sem proxy), para recusar um proxy que sai por ele: nesse caso os
 * sites veriam o IP verdadeiro do usuário. Uma consulta por vez, com cache; sem resposta, a
 * comparação fica indisponível (nada é bloqueado por falta de dados).
 */
export class RealIpProbe {
  private snapshot: Snapshot | null = null
  private pending: Promise<Snapshot> | null = null
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(private readonly options: RealIpOptions) {
    this.ttlMs = options.ttlMs ?? TTL_MS
    this.now = options.now ?? Date.now
  }

  get enabled(): boolean {
    return this.options.urls.length > 0
  }

  /** IPs públicos desta conexão sem proxy (vazio = não foi possível descobrir). */
  async current(signal?: AbortSignal, maxAgeMs = this.ttlMs): Promise<ReadonlySet<string>> {
    if (!this.enabled) return new Set()
    const snapshot = this.snapshot
    if (snapshot) {
      const limit = snapshot.failed ? Math.min(maxAgeMs, FAILURE_TTL_MS) : maxAgeMs
      if (this.now() - snapshot.at < limit) return snapshot.ips
    }
    // Verificações em paralelo compartilham a mesma consulta.
    this.pending ??= this.fetchAll().finally(() => {
      this.pending = null
    })
    return (await abortable(this.pending, signal)).ips
  }

  /**
   * Começa a consulta (se o resultado guardado venceu) sem esperar por ela: a verificação de um
   * proxy chama isto antes do trace pelo proxy, e a comparação no fim já encontra a resposta.
   */
  warm(): void {
    void this.current().catch(() => undefined)
  }

  /**
   * O IP é desta conexão sem proxy? Antes de acusar, confirma com uma consulta nova quando o
   * resultado guardado tem mais de 1 min (o IP real pode ter mudado).
   */
  async isRealIp(ip: string | null, signal?: AbortSignal): Promise<boolean> {
    const key = normalizeIp(ip)
    if (!key || !this.enabled) return false
    if (!(await this.current(signal)).has(key)) return false
    if (this.snapshot && this.now() - this.snapshot.at <= CONFIRM_AFTER_MS) return true
    return (await this.current(signal, 0)).has(key)
  }

  private async fetchAll(): Promise<Snapshot> {
    const fetchTrace = this.options.fetch ?? fetchDirect
    const timeoutMs = this.options.timeoutMs ?? TIMEOUT_MS
    const results = await Promise.allSettled(this.options.urls.map((url) => fetchTrace(url, timeoutMs)))
    const ips = new Set<string>()
    const errors: string[] = []
    results.forEach((result, index) => {
      const url = this.options.urls[index]!
      if (result.status === 'rejected') {
        errors.push(
          `${url}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        )
        return
      }
      const ip = normalizeIp(parseTrace(result.value).ip)
      if (ip) ips.add(ip)
      else errors.push(`${url}: resposta sem IP`)
    })
    if (ips.size === 0) {
      this.options.logger?.warn(
        `IP real desta conexão indisponível; os proxies não são comparados com ele até a próxima tentativa (${errors.join('; ')})`,
      )
    }
    const snapshot: Snapshot = { ips, at: this.now(), failed: ips.size === 0 }
    this.snapshot = snapshot
    return snapshot
  }
}
