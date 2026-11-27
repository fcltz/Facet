import { isExpired, mergeCookies, serializeCookies, validateCookie } from '@shared/cookies/formats'
import type { EmitFn } from '@shared/ipc/events'
import { AppError } from '@shared/ipc/result'
import type {
  BrowserCookie,
  CookieFailure,
  CookieFormat,
  CookieImportResult,
  CookieStatus,
} from '@shared/schemas/cookies'
import type { CdpClient } from '../browser/cdp/client'
import { readCookies, writeCookies } from '../cookies/cdp'
import type { Logger } from '../logger'
import type { PendingCookieRepository, Repositories } from '../repositories/types'
import type { ProfileRuntime } from '../runtime/types'

/** O que o launcher precisa para aplicar os cookies pendentes ao abrir um perfil. */
export interface RuntimeCookies {
  /** Antes da primeira navegação. Nunca impede a abertura: falhas viram aviso. */
  applyPending(profileId: string, client: CdpClient, signal: AbortSignal): Promise<void>
}

export class PendingCookieApplier implements RuntimeCookies {
  constructor(
    private readonly deps: {
      repo: PendingCookieRepository
      emit: EmitFn
      logger: Logger
      now: () => number
    },
  ) {}

  async applyPending(profileId: string, client: CdpClient, signal: AbortSignal): Promise<void> {
    if (!this.deps.repo.status(profileId)) return
    let cookies: BrowserCookie[]
    try {
      cookies = this.deps.repo.get(profileId) ?? []
    } catch (error) {
      // Cofre indisponível: os pendentes ficam para a próxima abertura.
      this.deps.logger.warn('Cookies pendentes ilegíveis; mantidos para a próxima abertura', error)
      this.deps.emit('cookies.applied', { profileId, imported: 0, failed: 0, error: message(error) })
      return
    }
    const now = this.deps.now()
    try {
      const result = await writeCookies(
        client,
        cookies.filter((cookie) => !isExpired(cookie, now)),
        signal,
      )
      this.deps.repo.clear(profileId)
      if (result.failed.length > 0)
        this.deps.logger.warn(`O Brave recusou ${result.failed.length} cookies pendentes`, profileId)
      this.deps.emit('cookies.applied', {
        profileId,
        imported: result.imported,
        failed: result.failed.length,
        error: null,
      })
    } catch (error) {
      if (signal.aborted) throw error
      this.deps.logger.warn('Falha ao aplicar cookies pendentes; mantidos para a próxima abertura', error)
      this.deps.emit('cookies.applied', { profileId, imported: 0, failed: 0, error: message(error) })
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface CookieServiceDeps {
  repos: Repositories
  runtime: ProfileRuntime
  now: () => number
  logger: Logger
}

/**
 * Importar: perfil aberto grava na hora via CDP; fechado, fica pendente (cifrado) até a
 * próxima abertura, inclusive os cookies de sessão. Exportar: perfil aberto lê via CDP;
 * fechado, abre a pasta num Brave headless sem rede, somando os pendentes.
 */
export class CookieService {
  constructor(private readonly deps: CookieServiceDeps) {}

  private requireProfile(id: string, active: boolean): void {
    const profile = this.deps.repos.profiles.get(id)
    if (!profile) throw new AppError('NOT_FOUND', `Perfil não encontrado: ${id}`, { entity: 'profile', id })
    if (active && profile.deletedAt !== null)
      throw new AppError('CONFLICT', `Perfil está na lixeira: ${id}`, { reason: 'trashed', id })
  }

  status(id: string): CookieStatus {
    this.requireProfile(id, false)
    const pending = this.deps.repos.pendingCookies.status(id)
    return {
      pending: pending?.count ?? 0,
      pendingAt: pending?.createdAt ?? null,
      running: Boolean(this.deps.runtime.client?.(id)),
    }
  }

  async import(id: string, cookies: readonly BrowserCookie[]): Promise<CookieImportResult> {
    this.requireProfile(id, true)
    const now = this.deps.now()
    const failed: CookieFailure[] = []
    const valid: BrowserCookie[] = []
    for (const cookie of cookies) {
      const reason = validateCookie(cookie)
      if (reason) failed.push({ name: cookie.name, domain: cookie.domain, reason })
      else if (!isExpired(cookie, now)) valid.push(cookie)
    }
    const client = this.deps.runtime.client?.(id)
    if (client) {
      const written = await writeCookies(client, valid)
      return {
        applied: 'now',
        imported: written.imported,
        failed: [...failed, ...written.failed],
        pending: this.status(id).pending,
      }
    }
    const pending =
      valid.length > 0
        ? this.deps.repos.pendingCookies.add(id, valid, now)
        : (this.deps.repos.pendingCookies.status(id)?.count ?? 0)
    return { applied: 'pending', imported: valid.length, failed, pending }
  }

  /**
   * Só com o perfil parado e o lock já obtido (dentro de runStopped/runIdle): cookies da
   * pasta, lidos por um Brave headless sem rede, somados aos pendentes.
   */
  async readOffline(id: string, signal?: AbortSignal): Promise<BrowserCookie[]> {
    const pending = this.deps.repos.pendingCookies.get(id) ?? []
    const browser = await this.deps.runtime.openOffline?.(id, signal)
    if (!browser) return pending
    try {
      return mergeCookies(await readCookies(browser.client), pending)
    } finally {
      await browser.close()
    }
  }

  async read(id: string, signal?: AbortSignal): Promise<BrowserCookie[]> {
    const { runtime } = this.deps
    const live = runtime.client?.(id)
    if (live) return mergeCookies(await readCookies(live), this.deps.repos.pendingCookies.get(id) ?? [])
    if (!runtime.runIdle) return this.deps.repos.pendingCookies.get(id) ?? []
    try {
      return await runtime.runIdle(id, () => this.readOffline(id, signal))
    } catch (error) {
      // O perfil abriu entre a checagem e o lock: lê da sessão aberta.
      const opened =
        error instanceof AppError && error.code === 'PROFILE_RUNNING' ? runtime.client?.(id) : null
      if (!opened) throw error
      return mergeCookies(await readCookies(opened), this.deps.repos.pendingCookies.get(id) ?? [])
    }
  }

  async export(id: string, format: CookieFormat): Promise<{ text: string; count: number }> {
    this.requireProfile(id, false)
    const now = this.deps.now()
    const cookies = (await this.read(id)).filter((cookie) => !isExpired(cookie, now))
    return { text: serializeCookies(cookies, format), count: cookies.length }
  }

  clearPending(id: string): CookieStatus {
    this.requireProfile(id, false)
    this.deps.repos.pendingCookies.clear(id)
    return this.status(id)
  }
}
