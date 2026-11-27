import { app, BrowserWindow, screen, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { APP_NAME } from '@shared/constants'
import type { Language } from '@shared/schemas/settings'

/** Mesmas cores de fundo do tema (globals.css), para não piscar branco ao abrir. */
export const WINDOW_BACKGROUND = { light: '#F7F8FB', dark: '#0B0D14' } as const

export interface MainWindowOptions {
  language: Language
  /** Primeira abertura: a interface começa pela tela de boas-vindas (sem piscar a principal). */
  welcome: boolean
  dark: boolean
  preloadPath: string
  indexHtmlPath: string
  devServerUrl?: string
}

function stripQueryAndHash(url: string): string {
  return url.split(/[?#]/)[0] ?? url
}

function sameFileUrl(a: string, b: string): boolean {
  const normalize = (u: string): string => decodeURIComponent(stripQueryAndHash(u)).toLowerCase()
  return normalize(a) === normalize(b)
}

function isAppUrl(url: string, options: Pick<MainWindowOptions, 'devServerUrl' | 'indexHtmlPath'>): boolean {
  try {
    if (options.devServerUrl) return new URL(url).origin === new URL(options.devServerUrl).origin
    return sameFileUrl(url, pathToFileURL(options.indexHtmlPath).href)
  } catch {
    return false
  }
}

function isSafeExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** Aceita IPC só da página do próprio app (dev server ou index.html empacotado). */
export function createSenderGuard(
  options: Pick<MainWindowOptions, 'devServerUrl' | 'indexHtmlPath'>,
): (event: IpcMainInvokeEvent) => boolean {
  return (event) => {
    const url = event.senderFrame?.url
    return typeof url === 'string' && url.length > 0 && isAppUrl(url, options)
  }
}

export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const minWidth = Math.min(1100, workAreaSize.width)
  const minHeight = Math.min(680, workAreaSize.height)

  const window = new BrowserWindow({
    width: Math.max(minWidth, Math.min(1440, workAreaSize.width - 60)),
    height: Math.max(minHeight, Math.min(900, workAreaSize.height - 60)),
    minWidth,
    minHeight,
    show: false,
    title: APP_NAME,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(app.getAppPath(), 'build', 'icon.png'),
    autoHideMenuBar: true,
    backgroundColor: options.dark ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      additionalArguments: [
        `--facet-language=${options.language}`,
        ...(options.welcome ? ['--facet-welcome'] : []),
      ],
    },
  })

  window.once('ready-to-show', () => window.show())

  // a janela nunca navega para fora do app; links externos abrem no navegador padrão
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url, options)) event.preventDefault()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // sem menu nativo no Windows/Linux: DevTools e recarregar só em desenvolvimento
  window.webContents.on('before-input-event', (event, input) => {
    if (app.isPackaged || input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    if (input.key === 'F12' || (input.control && input.shift && key === 'i')) {
      window.webContents.toggleDevTools()
      event.preventDefault()
    } else if (input.control && !input.shift && key === 'r') {
      window.webContents.reload()
      event.preventDefault()
    }
  })

  if (options.devServerUrl) void window.loadURL(options.devServerUrl)
  else void window.loadFile(options.indexHtmlPath)

  return window
}
