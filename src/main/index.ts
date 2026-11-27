import { app, BrowserWindow, dialog, Menu, nativeTheme, safeStorage, screen } from 'electron'
import { join } from 'node:path'
import { APP_DATA_DIRECTORY, APP_NAME, APP_USER_MODEL_ID } from '@shared/constants'
import { acceptLanguagesFrom } from '@shared/data/country-locales'
import { createContainer, type NetworkOverrides } from './container'
import { emit } from './ipc/emit'
import { appHandlers } from './ipc/handlers/app'
import { browserHandlers } from './ipc/handlers/browser'
import { extensionHandlers } from './ipc/handlers/extensions'
import { groupHandlers } from './ipc/handlers/groups'
import { profileHandlers } from './ipc/handlers/profiles'
import { proxyHandlers } from './ipc/handlers/proxies'
import { settingsHandlers } from './ipc/handlers/settings'
import { tagHandlers } from './ipc/handlers/tags'
import { registerIpcHandlers, type HandlerMap } from './ipc/register'
import { fingerprintHandlers } from './ipc/handlers/fingerprint'
import { cookieHandlers } from './ipc/handlers/cookies'
import { transferHandlers } from './ipc/handlers/transfer'
import { backupHandlers } from './ipc/handlers/backup'
import { applyPendingRestore } from './backup/restore'
import { createLogger } from './logger'
import { ensureBaseDirs, resolveAppPaths } from './paths'
import { GEO_PROVIDERS, type GeoProvider, type GeoProviderId } from './proxy/geoip/providers'
import { createSafeStorageBox } from './security/secrets'
import { createMainWindow, createSenderGuard, WINDOW_BACKGROUND } from './window'

// permite isolar os dados (testes E2E, múltiplos ambientes); precisa vir antes do lock
const userDataOverride = process.env.FACET_USER_DATA_DIR
app.setName(APP_NAME)
app.setPath('userData', userDataOverride || join(app.getPath('appData'), APP_DATA_DIRECTORY))

/**
 * Só fora do app empacotado: os testes E2E trocam o trace da Cloudflare, os
 * provedores de geo-IP, a Chrome Web Store e o trace direto (IP real desta conexão)
 * por servidores locais (nenhum teste depende da internet).
 */
function testNetworkOverrides(): NetworkOverrides | undefined {
  if (app.isPackaged) return undefined
  const traceUrl = process.env.FACET_TEST_TRACE_URL
  const geoUrl = process.env.FACET_TEST_GEOIP_URL
  const webStoreUrl = process.env.FACET_TEST_WEBSTORE_URL
  const realIpUrl = process.env.FACET_TEST_REAL_IP_URL
  if (!traceUrl && !geoUrl && !webStoreUrl && !realIpUrl) return undefined
  const realIpUrls = realIpUrl ? [realIpUrl] : undefined
  if (!geoUrl) return { traceUrl, webStoreUrl, realIpUrls }
  const local = (provider: GeoProvider): GeoProvider => ({ ...provider, url: () => geoUrl })
  const { ipwhois, geojs, ipinfo, ipapi } = GEO_PROVIDERS
  const geoProviders: Record<GeoProviderId, GeoProvider> = {
    ipwhois: local(ipwhois),
    geojs: local(geojs),
    ipinfo: local(ipinfo),
    ipapi: local(ipapi),
  }
  return { traceUrl, geoProviders, webStoreUrl, realIpUrls }
}

/** Executável do Ungoogled Chromium empacotado (só no Windows); null = não há. */
function bundledBrowserPath(): string | null {
  if (process.platform !== 'win32') return null
  const override = app.isPackaged ? undefined : process.env.FACET_TEST_BUNDLED_BROWSER
  if (override) return override === 'none' ? null : override
  return app.isPackaged
    ? join(process.resourcesPath, 'browsers', 'ungoogled-chromium', 'chrome.exe')
    : join(app.getAppPath(), 'vendor', 'ungoogled-chromium', 'chrome.exe')
}

async function bootstrap(): Promise<void> {
  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  await app.whenReady()
  if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID)
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

  const paths = resolveAppPaths(app.getPath('userData'))
  ensureBaseDirs(paths)
  const logger = createLogger({ dir: paths.logsDir, mirrorToConsole: !app.isPackaged })
  process.on('uncaughtException', (error) => logger.error('uncaughtException', error))
  process.on('unhandledRejection', (reason) => logger.error('unhandledRejection', reason))
  logger.info(`${APP_NAME} ${app.getVersion()} iniciando (Electron ${process.versions.electron})`)

  // Restauração de backup preparada antes do reinício: troca os dados antes de abrir o banco.
  try {
    applyPendingRestore(paths, logger)
  } catch (error) {
    logger.error('Falha ao aplicar a restauração do backup', error)
    dialog.showErrorBox(
      `${APP_NAME}: restauração do backup`,
      `A restauração não terminou e será tentada de novo no próximo início.

${error instanceof Error ? error.message : String(error)}`,
    )
    // Não abra ou modifique um banco parcialmente restaurado. O journal será retomado no próximo início.
    app.exit(1)
    return
  }

  const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const migrationsFolder = app.isPackaged
    ? join(process.resourcesPath, 'drizzle')
    : join(app.getAppPath(), 'drizzle')
  const container = createContainer({
    paths,
    migrationsFolder,
    emit,
    logger,
    hostTimezone,
    hostLanguages: acceptLanguagesFrom(app.getPreferredSystemLanguages()),
    secrets: createSafeStorageBox(safeStorage),
    network: testNetworkOverrides(),
    appVersion: app.getVersion(),
    // Fora do app empacotado, os testes E2E trocam a pasta por uma cópia sem acesso à internet.
    bundledExtensionDir: app.isPackaged
      ? join(process.resourcesPath, 'facet-extension')
      : (process.env.FACET_TEST_BUILTIN_EXTENSION_DIR ??
        join(app.getAppPath(), 'resources', 'facet-extension')),
    // Ungoogled Chromium que vem com o Facet (scripts/fetch-ungoogled-chromium.mjs); os testes E2E
    // podem apontar outro executável ou nenhum ("none").
    bundledBrowserPath: bundledBrowserPath(),
    // Janela dos celulares emulados: do tamanho do aparelho, sem passar da área de trabalho.
    workArea: () => {
      const { width, height } = screen.getPrimaryDisplay().workAreaSize
      return { width, height }
    },
    // Botão próprio por perfil na barra de tarefas: utilitário compilado no build (só Windows).
    windowHelperPath:
      process.platform === 'win32'
        ? app.isPackaged
          ? join(process.resourcesPath, 'facet-win-helper.exe')
          : join(app.getAppPath(), 'build', 'facet-win-helper.exe')
        : null,
  })
  await container.initialize()
  container.scheduler.start()
  const { settings } = container.services

  /** Depois de preparar uma restauração: fecha tudo e reabre (nos testes E2E, só fecha). */
  const restartForRestore = (): void => {
    void (async () => {
      try {
        await container.runtime.stopAll()
        await container.close()
      } catch (error) {
        logger.error('Falha ao encerrar antes de reiniciar para restaurar', error)
      }
      if (app.isPackaged || !process.env.FACET_E2E_NO_RELAUNCH) app.relaunch()
      app.exit(0)
    })()
  }

  // o tema nativo faz o `prefers-color-scheme` do renderer seguir a configuração
  nativeTheme.themeSource = settings.get().theme
  settings.onChange((next) => {
    nativeTheme.themeSource = next.theme
  })
  nativeTheme.on('updated', () => {
    const color = nativeTheme.shouldUseDarkColors ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light
    for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(color)
  })

  const handlers: HandlerMap = {
    ...fingerprintHandlers(container),
    ...appHandlers(hostTimezone),
    ...browserHandlers(container),
    ...settingsHandlers(container),
    ...profileHandlers(container),
    ...groupHandlers(container),
    ...tagHandlers(container),
    ...proxyHandlers(container),
    ...extensionHandlers(container),
    ...cookieHandlers(container),
    ...transferHandlers(container),
    ...backupHandlers(container, { restart: restartForRestore }),
  }

  const preloadPath = join(__dirname, '../preload/index.js')
  const indexHtmlPath = join(__dirname, '../renderer/index.html')
  const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
  registerIpcHandlers(handlers, {
    logger,
    isTrustedSender: createSenderGuard({ devServerUrl, indexHtmlPath }),
  })

  const openMainWindow = (): void => {
    mainWindow = createMainWindow({
      language: settings.get().language,
      welcome: !settings.get().onboardingCompleted,
      dark: nativeTheme.shouldUseDarkColors,
      preloadPath,
      indexHtmlPath,
      devServerUrl,
    })
    mainWindow.on('closed', () => {
      mainWindow = null
    })
  }
  openMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  // perfis abertos são fechados com calma antes de o app sair
  let stoppingProfiles = false
  let shutdownComplete = false
  app.on('before-quit', (event) => {
    if (shutdownComplete) return
    event.preventDefault()
    if (stoppingProfiles) return
    stoppingProfiles = true
    logger.info('Fechando perfis abertos antes de sair')
    void container.runtime
      .stopAll()
      .then(() => container.close())
      .then(() => {
        shutdownComplete = true
        app.quit()
      })
      .catch((error: unknown) => {
        stoppingProfiles = false
        logger.error('Falha ao encerrar perfis; aplicativo permanece aberto', error)
        if (BrowserWindow.getAllWindows().length === 0) openMainWindow()
        dialog.showErrorBox(APP_NAME, error instanceof Error ? error.message : String(error))
      })
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  bootstrap().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    dialog.showErrorBox(`${APP_NAME}: falha ao iniciar`, message)
    app.exit(1)
  })
}
