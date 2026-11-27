import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import type { Protocol } from 'devtools-protocol'
import type { BrowserKind } from '@shared/constants'
import { FACET_EXTENSION_ID } from '@shared/facet-extension'
import type { EmitFn, RuntimeStatusEvent } from '@shared/ipc/events'
import { AppError, type AppErrorPayload } from '@shared/ipc/result'
import { toListItem, type Profile, type RuntimeStatus } from '@shared/schemas/profile'
import type { FingerprintSessionState, FingerprintSnapshot } from '@shared/schemas/fingerprint'
import type { ProxyGeo } from '@shared/schemas/proxy'
import { sameFingerprint, type HostLocale } from '../services/geo-sync'
import { capabilitiesFor } from './fingerprint/capabilities'
import { resolveFingerprint } from './fingerprint/resolve'
import { FingerprintController } from './fingerprint/controller'
import type { BrowserEngine, OfflineBrowser } from './engine'
import { profileWindow, type WindowSize } from './window-size'
import type { ProfileRuntime } from '../runtime/types'
import type { ProfileRepository } from '../repositories/types'
import type { SessionRepository, ProfileSession } from '../repositories/sqlite/sessions'
import type { Logger } from '../logger'
import type { ProfileFiles } from './profile-files'
import type { CdpClient } from './cdp/client'
import type { ProxyChecker } from '../proxy/checker'
import type { ForwarderPool } from '../proxy/pool'
import { upstreamUrl, type UpstreamProxy } from '../proxy/upstream'
import type { ExtensionLaunch, RuntimeExtensions } from '../extensions/runtime'
import {
  IDENTITY_EXTENSION_ID,
  identityLabel,
  renameIdentity,
  ungroupIdentityTabs,
  type ProfileIdentityStore,
} from '../identity/extension'
import type { WindowIdentity } from '../identity/window-identity'
import type { RuntimeCookies } from '../services/cookie.service'
import { trackTargets } from './cdp/auto-attach'
import { isWebUrl, rememberPages } from './sessions'
import { recoverIdentity } from './recovery'
import {
  assertDirectoryIdle,
  identityStillMatches,
  inspectProcess,
  terminateOwnedProcess,
  waitForExit,
  type ProcessIdentity,
} from './process'

interface Entry {
  session: ProfileSession
  /** Navegador desta sessão (o perfil pode ter trocado de navegador depois de abrir). */
  browser: BrowserKind
  identity: ProcessIdentity | null
  client?: CdpClient
  child?: ChildProcess
  stopPages?: () => void
  stopTargets?: () => void
  fingerprint?: FingerprintController
  fingerprintError?: unknown
  reconnect?: ReturnType<typeof setTimeout>
  reconnectAbort?: AbortController
  /** Para a guarda de abas de boas-vindas. */
  stopTabs?: () => void
  /** Interrompe a autoconfiguração das extensões (perfil fechando ou conexão perdida). */
  extensionAbort?: AbortController
  /** Identificação desta sessão no navegador e na barra de tarefas. */
  badge?: SessionBadge
  /** Celular emulado: escala da imagem da página (a janela não coube na tela). */
  viewScale?: number
  closing: boolean
}
interface SessionBadge {
  /** "01 · Nome" em uso no grupo de abas, na dica do ícone e na barra de tarefas. */
  label: string
  /** Extensão de identificação carregada nesta abertura. */
  inBrowser: boolean
  /** Botão próprio na barra de tarefas (Windows); null = desligado. */
  taskbar: { appId: string; icon: string } | null
}
/** Identificação do perfil aberto: extensão no navegador e botão próprio na barra de tarefas. */
export interface RuntimeIdentity {
  store: ProfileIdentityStore
  windows: WindowIdentity
  /** Configuração atual; vale a partir da próxima abertura. */
  settings: () => { inBrowser: boolean; taskbar: boolean }
  /** Comando de reabertura gravado nas janelas (abre o Facet). */
  relaunchCommand: string
}
/** Proxy local por perfil: abre antes do navegador, fecha depois dele, é recriado na recuperação. */
export interface RuntimeNetwork {
  pool: ForwarderPool
  checker: ProxyChecker
  /** Proxy com a senha decifrada; lança PROXY_UNAVAILABLE se não existir mais. */
  upstream: (proxyId: string) => UpstreamProxy
  resolveGeo: (proxyId: string, port: number, signal: AbortSignal) => Promise<ProxyGeo>
}
interface RuntimeDeps {
  /** Motor de cada navegador (o perfil escolhe o dele). */
  engine: (browser: BrowserKind) => BrowserEngine
  /** Área de trabalho do monitor principal (janelas dos celulares emulados); null = desconhecida. */
  workArea?: () => WindowSize | null
  profiles: ProfileRepository
  sessions: SessionRepository
  files: ProfileFiles
  logger: Logger
  emit: EmitFn
  network: RuntimeNetwork
  extensions: RuntimeExtensions
  /** Cookies importados com o perfil fechado, aplicados antes da primeira navegação. */
  cookies: RuntimeCookies
  hostLocale: () => HostLocale
  identity: RuntimeIdentity
  /** Página aberta quando o perfil não tem URLs iniciais nem abas a restaurar; vazio = em branco. */
  startPage: () => string
}

/**
 * A primeira aba que o navegador abre traz a barra "unsupported command-line flag" do
 * --disable-blink-features=AutomationControlled, o flag que mantém navigator.webdriver falso.
 * Abas criadas depois, pelo CDP, não trazem a barra (verificado no Brave 158). Logo depois da
 * conexão, abre uma aba em branco nova e fecha as do início, antes de qualquer página do
 * perfil. Uma falha só gera aviso: o perfil abre com a barra.
 * Devolve as abas fechadas: o `closeTarget` responde antes de a aba sumir, e ela ainda pode
 * aparecer na lista seguinte; quem lista as abas iniciais precisa ignorá-las.
 */
export async function replaceStartupTab(
  client: CdpClient,
  signal: AbortSignal,
  logger: Logger,
  waitMs = 5000,
): Promise<string[]> {
  const closed: string[] = []
  try {
    const deadline = Date.now() + waitMs
    let startup: string[] = []
    for (;;) {
      signal.throwIfAborted()
      startup = (await client.send('Target.getTargets', {})).targetInfos
        .filter((target) => target.type === 'page' && target.url === 'about:blank')
        .map((target) => target.targetId)
      if (startup.length > 0 || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (startup.length === 0) {
      logger.warn('A primeira aba do navegador não apareceu a tempo; a barra de aviso do flag pode ficar')
      return closed
    }
    // A aba nova vem antes: fechar a única aba fecharia a janela.
    await client.send('Target.createTarget', { url: 'about:blank' })
    for (const targetId of startup) {
      await client.send('Target.closeTarget', { targetId })
      closed.push(targetId)
    }
  } catch (error) {
    if (signal.aborted) throw error
    logger.warn(
      'Não foi possível trocar a primeira aba do navegador; a barra de aviso do flag pode ficar',
      error,
    )
  }
  return closed
}

export class LaunchQueue {
  private active = 0
  private waiters: (() => void)[] = []
  async run<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    if (this.active >= 3)
      await new Promise<void>((resolve, reject) => {
        const next = (): void => {
          signal.removeEventListener('abort', abort)
          resolve()
        }
        const abort = (): void => {
          this.waiters = this.waiters.filter((w) => w !== next)
          reject(new AppError('CANCELLED', 'Abertura cancelada na fila'))
        }
        this.waiters.push(next)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    else this.active++
    try {
      signal.throwIfAborted()
      return await action()
    } finally {
      const next = this.waiters.shift()
      if (next) next()
      else this.active--
    }
  }
}

export class BrowserRuntime implements ProfileRuntime {
  private entries = new Map<string, Entry>()
  private statuses = new Map<string, RuntimeStatusEvent>()
  private listeners = new Set<(event: RuntimeStatusEvent) => void>()
  private locks = new Map<string, Promise<unknown>>()
  private starts = new Map<string, { promise: Promise<void>; controller: AbortController }>()
  private queue = new LaunchQueue()
  private shuttingDown = false
  private blockedReason: string | null = null
  constructor(private readonly deps: RuntimeDeps) {}
  status(id: string): RuntimeStatus {
    return this.statuses.get(id)?.status ?? 'stopped'
  }
  snapshot(): RuntimeStatusEvent[] {
    return [...this.statuses.values()]
  }
  isActive(id: string): boolean {
    return this.entries.has(id) || this.starts.has(id)
  }
  hasActive(): boolean {
    return this.entries.size > 0 || this.starts.size > 0
  }
  /** Conexão CDP de um perfil rodando (captura da configuração de extensões). */
  client(id: string): CdpClient | null {
    const entry = this.entries.get(id)
    return entry?.client && this.status(id) === 'running' ? entry.client : null
  }
  async fingerprintState(id: string): Promise<FingerprintSessionState> {
    const profile = this.deps.profiles.get(id)
    if (!profile) throw new AppError('NOT_FOUND', 'Perfil não encontrado')
    const entry = this.entries.get(id)
    const snapshot = entry?.session.fingerprintSnapshot ?? null
    return {
      active: this.isActive(id),
      snapshot,
      pendingRestart: Boolean(
        entry && (!snapshot || !sameFingerprint(snapshot.configured, profile.fingerprint)),
      ),
      observations: (await entry?.fingerprint?.observe()) ?? [],
      warnings: entry?.fingerprint?.warnings() ?? (entry ? ['legacySession'] : []),
    }
  }
  onStatus(listener: (event: RuntimeStatusEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private set(
    id: string,
    status: RuntimeStatus,
    error: AppErrorPayload | null = null,
    recovered = false,
  ): void {
    const event: RuntimeStatusEvent = { profileId: id, status, at: Date.now(), error, recovered }
    if (status === 'stopped') this.statuses.delete(id)
    else this.statuses.set(id, event)
    for (const listener of this.listeners) listener(event)
  }
  private lock<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(action)
    const tracked = operation.finally(() => {
      if (this.locks.get(id) === tracked) this.locks.delete(id)
    })
    this.locks.set(id, tracked)
    return tracked
  }
  blockStarts(reason: string): () => void {
    if (this.blockedReason) throw new AppError('JOB_BUSY', this.blockedReason)
    if (this.hasActive()) throw new AppError('PROFILE_RUNNING', 'Feche todos os perfis antes de continuar')
    this.blockedReason = reason
    let released = false
    return () => {
      if (released) return
      released = true
      this.blockedReason = null
    }
  }
  start(id: string): Promise<void> {
    if (this.shuttingDown) return Promise.reject(new AppError('CANCELLED', 'O aplicativo está encerrando'))
    if (this.blockedReason) return Promise.reject(new AppError('JOB_BUSY', this.blockedReason))
    const pending = this.starts.get(id)
    if (pending) return pending.promise
    const controller = new AbortController()
    const promise = this.lock(id, async () => {
      if (this.entries.has(id)) {
        if (this.status(id) === 'running') return
        throw new AppError(
          'PROFILE_IN_USE',
          'O processo ainda está ativo; pare o perfil antes de abrir novamente',
        )
      }
      this.set(id, 'starting')
      try {
        await this.queue.run(controller.signal, () => this.launch(id, controller.signal))
      } catch (error) {
        if (!this.entries.has(id))
          this.set(
            id,
            controller.signal.aborted ? 'stopped' : 'error',
            controller.signal.aborted ? null : this.payload(error),
          )
        if (controller.signal.aborted) throw new AppError('CANCELLED', 'Abertura cancelada')
        throw error
      }
    }).finally(() => {
      if (this.starts.get(id)?.controller === controller) this.starts.delete(id)
    })
    this.starts.set(id, { promise, controller })
    return promise
  }
  private payload(error: unknown): AppErrorPayload {
    return error instanceof AppError
      ? error.toPayload()
      : { code: 'BROWSER_START_FAILED', message: error instanceof Error ? error.message : String(error) }
  }
  private async launch(id: string, signal: AbortSignal): Promise<void> {
    let profile = this.deps.profiles.get(id)
    if (!profile || profile.deletedAt !== null)
      throw new AppError('NOT_FOUND', 'Perfil inexistente ou na lixeira')
    const browser = profile.browser
    const engine = this.deps.engine(browser)
    const info = await engine.detect()
    signal.throwIfAborted()
    if (!info.available || !info.executablePath)
      throw new AppError('BROWSER_NOT_FOUND', info.error ?? `${info.name} não encontrado`, { browser })
    // Proxy antes de tudo: proxy inexistente, senha recusada ou fora do ar falha aqui, sem
    // criar a pasta e sem nunca cair para conexão direta. Extensões sem arquivos também
    // falham aqui (o perfil não abre sem uma extensão que deveria ter).
    let proxyPort: number | null = null
    let directory: string
    let extensions: ExtensionLaunch
    let fingerprintSnapshot: FingerprintSnapshot
    try {
      extensions = this.deps.extensions.prepare(profile)
      // Marcas das Client Hints e sufixo do User-Agent vêm da sondagem deste navegador.
      const capabilities = info.fingerprintCapabilities ?? capabilitiesFor(info, { browser })
      let proxyGeo: ProxyGeo | null = null
      if (profile.proxyId) {
        const { pool, checker, upstream } = this.deps.network
        proxyPort = await pool.open(id, profile.proxyId, upstreamUrl(upstream(profile.proxyId)))
        await checker.preflight(proxyPort, signal)
        proxyGeo = await this.deps.network.resolveGeo(profile.proxyId, proxyPort, signal)
      }
      fingerprintSnapshot = resolveFingerprint(
        profile.fingerprint,
        capabilities,
        proxyGeo,
        this.deps.hostLocale(),
      )
      // A configuração salva passa a refletir a resolução desta abertura. Ela é copiada
      // para a sessão; edições seguintes nunca mudam o controlador da sessão existente.
      fingerprintSnapshot.configured = structuredClone(fingerprintSnapshot.effective)
      const fingerprint = fingerprintSnapshot.configured
      const latest = this.deps.profiles.get(id)
      const unchanged =
        latest &&
        latest.proxyId === profile.proxyId &&
        sameFingerprint(
          resolveFingerprint(latest.fingerprint, capabilities, proxyGeo, this.deps.hostLocale()).effective,
          fingerprint,
        )
      if (
        unchanged &&
        (!sameFingerprint(latest.fingerprint, fingerprint) ||
          latest.os !== fingerprint.os ||
          latest.userAgent !== fingerprint.userAgent)
      ) {
        const saved = this.deps.profiles.update(id, {
          fingerprint,
          os: fingerprint.os,
          userAgent: fingerprint.userAgent,
          updatedAt: Date.now(),
        })
        this.deps.emit('profiles.changed', { upserted: [toListItem(saved)], removedIds: [] })
      }
      profile = { ...profile, fingerprint, os: fingerprint.os, userAgent: fingerprint.userAgent }
      directory = this.deps.files.prepare(id)
      await assertDirectoryIdle(directory)
      signal.throwIfAborted()
    } catch (error) {
      await this.deps.network.pool.close(id)
      this.deps.extensions.released(id)
      throw error
    }
    // Identificação (grupo de abas, ícone fixado, barra de tarefas): nunca impede a abertura.
    const prepared = this.prepareBadge(profile)
    const identityDir = prepared?.extensionDir ?? null
    const session: ProfileSession = {
      profileId: id,
      phase: 'starting',
      executablePath: info.executablePath,
      userDataDir: directory,
      pid: null,
      processStartedAt: null,
      cdpPort: null,
      wsEndpoint: null,
      engineVersion: null,
      proxyId: profile.proxyId,
      localProxyPort: proxyPort,
      extensionDirs: extensions.dirKeys,
      fingerprintSnapshot,
      startedAt: Date.now(),
    }
    this.deps.sessions.save(session)
    const entry: Entry = {
      session,
      browser,
      identity: null,
      closing: false,
      extensionAbort: new AbortController(),
      badge: prepared?.badge,
    }
    // Celular: janela do tamanho do aparelho (reduzida, só na imagem, se não couber na tela).
    const view = profileWindow(
      fingerprintSnapshot.effective,
      profile.launchOptions.window,
      this.deps.workArea?.() ?? null,
    )
    entry.viewScale = view.scale
    this.entries.set(id, entry)
    const restore = profile.launchOptions.restoreTabs ? this.deps.sessions.getUrls(id).filter(isWebUrl) : []
    try {
      const launched = await engine.launch(
        profile,
        directory,
        signal,
        async (child) => {
          entry.child = child
          entry.session.pid = child.pid ?? null
          this.deps.sessions.save(entry.session)
          for (let i = 0; i < 5 && child.pid; i++) {
            entry.identity = await inspectProcess(child.pid)
            if (entry.identity) break
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          if (!entry.identity)
            throw new AppError(
              'BROWSER_START_FAILED',
              `Não foi possível identificar o processo do ${info.name}`,
            )
          entry.session.processStartedAt = entry.identity.startedAt
          this.deps.sessions.save(entry.session)
          // Processo conferido como deste perfil: a janela recebe o botão próprio assim que surgir.
          this.trackWindows(entry)
        },
        {
          proxyPort,
          extensionDirs: identityDir ? [...extensions.directories, identityDir] : extensions.directories,
          fingerprint: fingerprintSnapshot.effective,
          identityExtensionId: identityDir ? IDENTITY_EXTENSION_ID : null,
          facetExtension: extensions.items.some((item) => item.id === FACET_EXTENSION_ID),
          window: view.window,
        },
      )
      entry.client = launched.client
      signal.throwIfAborted()
      entry.session = {
        ...entry.session,
        phase: 'running',
        cdpPort: launched.port,
        wsEndpoint: launched.endpoint,
        engineVersion: launched.version.product,
      }
      // Antes de tudo: leva junto a barra de aviso do flag que fica na primeira aba.
      const replaced = await replaceStartupTab(launched.client, signal, this.deps.logger)
      await this.attach(id, entry, launched.client)
      // Confere se o navegador carregou as extensões (senão o perfil fecha com o erro) e passa a
      // vigiar as abas de boas-vindas que elas abrem a cada abertura.
      const tabs = await this.deps.extensions.afterConnect(id, launched.client, extensions, signal)
      entry.stopTabs = () => tabs.stop()
      // Antes de qualquer página do perfil: a primeira requisição já leva os cookies importados.
      await this.deps.cookies.applyPending(id, launched.client, signal)
      const startPage = this.deps.startPage()
      const urls = restore.length
        ? restore
        : profile.launchOptions.startupUrls.length
          ? profile.launchOptions.startupUrls
          : isWebUrl(startPage)
            ? [startPage]
            : []
      const initial = await this.initialBlankPages(launched.client, signal, replaced)
      for (const tab of initial) {
        tabs.keep(tab.targetId)
        await entry.fingerprint!.ready(tab.targetId)
      }
      if (urls.length) {
        for (const url of urls) {
          signal.throwIfAborted()
          const targetId = await entry.fingerprint!.createPage()
          tabs.keep(targetId)
          await entry.fingerprint!.navigate(targetId, url)
        }
        for (const tab of initial)
          await launched.client.send('Target.closeTarget', { targetId: tab.targetId })
      } else if (initial.length === 0) {
        // Sem aba inicial (o navegador não chegou a criá-la): garante uma janela visível.
        const targetId = await entry.fingerprint!.createPage()
        tabs.keep(targetId)
      }
      this.deps.sessions.save(entry.session)
      if (entry.fingerprintError) throw entry.fingerprintError
      this.set(id, 'running')
      this.deps.emit('fingerprint.changed', { profileId: id })
      tabs.arm()
      this.deps.extensions.afterStart(id, launched.client, extensions, entry.extensionAbort!.signal)
    } catch (error) {
      try {
        await this.stopEntry(id)
      } catch (cleanupError) {
        this.deps.logger.error('Falha ao limpar abertura interrompida', cleanupError)
        this.set(id, 'disconnected', this.payload(cleanupError))
      }
      throw error
    }
  }
  /**
   * A aba inicial em branco: a que substituiu a primeira aba do navegador ou, se a troca falhou,
   * a do próprio navegador (criada logo depois de abrir o CDP). Espera por ela para que as
   * páginas do perfil abram na mesma janela, e não numa segunda janela.
   */
  private async initialBlankPages(
    client: CdpClient,
    signal: AbortSignal,
    closed: readonly string[] = [],
  ): Promise<Protocol.Target.TargetInfo[]> {
    const deadline = Date.now() + 10000
    for (;;) {
      signal.throwIfAborted()
      // A primeira aba do navegador, já fechada, ainda pode aparecer por alguns instantes: prepará-la
      // falharia no meio ("a aba fechou durante a preparação") e derrubaria a abertura.
      const pages = (await client.send('Target.getTargets', {})).targetInfos.filter(
        (t) => t.type === 'page' && !closed.includes(t.targetId),
      )
      if (pages.length > 0 || Date.now() >= deadline) return pages.filter((t) => t.url === 'about:blank')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  /** Arquivos de identificação conforme as configurações atuais; falha só gera aviso. */
  private prepareBadge(profile: Profile): { badge: SessionBadge; extensionDir: string | null } | null {
    const { inBrowser, taskbar } = this.deps.identity.settings()
    const windows = taskbar && this.deps.identity.windows.enabled
    if (!inBrowser && !windows) return null
    try {
      const files = this.deps.identity.store.prepare(profile, { inBrowser })
      return {
        badge: {
          label: files.label,
          inBrowser: files.extensionDir !== null,
          taskbar: windows ? { appId: files.appId, icon: files.iconPath } : null,
        },
        extensionDir: files.extensionDir,
      }
    } catch (error) {
      this.deps.logger.warn('Não foi possível preparar a identificação do perfil; abrindo sem ela', error)
      return null
    }
  }
  /** Botão próprio na barra de tarefas para todas as janelas do processo deste perfil. */
  private trackWindows(entry: Entry): void {
    const pid = entry.session.pid
    const taskbar = entry.badge?.taskbar
    if (!pid || !taskbar) return
    this.deps.identity.windows.track({
      pid,
      appId: taskbar.appId,
      icon: taskbar.icon,
      name: entry.badge!.label,
      command: this.deps.identity.relaunchCommand,
    })
  }
  /**
   * Antes de o Facet fechar o perfil: desfaz o grupo de identificação (fechado junto com a
   * janela, o navegador o guardaria como grupo salvo). Nunca atrasa a parada mais que ~3 s.
   */
  private async releaseTabGroups(entry: Entry): Promise<void> {
    const client = entry.client
    if (!client || !entry.badge?.inBrowser) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const work = (async () => {
      const { extensions } = await client.send('Extensions.getExtensions', undefined, undefined, 1500)
      if (extensions.some((extension) => extension.id === IDENTITY_EXTENSION_ID))
        await ungroupIdentityTabs(client, controller.signal)
    })()
    try {
      await Promise.race([
        work,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            controller.abort()
            resolve()
          }, 3000)
        }),
      ])
    } catch (error) {
      this.deps.logger.warn('Não foi possível desfazer o grupo de abas antes de fechar', error)
    } finally {
      clearTimeout(timer)
      work.catch(() => undefined)
    }
  }
  /** Nome novo com o perfil aberto: grupo de abas, dica do ícone e barra de tarefas na hora. */
  refreshIdentity(id: string): void {
    const entry = this.entries.get(id)
    const profile = this.deps.profiles.get(id)
    if (!entry?.badge || !profile) return
    const label = identityLabel(profile)
    if (label === entry.badge.label) return
    entry.badge.label = label
    if (entry.badge.taskbar && entry.session.pid) this.deps.identity.windows.rename(entry.session.pid, label)
    const client = this.client(id)
    if (entry.badge.inBrowser && client) {
      void renameIdentity(client, label).catch((error: unknown) =>
        this.deps.logger.warn('Não foi possível renomear o grupo de abas do perfil', error),
      )
    }
  }
  private async attach(id: string, entry: Entry, client: CdpClient): Promise<void> {
    entry.stopTargets?.()
    entry.fingerprint?.stop()
    entry.stopPages?.()
    entry.client = client
    if (entry.session.fingerprintSnapshot) {
      const controller = new FingerprintController(
        client,
        entry.session.fingerprintSnapshot.effective,
        this.deps.logger,
        (error) => {
          entry.fingerprintError = error
          if (this.status(id) === 'running' && !entry.closing) {
            void this.stop(id)
              .then(() => this.set(id, 'error', this.payload(error)))
              .catch((stopError) =>
                this.deps.logger.error('Falha ao fechar perfil após erro no fingerprint', stopError),
              )
          }
        },
        { viewScale: entry.viewScale },
      )
      entry.fingerprint = controller
      await controller.start()
      entry.stopTargets = () => controller.stop()
    } else {
      // Sessões anteriores à Etapa 5 continuam sem alterações até reiniciar.
      entry.stopTargets = await trackTargets(client, this.deps.logger)
    }
    entry.stopPages = await rememberPages(client, this.deps.sessions, id, this.deps.logger)
    client.onClose(() => {
      // Sem a conexão a autoconfiguração não termina: fica para a próxima abertura.
      entry.extensionAbort?.abort()
      entry.stopTabs?.()
      entry.fingerprint?.stop()
      if (entry.closing || this.entries.get(id) !== entry) return
      this.set(id, 'disconnected', {
        code: 'BROWSER_DISCONNECTED',
        message: 'Verificando processo e tentando reconectar',
      })
      this.scheduleReconnect(id, entry)
    })
  }
  private scheduleReconnect(id: string, entry: Entry): void {
    clearTimeout(entry.reconnect)
    entry.reconnect = setTimeout(() => {
      void this.lock(id, () => this.reconnect(id, entry)).catch((error) => {
        this.deps.logger.warn('Falha na recuperação da conexão', error)
        if (!entry.closing && this.entries.get(id) === entry) this.scheduleReconnect(id, entry)
      })
    }, 1500)
  }
  private async reconnect(id: string, entry: Entry): Promise<void> {
    if (entry.closing || this.entries.get(id) !== entry) return
    if (!entry.identity || !(await identityStillMatches(entry.identity, entry.session.userDataDir))) {
      this.forget(id, entry)
      return
    }
    const abort = new AbortController()
    entry.reconnectAbort = abort
    try {
      const connected = await this.deps.engine(entry.browser).connect(entry.session.userDataDir, abort.signal)
      if (entry.closing) {
        connected.client.close()
        return
      }
      await this.attach(id, entry, connected.client)
      entry.session = {
        ...entry.session,
        phase: 'running',
        cdpPort: connected.port,
        wsEndpoint: connected.endpoint,
        engineVersion: connected.version.product,
      }
      this.deps.sessions.save(entry.session)
      this.set(id, 'running', null, true)
      this.deps.emit('fingerprint.changed', { profileId: id })
    } catch (error) {
      if (!entry.closing) {
        entry.session.phase = 'disconnected'
        this.deps.sessions.save(entry.session)
        this.set(id, 'disconnected', this.payload(error))
        this.scheduleReconnect(id, entry)
      }
    } finally {
      entry.reconnectAbort = undefined
    }
  }
  private requestStop(id: string): void {
    this.starts.get(id)?.controller.abort()
    const entry = this.entries.get(id)
    if (entry) {
      entry.closing = true
      clearTimeout(entry.reconnect)
      entry.reconnectAbort?.abort()
      entry.extensionAbort?.abort()
      entry.stopTabs?.()
    }
  }
  stop(id: string): Promise<void> {
    this.requestStop(id)
    return this.lock(id, () => this.stopEntry(id))
  }
  runIdle<T>(id: string, action: () => Promise<T> | T): Promise<T> {
    return this.lock(id, async () => {
      if (this.entries.has(id) || this.starts.has(id))
        throw new AppError('PROFILE_RUNNING', 'O perfil está aberto')
      return action()
    })
  }
  /**
   * Só dentro de runStopped/runIdle (o lock impede abrir o perfil ao mesmo tempo). Usa o navegador
   * do perfil: os cookies são cifrados por ele (o Chrome só decifra os dele).
   */
  async openOffline(id: string, signal?: AbortSignal): Promise<OfflineBrowser | null> {
    const directory = this.deps.files.directory(id)
    if (!fs.existsSync(directory)) return null
    const browser = this.deps.profiles.get(id)?.browser ?? 'brave'
    return this.deps.engine(browser).openOffline(directory, signal)
  }
  async runStopped<T>(id: string, action: () => Promise<T> | T): Promise<T> {
    this.requestStop(id)
    return this.lock(id, async () => {
      await this.stopEntry(id)
      await assertDirectoryIdle(this.deps.files.directory(id))
      return action()
    })
  }
  private async stopEntry(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (!entry) {
      this.set(id, 'stopped')
      return
    }
    entry.closing = true
    clearTimeout(entry.reconnect)
    entry.reconnectAbort?.abort()
    entry.extensionAbort?.abort()
    entry.stopTabs?.()
    entry.stopPages?.()
    entry.stopPages = undefined
    this.set(id, 'stopping')
    try {
      entry.identity ??= await recoverIdentity(entry.session)
      if (entry.identity && (await identityStillMatches(entry.identity, entry.session.userDataDir))) {
        await this.releaseTabGroups(entry)
        await entry.client?.send('Browser.close', undefined, undefined, 2000).catch(() => undefined)
        // Sem CDP (parada durante a inicialização) não há como pedir o fechamento ordenado:
        // espera pouco antes de encerrar o processo identificado como deste perfil.
        const graceMs = entry.client ? 10000 : 1500
        if (!(await waitForExit(entry.identity, entry.session.userDataDir, graceMs))) {
          await terminateOwnedProcess(entry.identity, entry.session.userDataDir)
          if (!(await waitForExit(entry.identity, entry.session.userDataDir, 5000)))
            throw new AppError('BROWSER_STOP_FAILED', 'O processo não encerrou')
        }
      }
      await assertDirectoryIdle(entry.session.userDataDir)
      this.forget(id, entry)
    } catch (error) {
      entry.closing = false
      this.set(id, 'disconnected', this.payload(error))
      this.scheduleReconnect(id, entry)
      throw error
    }
  }
  private forget(id: string, entry: Entry): void {
    entry.closing = true
    clearTimeout(entry.reconnect)
    entry.extensionAbort?.abort()
    entry.stopTabs?.()
    entry.stopPages?.()
    entry.stopTargets?.()
    entry.client?.close()
    if (entry.session.pid) this.deps.identity.windows.untrack(entry.session.pid)
    this.entries.delete(id)
    this.deps.sessions.delete(id)
    void this.deps.network.pool
      .close(id)
      .catch((error) => this.deps.logger.warn('Falha ao fechar o proxy local', error))
    // Sessão apagada: as pastas de extensão que só este perfil usava podem ser limpas.
    this.deps.extensions.released(id)
    this.set(id, 'stopped')
  }
  async stopAll(): Promise<void> {
    this.shuttingDown = true
    try {
      const results = await Promise.allSettled(
        [...new Set([...this.entries.keys(), ...this.starts.keys()])].map((id) => this.stop(id)),
      )
      const failed = results.find((r) => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    } finally {
      this.shuttingDown = false
    }
  }
  async recover(): Promise<void> {
    for (const session of this.deps.sessions.list()) {
      if (this.deps.files.directory(session.profileId) !== session.userDataDir)
        throw new AppError('IO_ERROR', 'Sessão aponta para uma pasta diferente do perfil')
      const identity = await recoverIdentity(session)
      if (!identity) {
        this.deps.sessions.delete(session.profileId)
        continue
      }
      const recovered = this.deps.profiles.get(session.profileId)
      const entry: Entry = {
        session: { ...session, pid: identity.pid, processStartedAt: identity.startedAt },
        browser: recovered?.browser ?? 'brave',
        identity,
        closing: false,
        // A extensão já está carregada no navegador sobrevivente; a barra de tarefas é reaplicada.
        badge: recovered ? this.prepareBadge(recovered)?.badge : undefined,
        viewScale: session.fingerprintSnapshot
          ? profileWindow(
              session.fingerprintSnapshot.effective,
              recovered?.launchOptions.window ?? null,
              this.deps.workArea?.() ?? null,
            ).scale
          : undefined,
      }
      this.entries.set(session.profileId, entry)
      this.trackWindows(entry)
      this.set(session.profileId, 'disconnected', null, true)
      if (session.proxyId && session.localProxyPort) {
        // O navegador sobreviveu à queda do Facet, mas o proxy local morreu junto: sem ele o
        // perfil está sem rede (falha fechada). Recria na mesma porta, que o navegador já usa.
        try {
          const upstream = this.deps.network.upstream(session.proxyId)
          await this.deps.network.pool.open(
            session.profileId,
            session.proxyId,
            upstreamUrl(upstream),
            session.localProxyPort,
          )
        } catch (error) {
          // Sem o proxy local o perfil não pode continuar aberto: a porta antiga poderia ser
          // ocupada depois pelo proxy local de outro perfil. Fecha com calma (pelo CDP, se
          // possível) e mostra o erro; as abas ficam salvas para a próxima abertura.
          this.deps.logger.error(
            'Não foi possível recriar o proxy local após a queda; fechando o perfil',
            error,
          )
          await this.reconnect(session.profileId, entry)
          try {
            await this.stopEntry(session.profileId)
            this.set(session.profileId, 'error', this.payload(error), true)
          } catch (stopError) {
            this.deps.logger.error('Falha ao fechar o perfil sem proxy local', stopError)
          }
          continue
        }
      }
      await this.reconnect(session.profileId, entry)
    }
  }
}
