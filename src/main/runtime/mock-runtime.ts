import type { RuntimeStatusEvent } from '@shared/ipc/events'
import { AppError, type AppErrorPayload } from '@shared/ipc/result'
import { isRuntimeActive, type RuntimeStatus } from '@shared/schemas/profile'
import type { ProfileRuntime } from './types'

export interface MockRuntimeOptions {
  startDelayMs?: number
  stopDelayMs?: number
  now?: () => number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Simulação do ciclo parado → iniciando → rodando → parando → parado, com os
 * mesmos eventos que o launcher real vai emitir. Nada é aberto de verdade.
 */
export class MockRuntime implements ProfileRuntime {
  private readonly statuses = new Map<string, { status: RuntimeStatus; error: AppErrorPayload | null }>()
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly listeners = new Set<(event: RuntimeStatusEvent) => void>()
  private readonly startDelayMs: number
  private readonly stopDelayMs: number
  private readonly now: () => number
  private blockedReason: string | null = null

  constructor(options: MockRuntimeOptions = {}) {
    this.startDelayMs = options.startDelayMs ?? 1200
    this.stopDelayMs = options.stopDelayMs ?? 600
    this.now = options.now ?? Date.now
  }

  status(profileId: string): RuntimeStatus {
    return this.statuses.get(profileId)?.status ?? 'stopped'
  }

  snapshot(): RuntimeStatusEvent[] {
    const at = this.now()
    return [...this.statuses.entries()].map(([profileId, entry]) => ({
      profileId,
      status: entry.status,
      error: entry.error,
      at,
    }))
  }

  isActive(profileId: string): boolean {
    return isRuntimeActive(this.status(profileId))
  }

  hasActive(): boolean {
    return [...this.statuses.values()].some((entry) => isRuntimeActive(entry.status))
  }

  /** A simulação não abre navegador: não há conexão CDP. */
  client(): null {
    return null
  }

  async runIdle<T>(profileId: string, action: () => Promise<T> | T): Promise<T> {
    if (this.isActive(profileId)) throw new AppError('PROFILE_RUNNING', 'O perfil está aberto')
    return action()
  }

  /** Sem navegador de verdade: não há pasta para ler. */
  openOffline(): Promise<null> {
    return Promise.resolve(null)
  }

  blockStarts(reason: string): () => void {
    if (this.blockedReason) throw new AppError('JOB_BUSY', this.blockedReason)
    if (this.hasActive()) throw new AppError('PROFILE_RUNNING', 'Feche todos os perfis antes de continuar')
    this.blockedReason = reason
    return () => {
      this.blockedReason = null
    }
  }

  start(profileId: string): Promise<void> {
    if (this.blockedReason) return Promise.reject(new AppError('JOB_BUSY', this.blockedReason))
    const current = this.status(profileId)
    if (current === 'running') return Promise.resolve()
    const pending = this.inFlight.get(profileId)
    if (current === 'starting' && pending) return pending

    const run = async (): Promise<void> => {
      if (pending) await pending.catch(() => undefined)
      this.set(profileId, 'starting')
      await sleep(this.startDelayMs)
      if (this.status(profileId) === 'starting') this.set(profileId, 'running')
    }
    return this.track(profileId, run())
  }

  stop(profileId: string): Promise<void> {
    const current = this.status(profileId)
    if (current === 'stopped') return Promise.resolve()
    if (current === 'error') {
      this.set(profileId, 'stopped')
      return Promise.resolve()
    }
    const pending = this.inFlight.get(profileId)
    if (current === 'stopping' && pending) return pending

    const run = async (): Promise<void> => {
      if (pending) await pending.catch(() => undefined)
      if (this.status(profileId) === 'stopped') return
      this.set(profileId, 'stopping')
      await sleep(this.stopDelayMs)
      this.set(profileId, 'stopped')
    }
    return this.track(profileId, run())
  }

  async stopAll(): Promise<void> {
    const ids = [...this.statuses.keys()]
    await Promise.allSettled(ids.map((id) => this.stop(id)))
  }

  onStatus(listener: (event: RuntimeStatusEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private track(profileId: string, promise: Promise<void>): Promise<void> {
    const tracked = promise.finally(() => {
      if (this.inFlight.get(profileId) === tracked) this.inFlight.delete(profileId)
    })
    this.inFlight.set(profileId, tracked)
    return tracked
  }

  private set(profileId: string, status: RuntimeStatus, error: AppErrorPayload | null = null): void {
    if (status === 'stopped') this.statuses.delete(profileId)
    else this.statuses.set(profileId, { status, error })
    const event: RuntimeStatusEvent = { profileId, status, error, at: this.now() }
    for (const listener of this.listeners) listener(event)
  }
}
