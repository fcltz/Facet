import type { EmitFn } from '@shared/ipc/events'
import { AppError, type AppErrorPayload } from '@shared/ipc/result'
import type { ExtensionConfigMode } from '@shared/schemas/extension'
import type { Profile } from '@shared/schemas/profile'
import type { AppSettings } from '@shared/schemas/settings'
import type { CdpClient } from '../browser/cdp/client'
import type { Logger } from '../logger'
import type { ExtensionRow, Repositories } from '../repositories/types'
import { applyConfig, pause } from './autoconfig'
import { NO_STARTUP_TABS, StartupTabGuard, type StartupTabs } from './startup-tabs'
import type { ExtensionStore } from './store'

export type { StartupTabs } from './startup-tabs'

export interface LaunchExtension {
  id: string
  name: string
  /** `<id>/<pasta>`: registrado na sessão para a limpeza não apagar a pasta em uso. */
  dirKey: string
  /** Autoconfiguração a aplicar nesta abertura (null = nada a fazer). */
  config: { revision: number; mode: ExtensionConfigMode } | null
}

export interface ExtensionLaunch {
  items: LaunchExtension[]
  /** Caminhos absolutos para --load-extension. */
  directories: string[]
  dirKeys: string[]
  /** Alguma extensão é carregada pela primeira vez neste perfil. */
  firstLoad: boolean
}

export const NO_EXTENSIONS: ExtensionLaunch = { items: [], directories: [], dirKeys: [], firstLoad: false }

/** O que o launcher precisa das extensões em cada abertura de perfil. */
export interface RuntimeExtensions {
  /** Confere os arquivos e monta o --load-extension; lança EXTENSION_UNAVAILABLE. */
  prepare(profile: Profile): ExtensionLaunch
  /** Com o CDP conectado: confere se o navegador carregou tudo e começa a vigiar abas de boas-vindas. */
  afterConnect(
    profileId: string,
    client: CdpClient,
    launch: ExtensionLaunch,
    signal: AbortSignal,
  ): Promise<StartupTabs>
  /** Perfil rodando: registra a 1ª carga e aplica a autoconfiguração em segundo plano. */
  afterStart(profileId: string, client: CdpClient, launch: ExtensionLaunch, signal: AbortSignal): void
  /** O perfil fechou ou a abertura falhou: as pastas podem ser limpas. */
  released(profileId: string): void
}

export interface ExtensionTiming {
  /** Quanto esperar o navegador registrar as extensões depois de conectar. */
  verifyMs: number
  /** Espera antes de aplicar a configuração (a extensão termina de iniciar). */
  settleMs: number
  /** Espera antes de conferir se a extensão sobrescreveu a configuração. */
  configVerifyMs: number
  /** Por quanto tempo, depois de abrir, as abas de boas-vindas são fechadas. */
  startupWindowMs: number
}

export interface ExtensionRuntimeDeps {
  repos: Repositories
  store: ExtensionStore
  sessions: { list(): { extensionDirs: string[] | null }[] }
  settings: () => AppSettings
  emit: EmitFn
  logger: Logger
  now: () => number
  timing?: Partial<ExtensionTiming>
}

function payload(error: unknown): AppErrorPayload {
  return error instanceof AppError
    ? error.toPayload()
    : { code: 'EXTENSION_CONFIG_FAILED', message: error instanceof Error ? error.message : String(error) }
}

export class ExtensionRuntime implements RuntimeExtensions {
  /** Pastas de perfis abrindo ou abertos neste processo (antes mesmo de a sessão ser gravada). */
  private readonly active = new Map<string, string[]>()
  private readonly timing: ExtensionTiming

  constructor(private readonly deps: ExtensionRuntimeDeps) {
    this.timing = {
      verifyMs: 3000,
      settleMs: 1500,
      configVerifyMs: 2000,
      startupWindowMs: 10_000,
      ...deps.timing,
    }
  }

  prepare(profile: Profile): ExtensionLaunch {
    if (profile.extensionIds.length === 0) {
      this.active.delete(profile.id)
      return NO_EXTENSIONS
    }
    const { extensions } = this.deps.repos
    const rows = profile.extensionIds
      .map((id) => extensions.row(id))
      .filter((row): row is ExtensionRow => row !== null)
    const directories = this.deps.store.resolveForLaunch(rows)
    const state = new Map(extensions.profileState(profile.id).map((link) => [link.extensionId, link]))
    const items = rows.map((row): LaunchExtension => {
      const link = state.get(row.id)
      // "once": só enquanto este perfil não recebeu a configuração; "always": toda abertura.
      const pending = row.config && (row.config.mode === 'always' || link?.configRevision == null)
      return {
        id: row.id,
        name: row.name,
        dirKey: `${row.id}/${row.dirName}`,
        config: pending && row.config ? { revision: row.config.revision, mode: row.config.mode } : null,
      }
    })
    const launch: ExtensionLaunch = {
      items,
      directories,
      dirKeys: items.map((item) => item.dirKey),
      firstLoad: items.some((item) => !state.get(item.id)?.firstLoadedAt),
    }
    this.active.set(profile.id, launch.dirKeys)
    return launch
  }

  async afterConnect(
    _profileId: string,
    client: CdpClient,
    launch: ExtensionLaunch,
    signal: AbortSignal,
  ): Promise<StartupTabs> {
    if (launch.items.length === 0) return NO_STARTUP_TABS
    await this.verify(client, launch, signal)
    // Na 1ª abertura com uma extensão nova, a página de boas-vindas aparece normalmente.
    if (!this.deps.settings().closeExtensionStartupTabs || launch.firstLoad) return NO_STARTUP_TABS
    const guard = new StartupTabGuard(client, {
      windowMs: this.timing.startupWindowMs,
      logger: this.deps.logger,
    })
    try {
      await guard.start()
      return guard
    } catch (error) {
      guard.stop()
      this.deps.logger.warn('Não foi possível vigiar as abas abertas pelas extensões', error)
      return NO_STARTUP_TABS
    }
  }

  /** Extensions.getExtensions lista o que o navegador carregou; falta algo = falha fechada. */
  private async verify(client: CdpClient, launch: ExtensionLaunch, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.timing.verifyMs
    for (;;) {
      signal.throwIfAborted()
      let loaded: { id: string; enabled: boolean }[]
      try {
        loaded = (await client.send('Extensions.getExtensions', undefined)).extensions
      } catch (error) {
        // Comando experimental: sem ele não há como conferir, mas a abertura continua.
        this.deps.logger.warn(
          'O navegador não informou as extensões carregadas; seguindo sem conferir',
          error,
        )
        return
      }
      const enabled = new Set(
        loaded.filter((extension) => extension.enabled).map((extension) => extension.id),
      )
      const missing = launch.items.filter((item) => !enabled.has(item.id))
      if (missing.length === 0) return
      if (Date.now() >= deadline) {
        const names = missing.map((item) => item.name)
        throw new AppError(
          'EXTENSION_NOT_LOADED',
          `O navegador não carregou: ${names.join(', ')}. A versão do navegador pode ter recusado o pacote.`,
          { names, extensionIds: missing.map((item) => item.id) },
        )
      }
      // a primeira página espera por esta conferência: consulta de novo logo
      await pause(50, signal)
    }
  }

  afterStart(profileId: string, client: CdpClient, launch: ExtensionLaunch, signal: AbortSignal): void {
    if (launch.items.length === 0) return
    try {
      this.deps.repos.extensions.markLoaded(
        profileId,
        launch.items.map((item) => item.id),
        this.deps.now(),
      )
    } catch (error) {
      this.deps.logger.warn('Não foi possível registrar a carga das extensões', error)
    }
    const pending = launch.items.filter((item) => item.config)
    if (pending.length > 0) void this.applyAll(profileId, client, pending, signal)
  }

  private async applyAll(
    profileId: string,
    client: CdpClient,
    items: LaunchExtension[],
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await pause(this.timing.settleMs, signal)
    } catch {
      return
    }
    for (const item of items) {
      if (signal.aborted) return
      let error: unknown = null
      let revision = item.config?.revision ?? 0
      try {
        const config = this.deps.repos.extensions.config(item.id)
        if (!config) continue
        revision = config.revision
        await applyConfig(
          client,
          item.id,
          { area: config.area, json: config.json },
          { signal, verifyDelayMs: this.timing.configVerifyMs },
        )
      } catch (caught) {
        error = caught
      }
      // Perfil fechado no meio: tenta de novo na próxima abertura, sem acusar erro.
      if (signal.aborted) return
      const at = this.deps.now()
      try {
        this.deps.repos.extensions.markConfigResult(
          profileId,
          item.id,
          error ? { error: payload(error).message, at } : { revision, at },
        )
      } catch (dbError) {
        this.deps.logger.warn('Não foi possível registrar o resultado da autoconfiguração', dbError)
      }
      if (error) this.deps.logger.warn(`Autoconfiguração de ${item.name} falhou`, error)
      this.deps.emit('extensions.configResult', {
        profileId,
        extensionId: item.id,
        ok: !error,
        error: error ? payload(error) : null,
        at,
      })
    }
  }

  released(profileId: string): void {
    this.active.delete(profileId)
    this.collectGarbage()
  }

  /** Apaga pastas que nem a biblioteca, nem uma sessão gravada, nem um perfil abrindo usam. */
  collectGarbage(): number {
    try {
      const inUse = new Set(this.deps.repos.extensions.directories())
      for (const session of this.deps.sessions.list())
        for (const key of session.extensionDirs ?? []) inUse.add(key)
      for (const keys of this.active.values()) for (const key of keys) inUse.add(key)
      return this.deps.store.collectGarbage(inUse)
    } catch (error) {
      this.deps.logger.warn('Limpeza de pastas de extensão adiada', error)
      return 0
    }
  }
}
