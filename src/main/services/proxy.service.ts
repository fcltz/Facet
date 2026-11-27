import type { EmitFn } from '@shared/ipc/events'
import { AppError } from '@shared/ipc/result'
import { toListItem, type Profile } from '@shared/schemas/profile'
import {
  proxyEndpoint,
  type ProxyCheckOutcome,
  type ProxyCheckProgress,
  type ProxyCheckResult,
  type ProxyCreateData,
  type ProxyDeleteResult,
  type ProxyImportLine,
  type ProxyImportPreview,
  type ProxyImportResult,
  type ProxyPassword,
  type ProxyRotateResult,
  type ProxySummary,
  type ProxyType,
  type ProxyUpdateData,
  type PasswordChange,
  type ChangeIpUrlChange,
} from '@shared/schemas/proxy'
import type { Logger } from '../logger'
import type { CheckLimiter, ProxyChecker } from '../proxy/checker'
import { parseProxyList, proxyKey } from '@shared/proxy/parser'
import type { ForwarderPool } from '../proxy/pool'
import { rotateIp } from '../proxy/rotate'
import type { UpstreamProxy } from '../proxy/upstream'
import type { NewProxy, ProxyPatch, Repositories } from '../repositories/types'
import { sameFingerprint, syncFingerprint, type HostLocale } from './geo-sync'

export interface ProxyServiceDeps {
  repos: Repositories
  checker: ProxyChecker
  limiter: CheckLimiter
  pool: ForwarderPool
  emit: EmitFn
  now: () => number
  newId: () => string
  hostLocale: () => HostLocale
  logger: Logger
  /** Troca a chamada da URL de troca de IP nos testes. */
  rotate?: typeof rotateIp
}

const PROGRESS_INTERVAL_MS = 250

function validation(path: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', 'Dados inválidos', [{ path, message }])
}

function cancelledOutcome(at: number): ProxyCheckOutcome {
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
    error: { code: 'CANCELLED', message: 'Verificação cancelada' },
    checkedAt: at,
  }
}

function secretFromChange(change: PasswordChange | ChangeIpUrlChange | undefined): string | null | undefined {
  if (!change || change.mode === 'keep') return undefined
  return change.mode === 'clear' ? null : change.value
}

export class ProxyService {
  private controller = new AbortController()
  private batches = 0
  private progress: ProxyCheckProgress = { running: false, total: 0, done: 0, online: 0, offline: 0 }
  private progressTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: ProxyServiceDeps) {}

  list(): ProxySummary[] {
    return this.deps.repos.proxies
      .list()
      .sort(
        (a, b) =>
          (a.countryCode ?? 'ZZ').localeCompare(b.countryCode ?? 'ZZ') || a.host.localeCompare(b.host),
      )
  }

  get(id: string): ProxySummary {
    const proxy = this.deps.repos.proxies.get(id)
    if (!proxy) throw new AppError('NOT_FOUND', `Proxy não encontrado: ${id}`, { entity: 'proxy', id })
    return proxy
  }

  /**
   * Senha salva, decifrada para o formulário de edição: ela aparece mascarada no campo e o
   * usuário pode exibi-la ou editá-la ali. As listas e os resumos nunca levam a senha.
   */
  password(id: string): ProxyPassword {
    this.get(id)
    return { password: this.deps.repos.proxies.secrets(id)?.password ?? null }
  }

  /** Proxy com a senha decifrada, para o proxy local de um perfil. */
  upstream(id: string): UpstreamProxy {
    const proxy = this.deps.repos.proxies.get(id)
    const secrets = this.deps.repos.proxies.secrets(id)
    if (!proxy || !secrets)
      throw new AppError('PROXY_UNAVAILABLE', 'O proxy do perfil não existe mais', { id })
    return {
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: secrets.password,
    }
  }

  create(input: ProxyCreateData): ProxySummary {
    if (input.password && !input.username) throw validation('password', 'passwordWithoutUser')
    const endpoint = {
      type: input.type,
      host: input.host.toLowerCase(),
      port: input.port,
      username: input.username,
    }
    if (this.deps.repos.proxies.findByEndpoint(endpoint)) {
      throw new AppError('CONFLICT', 'Proxy já cadastrado', { reason: 'duplicateEndpoint', entity: 'proxy' })
    }
    const now = this.deps.now()
    const [created] = this.deps.repos.proxies.insertMany([
      {
        id: this.deps.newId(),
        name: input.name || null,
        ...endpoint,
        password: input.password || null,
        changeIpUrl: input.changeIpUrl || null,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      },
    ])
    if (!created) throw new AppError('INTERNAL', 'Proxy não foi gravado')
    this.emitChanged([created])
    return created
  }

  update(id: string, patch: ProxyUpdateData['patch']): ProxySummary {
    const current = this.get(id)
    const repoPatch: ProxyPatch = { updatedAt: this.deps.now() }
    if (patch.name !== undefined) repoPatch.name = patch.name || null
    if (patch.type !== undefined) repoPatch.type = patch.type
    if (patch.host !== undefined) repoPatch.host = patch.host.toLowerCase()
    if (patch.port !== undefined) repoPatch.port = patch.port
    if (patch.username !== undefined) repoPatch.username = patch.username
    if (patch.notes !== undefined) repoPatch.notes = patch.notes
    const password = secretFromChange(patch.password)
    if (password !== undefined) repoPatch.password = password
    const changeIpUrl = secretFromChange(patch.changeIpUrl)
    if (changeIpUrl !== undefined) repoPatch.changeIpUrl = changeIpUrl

    const username = repoPatch.username ?? current.username
    const hasPassword = password === undefined ? current.hasPassword : Boolean(password)
    if (hasPassword && !username) throw validation('password', 'passwordWithoutUser')
    const endpoint = {
      type: repoPatch.type ?? current.type,
      host: repoPatch.host ?? current.host,
      port: repoPatch.port ?? current.port,
      username,
    }
    const clash = this.deps.repos.proxies.findByEndpoint(endpoint)
    if (clash && clash.id !== id) {
      throw new AppError('CONFLICT', 'Proxy já cadastrado', { reason: 'duplicateEndpoint', entity: 'proxy' })
    }
    const updated = this.deps.repos.proxies.update(id, repoPatch)
    this.emitChanged([updated])
    return updated
  }

  /**
   * Exclusão com guarda: se algum perfil usa os proxies, só prossegue com
   * `confirmInUse`; os perfis ficam explicitamente sem proxy (conexão direta) e
   * voltam ao fuso/idioma desta máquina.
   */
  delete(ids: readonly string[], confirmInUse: boolean): ProxyDeleteResult {
    const { repos } = this.deps
    const targets = new Set(repos.proxies.getMany(ids).map((proxy) => proxy.id))
    const affected = repos.profiles
      .list('all')
      .filter((profile) => profile.proxyId && targets.has(profile.proxyId))
    if (affected.length > 0 && !confirmInUse) {
      throw new AppError('PROXY_IN_USE', `${affected.length} perfis usam estes proxies`, {
        profiles: affected.length,
      })
    }
    const host = this.deps.hostLocale()
    const now = this.deps.now()
    const { changed, count } = repos.transaction(() => {
      const changed = affected.map((profile) =>
        repos.profiles.update(profile.id, {
          proxyId: null,
          fingerprint: syncFingerprint(profile.fingerprint, null, host),
          updatedAt: now,
        }),
      )
      return { changed, count: repos.proxies.deleteMany([...targets]) }
    })
    if (count > 0) this.deps.emit('proxies.changed', { upserted: [], removedIds: [...targets] })
    this.emitProfiles(changed)
    return { count, detachedProfiles: affected.length }
  }

  parseImport(text: string, defaultType: ProxyType): ProxyImportPreview {
    const { lines, truncated } = parseProxyList(text, defaultType)
    const existing = new Set(this.deps.repos.proxies.list().map(proxyKey))
    const out: ProxyImportLine[] = lines.map(({ line, display, result, duplicateInList }) => {
      if (!result.ok) {
        return {
          line,
          display,
          status: 'invalid',
          error: result.error,
          type: null,
          endpoint: null,
          username: '',
        }
      }
      const { proxy } = result
      const exists = existing.has(proxyKey(proxy))
      return {
        line,
        display,
        status: duplicateInList || exists ? 'duplicate' : 'ok',
        error: duplicateInList ? 'duplicateInList' : exists ? 'alreadyExists' : null,
        type: proxy.type,
        endpoint: proxyEndpoint(proxy),
        username: proxy.username,
      }
    })
    return {
      lines: out,
      valid: out.filter((l) => l.status === 'ok').length,
      invalid: out.filter((l) => l.status === 'invalid').length,
      duplicates: out.filter((l) => l.status === 'duplicate').length,
      truncated,
    }
  }

  import(text: string, defaultType: ProxyType, checkAfter: boolean): ProxyImportResult {
    const { lines } = parseProxyList(text, defaultType)
    const existing = new Set(this.deps.repos.proxies.list().map(proxyKey))
    const now = this.deps.now()
    const rows: NewProxy[] = []
    let invalid = 0
    let duplicates = 0
    for (const { result, duplicateInList } of lines) {
      if (!result.ok) {
        invalid++
        continue
      }
      if (duplicateInList || existing.has(proxyKey(result.proxy))) {
        duplicates++
        continue
      }
      const { proxy } = result
      rows.push({
        id: this.deps.newId(),
        name: null,
        type: proxy.type,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password || null,
        changeIpUrl: null,
        notes: '',
        createdAt: now,
        updatedAt: now,
      })
    }
    const created = rows.length
      ? this.deps.repos.transaction(() => this.deps.repos.proxies.insertMany(rows))
      : []
    this.emitChanged(created)
    this.deps.logger.info(
      `Importados ${created.length} proxies (${duplicates} duplicados, ${invalid} inválidos)`,
    )
    if (checkAfter && created.length > 0) {
      void this.check(created.map((proxy) => proxy.id)).catch((error) =>
        this.deps.logger.warn('Verificação após importar falhou', error),
      )
    }
    return { created, invalid, duplicates }
  }

  /** Verifica os proxies (até 8 ao mesmo tempo, somando todas as chamadas) e grava os resultados. */
  async check(ids: readonly string[]): Promise<ProxyCheckResult[]> {
    const targets = this.deps.repos.proxies.getMany(ids)
    if (targets.length === 0) return []
    if (this.batches === 0) this.progress = { running: true, total: 0, done: 0, online: 0, offline: 0 }
    this.batches++
    this.progress.total += targets.length
    this.progress.running = true
    this.scheduleProgress()
    const signal = this.controller.signal
    try {
      return await Promise.all(
        targets.map(async (proxy): Promise<ProxyCheckResult> => {
          let outcome: ProxyCheckOutcome
          try {
            outcome = await this.deps.limiter.run(
              () => this.deps.checker.check(this.upstream(proxy.id), signal),
              signal,
            )
          } catch (error) {
            if (error instanceof AppError && error.code === 'CANCELLED') {
              this.countProgress(null)
              return { id: proxy.id, outcome: cancelledOutcome(this.deps.now()) }
            }
            throw error
          }
          if (outcome.error?.code === 'CANCELLED') {
            this.countProgress(null)
            return { id: proxy.id, outcome }
          }
          this.record(proxy.id, outcome)
          this.countProgress(outcome.status)
          return { id: proxy.id, outcome }
        }),
      )
    } finally {
      this.batches--
      if (this.batches === 0) {
        this.progress.running = false
        this.emitProgress()
      }
    }
  }

  cancelCheck(): void {
    this.controller.abort()
    this.controller = new AbortController()
  }

  /** Resolução na abertura: usa a porta da própria sessão, sem outro proxy temporário. */
  async checkPort(id: string, port: number, signal: AbortSignal): Promise<ProxyCheckOutcome> {
    const proxy = this.upstream(id)
    const outcome = await this.deps.limiter.run(
      () => this.deps.checker.checkPort(port, signal, [proxy.username, proxy.password]),
      signal,
    )
    signal.throwIfAborted()
    this.record(id, outcome)
    return outcome
  }

  /** Testa um proxy ainda não salvo (formulário); `keep` com `id` usa a senha guardada. */
  testDraft(input: {
    id: string | null
    type: ProxyType
    host: string
    port: number
    username: string
    password: PasswordChange
  }): Promise<ProxyCheckOutcome> {
    let password: string | null = null
    if (input.password.mode === 'set') password = input.password.value
    else if (input.password.mode === 'keep' && input.id)
      password = this.deps.repos.proxies.secrets(input.id)?.password ?? null
    if (password && !input.username) throw validation('password', 'passwordWithoutUser')
    const upstream: UpstreamProxy = {
      type: input.type,
      host: input.host.toLowerCase(),
      port: input.port,
      username: input.username,
      password,
    }
    return this.deps.limiter.run(() => this.deps.checker.check(upstream))
  }

  /** Chama a URL de troca de IP, verifica de novo e derruba as conexões dos perfis abertos com o proxy. */
  async rotate(id: string): Promise<ProxyRotateResult> {
    const before = this.get(id)
    const secrets = this.deps.repos.proxies.secrets(id)
    if (!secrets?.changeIpUrl)
      throw new AppError('PROXY_ROTATE_FAILED', 'Este proxy não tem URL de troca de IP')
    const upstream = this.upstream(id)
    const rotate = this.deps.rotate ?? rotateIp
    const { outcome, changed } = await rotate({
      changeIpUrl: secrets.changeIpUrl,
      previousIp: before.exitIp,
      check: () => this.deps.limiter.run(() => this.deps.checker.check(upstream)),
    })
    const proxy = this.record(id, outcome) ?? before
    const runningProfileIds = this.deps.pool.closeConnectionsForProxy(id)
    return {
      proxy,
      previousIp: before.exitIp,
      currentIp: outcome.exitIp,
      changed,
      countryChanged: Boolean(
        before.countryCode && proxy.countryCode && before.countryCode !== proxy.countryCode,
      ),
      fingerprintChanged: ['countryCode', 'timezone', 'latitude', 'longitude'].some(
        (key) => before[key as keyof ProxySummary] !== proxy[key as keyof ProxySummary],
      ),
      runningProfileIds,
    }
  }

  /** Grava a verificação e sincroniza os perfis (campos "auto") que usam o proxy. */
  private record(id: string, outcome: ProxyCheckOutcome): ProxySummary | null {
    let saved: ProxySummary
    try {
      saved = this.deps.repos.proxies.saveCheck(id, outcome)
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return null
      throw error
    }
    this.emitChanged([saved])
    if (outcome.error?.code === 'PROXY_REAL_IP') {
      // O IP e o local ficam gravados para a lista explicar; os perfis não são sincronizados.
      this.deps.logger.warn(
        `Proxy ${proxyEndpoint(saved)} sai pelo IP real desta conexão; perfis com ele não abrem`,
      )
    }
    if (outcome.status === 'online') this.resyncProfiles(saved)
    return saved
  }

  private resyncProfiles(proxy: ProxySummary): void {
    const host = this.deps.hostLocale()
    const now = this.deps.now()
    const changed: Profile[] = []
    for (const profile of this.deps.repos.profiles.list('active')) {
      if (profile.proxyId !== proxy.id) continue
      const next = syncFingerprint(profile.fingerprint, proxy, host)
      if (!sameFingerprint(next, profile.fingerprint)) {
        changed.push(this.deps.repos.profiles.update(profile.id, { fingerprint: next, updatedAt: now }))
      }
    }
    this.emitProfiles(changed)
  }

  private countProgress(status: 'online' | 'offline' | null): void {
    this.progress.done++
    if (status === 'online') this.progress.online++
    if (status === 'offline') this.progress.offline++
    this.scheduleProgress()
  }

  private scheduleProgress(): void {
    if (this.progressTimer) return
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null
      this.emitProgress()
    }, PROGRESS_INTERVAL_MS)
  }

  private emitProgress(): void {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer)
      this.progressTimer = null
    }
    this.deps.emit('proxies.checkProgress', { ...this.progress })
  }

  private emitChanged(proxies: readonly ProxySummary[]): void {
    if (proxies.length > 0) this.deps.emit('proxies.changed', { upserted: [...proxies], removedIds: [] })
  }

  private emitProfiles(profiles: readonly Profile[]): void {
    if (profiles.length > 0)
      this.deps.emit('profiles.changed', { upserted: profiles.map(toListItem), removedIds: [] })
    for (const profile of profiles) this.deps.emit('fingerprint.changed', { profileId: profile.id })
  }
}
