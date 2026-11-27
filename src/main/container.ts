import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { join } from 'node:path'
import { PREVIEW_ENGINE_MAJOR } from '@shared/constants'
import { interfaceLanguageFor } from '@shared/schemas/settings'
import type { EmitFn } from '@shared/ipc/events'
import { AppError } from '@shared/ipc/result'
import type { Logger } from './logger'
import type { AppPaths } from './paths'
import { openDatabase } from './db/client'
import { createSqliteRepositories } from './repositories/sqlite'
import { SecretSettingsRepository } from './repositories/sqlite/secret-settings'
import { SessionRepository } from './repositories/sqlite/sessions'
import { BROWSER_KINDS } from '@shared/constants'
import { BrowserRegistry } from './browser/registry'
import { BrowserRuntime } from './browser/launcher'
import type { WindowSize } from './browser/window-size'
import { ProfileFiles } from './browser/profile-files'
import { ExtensionInstaller } from './extensions/installer'
import { ensureBuiltinFacet, settingsSeedMarker } from './extensions/builtin'
import { ExtensionRuntime, type ExtensionTiming } from './extensions/runtime'
import { ExtensionStore } from './extensions/store'
import { prodVersionFrom, WebStoreClient } from './extensions/webstore'
import { CheckLimiter, ProxyChecker } from './proxy/checker'
import { DEFAULT_TRACE_URL, GeoIpClient } from './proxy/geoip'
import { DEFAULT_REAL_IP_URLS, RealIpProbe } from './proxy/real-ip'
import { ProfileIdentityStore } from './identity/extension'
import { WindowIdentity } from './identity/window-identity'
import type { GeoProvider, GeoProviderId } from './proxy/geoip/providers'
import { ForwarderPool } from './proxy/pool'
import type { rotateIp } from './proxy/rotate'
import type { SecretBox } from './security/secrets'
import type { HostLocale } from './services/geo-sync'
import { ExtensionService } from './services/extension.service'
import { GroupService, TagService } from './services/group-tag.service'
import { ProfileService } from './services/profile.service'
import { FingerprintService } from './services/fingerprint.service'
import { ProxyService } from './services/proxy.service'
import { SettingsService } from './services/settings.service'
import { TrashService } from './services/trash.service'
import { CookieService, PendingCookieApplier } from './services/cookie.service'
import { JobRunner } from './jobs'
import { TransferService } from './services/transfer.service'
import { BackupService } from './services/backup.service'
import { BackupScheduler } from './backup/scheduler'
import { samePath } from './browser/process'
import { ProfilesRootService, relocationJournalFile, resumeRelocation } from './profiles-root/relocate'

/** Destinos de rede trocáveis nos testes (servidores locais em vez da internet). */
export interface NetworkOverrides {
  traceUrl?: string
  geoProviders?: Record<GeoProviderId, GeoProvider>
  rotate?: typeof rotateIp
  /** Serviço de download da Chrome Web Store. */
  webStoreUrl?: string
  /**
   * Trace consultado sem proxy para descobrir o IP real desta conexão. Com o trace trocado
   * por um servidor de teste, a comparação só liga se o teste indicar esta URL também.
   */
  realIpUrls?: string[]
  /** Validade da consulta do IP real (os testes usam 0 para trocar o "IP real" na hora). */
  realIpTtlMs?: number
}

export interface ContainerDeps {
  paths: AppPaths
  migrationsFolder: string
  emit: EmitFn
  logger: Logger
  hostTimezone: string
  /** Idiomas desta máquina, em ordem de preferência (perfis sem proxy em modo "auto"). */
  hostLanguages?: readonly string[]
  /** Cofre de segredos: `safeStorage` no app, uma versão falsa nos testes. */
  secrets: SecretBox
  network?: NetworkOverrides
  /** Esperas da conferência e da autoconfiguração das extensões (encurtadas nos testes). */
  extensionTiming?: Partial<ExtensionTiming>
  now?: () => number
  newId?: () => string
  /** Versão do app gravada nos pacotes e backups. */
  appVersion?: string
  /** Utilitário da barra de tarefas (Windows); null/ausente = sem botão próprio por perfil. */
  windowHelperPath?: string | null
  /** Comando de reabertura gravado nas janelas dos perfis (padrão: este executável). */
  relaunchCommand?: string
  /** Pasta da extensão Facet que vem com o app; ausente = sem extensão integrada (testes). */
  bundledExtensionDir?: string
  /** Executável do Ungoogled Chromium que vem com o app; ausente = sem ele (testes). */
  bundledBrowserPath?: string | null
  /** Área de trabalho do monitor principal (janelas dos celulares emulados). */
  workArea?: () => WindowSize | null
  /**
   * Na inicialização, o navegador padrão é sondado antes de a janela abrir; os outros, em seguida
   * e em segundo plano (`all`, o padrão). `default` sonda só o padrão (testes).
   */
  detectBrowsers?: 'all' | 'default'
}

/** Verificações de proxy simultâneas, somando todas as chamadas (plano: até 8). */
const MAX_PARALLEL_CHECKS = 8

export function createContainer(deps: ContainerDeps) {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomUUID
  const database = openDatabase(deps.paths.databaseFile, deps.migrationsFolder)
  try {
    if (database.brokenReferences > 0)
      deps.logger.error(`Banco com ${database.brokenReferences} referências quebradas após as migrations`)
    // Instalação nova: a tela de boas-vindas já abre no idioma do sistema, se o Facet tiver.
    const systemLanguage = interfaceLanguageFor(deps.hostLanguages ?? [])
    const repos = createSqliteRepositories(
      database,
      deps.paths.settingsFile,
      deps.secrets,
      systemLanguage ? { language: systemLanguage } : {},
    )
    const secretSettings = new SecretSettingsRepository(database.db, deps.secrets)
    const settings = new SettingsService({ repo: repos.settings, emit: deps.emit })
    // Mudança da pasta dos perfis interrompida (queda): termina ou desfaz antes de montar a raiz.
    resumeRelocation(
      relocationJournalFile(deps.paths),
      (root) => settings.setInternal({ profilesRoot: samePath(root, deps.paths.profilesDir) ? '' : root }),
      deps.logger,
    )
    const files = new ProfileFiles(settings.get().profilesRoot || deps.paths.profilesDir, [
      deps.paths.identityDir,
    ])
    files.recover((id) => repos.profiles.get(id) !== null)
    const sessions = new SessionRepository(database.db)
    const browsers = new BrowserRegistry({
      profilesDir: () => files.root,
      probeDir: join(deps.paths.userData, 'browser-probes'),
      settings: () => settings.get(),
      bundledUngoogled: deps.bundledBrowserPath ?? null,
      logger: deps.logger,
    })
    /** Versão do Chromium de referência: a do navegador padrão ou, sem ele, a de outro disponível. */
    const engineProduct = (): string | null => {
      const preferred = browsers.info(settings.get().defaultBrowser)
      if (preferred.product) return preferred.product
      return BROWSER_KINDS.map((kind) => browsers.info(kind).product).find(Boolean) ?? null
    }

    // Token do provedor de geo-IP: decifrado uma vez e mantido só neste processo.
    let cachedToken: string | null | undefined
    const geoIpToken = {
      configured: (): boolean => secretSettings.has('geoIpToken'),
      get: (): string | null => {
        if (cachedToken !== undefined) return cachedToken
        try {
          cachedToken = secretSettings.get('geoIpToken')
        } catch (error) {
          deps.logger.warn('Token de geo-IP ilegível; consultando sem token', error)
          cachedToken = null
        }
        return cachedToken
      },
      set: (token: string | null): void => {
        secretSettings.set('geoIpToken', token)
        cachedToken = token
      },
    }

    const hostLocale = (): HostLocale => ({
      timezone: deps.hostTimezone,
      languages: deps.hostLanguages?.length ? [...deps.hostLanguages] : ['en-US', 'en'],
    })
    const geo = new GeoIpClient({
      provider: () => settings.get().geoIpProvider,
      token: geoIpToken.get,
      providers: deps.network?.geoProviders,
      now,
    })
    const traceUrl = deps.network?.traceUrl ?? DEFAULT_TRACE_URL
    const realIp = new RealIpProbe({
      urls: deps.network?.realIpUrls ?? (deps.network?.traceUrl ? [] : DEFAULT_REAL_IP_URLS),
      ttlMs: deps.network?.realIpTtlMs,
      now,
      logger: deps.logger,
    })
    const checker = new ProxyChecker({ geo, traceUrl: () => traceUrl, logger: deps.logger, realIp, now })
    const limiter = new CheckLimiter(MAX_PARALLEL_CHECKS)
    const pool = new ForwarderPool({
      logger: deps.logger,
      onHealth: (profileId, health) =>
        deps.emit('runtime.proxyHealth', {
          profileId,
          failures: health.failures,
          lastError: health.lastError,
          at: health.lastErrorAt ?? now(),
        }),
      // gráfico de tráfego da coluna Proxy na aba Perfis
      onTraffic: (profileId, sample) =>
        deps.emit('runtime.traffic', {
          profileId,
          bytesPerSecond: sample.bytesPerSecond,
          total: sample.total,
          at: sample.at,
        }),
    })
    const proxies = new ProxyService({
      repos,
      checker,
      limiter,
      pool,
      emit: deps.emit,
      now,
      newId,
      hostLocale,
      logger: deps.logger,
      rotate: deps.network?.rotate,
    })
    const extensionStore = new ExtensionStore(deps.paths.extensionsDir, deps.logger)
    const installer = new ExtensionInstaller({
      store: extensionStore,
      webStore: new WebStoreClient({
        baseUrl: deps.network?.webStoreUrl,
        // a loja entrega a versão compatível com o Chromium do navegador padrão
        prodVersion: () => prodVersionFrom(engineProduct()),
      }),
    })
    const extensionRuntime = new ExtensionRuntime({
      repos,
      store: extensionStore,
      sessions,
      settings: () => settings.get(),
      emit: deps.emit,
      logger: deps.logger,
      now,
      timing: deps.extensionTiming,
    })
    const identityStore = new ProfileIdentityStore(deps.paths.identityDir, deps.logger)
    const windowIdentity = new WindowIdentity({
      helperPath: deps.windowHelperPath ?? null,
      logger: deps.logger,
    })
    const cookieApplier = new PendingCookieApplier({
      repo: repos.pendingCookies,
      emit: deps.emit,
      logger: deps.logger,
      now,
    })
    const runtime = new BrowserRuntime({
      engine: (kind) => browsers.get(kind),
      workArea: deps.workArea,
      files,
      sessions,
      profiles: repos.profiles,
      logger: deps.logger,
      emit: deps.emit,
      network: {
        pool,
        checker,
        upstream: (proxyId) => proxies.upstream(proxyId),
        resolveGeo: async (id, port, signal) => {
          const outcome = await proxies.checkPort(id, port, signal)
          // O trace da checagem anterior pode ter falhado: o geo-IP também detecta o IP real.
          if (outcome.error?.code === 'PROXY_REAL_IP') throw AppError.fromPayload(outcome.error)
          return outcome
        },
      },
      extensions: extensionRuntime,
      cookies: cookieApplier,
      hostLocale,
      startPage: () => settings.get().startPage,
      identity: {
        store: identityStore,
        windows: windowIdentity,
        settings: () => settings.get().profileIdentity,
        relaunchCommand: deps.relaunchCommand ?? `"${process.execPath}"`,
      },
    })
    const profiles = new ProfileService({
      repos,
      runtime,
      emit: deps.emit,
      now,
      newId,
      hostTimezone: deps.hostTimezone,
      engineMajor: PREVIEW_ENGINE_MAJOR,
      capabilities: (kind) => browsers.info(kind).fingerprintCapabilities,
      defaultBrowser: () => settings.get().defaultBrowser,
      language: () => settings.get().language,
      logger: deps.logger,
      hostLocale,
      requestProxyCheck: (proxyId) => {
        void proxies
          .check([proxyId])
          .catch((error: unknown) => deps.logger.warn('Verificação automática do proxy falhou', error))
      },
    })
    const trash = new TrashService({ repos, runtime, files, logger: deps.logger, emit: deps.emit, now })
    const fingerprint = new FingerprintService(browsers, runtime, () => repos.profiles.fingerprintUsage())
    const cookies = new CookieService({ repos, runtime, now, logger: deps.logger })
    const jobs = new JobRunner(deps.emit)
    const groups = new GroupService({ repos, emit: deps.emit, now, newId })
    const tags = new TagService({ repos, emit: deps.emit, now, newId })
    const extensions = new ExtensionService({
      repos,
      installer,
      store: extensionStore,
      collectGarbage: () => extensionRuntime.collectGarbage(),
      runtime,
      emit: deps.emit,
      now,
      logger: deps.logger,
    })
    const transfer = new TransferService({
      jobs,
      export: {
        repos,
        sessions,
        runtime,
        cookies,
        files,
        extensionStore,
        engineProduct,
        appVersion: deps.appVersion ?? '0.0.0',
        now,
        tempDir: deps.paths.tempDir,
      },
      import: {
        repos,
        sessions,
        files,
        profiles,
        groups,
        tags,
        proxies,
        extensions,
        engineProduct,
        emit: deps.emit,
        now,
        tempDir: deps.paths.tempDir,
        logger: deps.logger,
      },
    })
    const profilesRoot = new ProfilesRootService({
      files,
      settings,
      runtime,
      paths: deps.paths,
      jobs,
      logger: deps.logger,
      now,
    })
    const backup = new BackupService({
      paths: deps.paths,
      database,
      files,
      runtime,
      repos,
      appVersion: deps.appVersion ?? '0.0.0',
      now,
      jobs,
      settings,
      logger: deps.logger,
    })
    const scheduler = new BackupScheduler({
      settings,
      run: () => backup.runScheduled(),
      now,
      logger: deps.logger,
    })
    return {
      paths: deps.paths,
      scheduler,
      repos,
      database,
      runtime,
      files,
      sessions,
      browsers,
      pool,
      geoIpToken,
      extensionStore,
      extensionRuntime,
      jobs,
      identity: { store: identityStore, windows: windowIdentity },
      services: {
        profiles,
        trash,
        groups,
        tags,
        settings,
        proxies,
        extensions,
        fingerprint,
        cookies,
        transfer,
        profilesRoot,
        backup,
      },
      initialize: async () => {
        // Sobras de exportações e importações interrompidas (queda ou cancelamento).
        fs.rmSync(deps.paths.tempDir, { recursive: true, force: true, maxRetries: 2 })
        files.discardImportStaging()
        await runtime.recover()
        // depois da recuperação: perfis que sobreviveram à queda continuam com as pastas deles
        extensionStore.cleanStaging()
        extensionRuntime.collectGarbage()
        if (deps.bundledExtensionDir)
          await ensureBuiltinFacet({
            directory: deps.bundledExtensionDir,
            repos,
            service: extensions,
            store: extensionStore,
            seeded: settingsSeedMarker(database.db, now),
            logger: deps.logger,
          })
        // O padrão antes de a janela abrir; os outros em seguida, sem atrasar o início.
        const first = settings.get().defaultBrowser
        await browsers.detectAll([first])
        if (deps.detectBrowsers !== 'default')
          void browsers
            .detectAll(BROWSER_KINDS.filter((kind) => kind !== first))
            .then((infos) => deps.emit('browsers.changed', infos))
            .catch((error: unknown) => deps.logger.warn('Falha ao procurar os navegadores instalados', error))
      },
      /** O banco fecha na hora (antes do primeiro await); os proxies locais, em seguida. */
      close: async () => {
        scheduler.stop()
        proxies.cancelCheck()
        transfer.close()
        // o utilitário da barra de tarefas termina quando a entrada fecha
        windowIdentity.close()
        database.close()
        await pool.closeAll()
      },
    }
  } catch (error) {
    database.close()
    throw error
  }
}
export type Container = ReturnType<typeof createContainer>
