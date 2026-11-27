import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserKind } from '@shared/constants'
import { FACET_EXTENSION_ID } from '@shared/facet-extension'
import { AppError } from '@shared/ipc/result'
import { samePath } from './process'
import type { Logger } from '../logger'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function merge(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (object(value)) {
      if (!object(target[key])) target[key] = {}
      merge(target[key] as Record<string, unknown>, value)
    } else target[key] = value
  }
}
/**
 * Mescla `patch` nas preferências (objetos são mesclados; listas e valores, substituídos) e,
 * depois, aplica `edit` para o que precisa do valor atual (ex.: acrescentar a uma lista).
 */
export function patchPreferences(
  file: string,
  patch: Record<string, unknown>,
  logger: Logger,
  edit?: (current: Record<string, unknown>) => void,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!samePath(fs.realpathSync(path.dirname(file)), path.dirname(file))) {
    throw new AppError('IO_ERROR', 'A pasta de preferências não pode atravessar um link')
  }
  for (const target of [file, `${file}.facet-backup`]) {
    try {
      const stat = fs.lstatSync(target)
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new AppError('IO_ERROR', 'Arquivo de preferências inválido ou link')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  let current: Record<string, unknown> = {}
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8')
    fs.copyFileSync(file, `${file}.facet-backup`)
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!object(parsed)) throw new Error('JSON não é objeto')
      current = parsed
    } catch (error) {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`)
      logger.warn('Preferências inválidas preservadas antes de reconstruir', file, error)
    }
  }
  merge(current, patch)
  edit?.(current)
  const tmp = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(current), { encoding: 'utf8', flag: 'wx' })
  fs.renameSync(tmp, file)
}

/** Arquivos de sessão nativa do Chromium (pasta atual e nomes legados de versões antigas). */
const LEGACY_SESSION_FILES = ['Current Session', 'Current Tabs', 'Last Session', 'Last Tabs']

/**
 * Apaga a sessão nativa do perfil antes da abertura. As abas são restauradas pelo
 * Facet via CDP, depois que a conexão está pronta; se o Brave também restaurasse a
 * sessão (ao criar a primeira janela), cada aba apareceria em dobro. Não depende de
 * `session.restore_on_startup`, que é uma preferência protegida pelo Secure Preferences.
 * O histórico de navegação de cada aba não é preservado, como previsto no plano.
 */
export function clearNativeSession(directory: string): void {
  const profileDir = path.join(directory, 'Default')
  if (!fs.existsSync(profileDir)) return
  if (!samePath(fs.realpathSync(profileDir), profileDir)) {
    throw new AppError('IO_ERROR', 'A pasta do perfil não pode atravessar um link')
  }
  const removeFile = (file: string): void => {
    try {
      const stat = fs.lstatSync(file)
      if (stat.isFile() && !stat.isSymbolicLink()) fs.rmSync(file, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const sessionsDir = path.join(profileDir, 'Sessions')
  if (fs.existsSync(sessionsDir) && fs.lstatSync(sessionsDir).isDirectory()) {
    for (const name of fs.readdirSync(sessionsDir)) removeFile(path.join(sessionsDir, name))
  }
  for (const name of LEGACY_SESSION_FILES) removeFile(path.join(profileDir, name))
}

/**
 * Política de IP do WebRTC. Com proxy, `disable_non_proxied_udp` impede o STUN por
 * UDP direto, que vazava o IP público real (verificado no Brave 158); a flag
 * --force-webrtc-ip-handling-policy não tem efeito no Brave, por isso a preferência.
 */
export type WebrtcPolicy = 'default' | 'disable_non_proxied_udp'

export interface PreferenceOptions {
  /** Navegador do perfil: o Brave tem preferências próprias (P3A, Rewards, carteira, notícias). */
  browser?: BrowserKind
  webrtcPolicy?: WebrtcPolicy
  /** Brave: farbling de canvas, WebGL e áudio (`fingerprintingV2`). */
  farbling?: boolean
  blockGeolocation?: boolean
  /** Extensão de identificação do perfil: ícone fixado na barra de ferramentas. */
  identityExtensionId?: string | null
  /** Extensão Facet no perfil: ícone fixado depois do de identificação (false = desfixado). */
  facetExtension?: boolean
  /**
   * false = PDFs são baixados em vez de abertos (como no Chrome do Android): `navigator.plugins`
   * fica vazio e `navigator.pdfViewerEnabled` falso. true desfaz só o que o Facet mudou.
   */
  pdfViewer?: boolean
}

/** Preferências do Brave: avisos e serviços que não fazem sentido num perfil isolado. */
function braveLocalState(): Record<string, unknown> {
  // Aviso de dados anônimos (P3A) marcado como visto, com a coleta desligada: sem isso ele
  // aparece por cima da primeira aba de todo perfil novo (verificado no Brave 158).
  return { brave: { p3a: { enabled: false, notice_acknowledged: true } } }
}
function braveProfile(options: PreferenceOptions): Record<string, unknown> {
  return {
    profile: {
      default_content_setting_values: {
        ...(options.farbling !== undefined ? { fingerprintingV2: options.farbling ? 3 : 1 } : {}),
      },
    },
    brave: {
      rewards: { enabled: false, show_brave_rewards_button_in_location_bar: false },
      wallet: {
        show_wallet_icon_on_toolbar: false,
        should_show_wallet_suggestion_badge: false,
        default_wallet2: 0,
        default_solana_wallet: 0,
      },
      new_tab_page: { show_brave_news: false },
      today: { opted_in: false, should_show_toolbar_button: false },
      news: { opt_in_trial: false },
    },
  }
}

/** Marca (nas preferências do perfil) de que os PDFs passaram a ser baixados pelo Facet. */
const PDF_MARK = 'facet_pdf_download'

/** Somente na pasta gerenciada, com o processo fechado. Não altera Secure Preferences. */
export function preparePreferences(
  directory: string,
  languages: string[],
  logger: Logger,
  options: PreferenceOptions = {},
): void {
  const brave = options.browser === 'brave'
  const identity = options.identityExtensionId ?? null
  const pin = [...(identity ? [identity] : []), ...(options.facetExtension ? [FACET_EXTENSION_ID] : [])]
  const unpin = options.facetExtension ? [] : [FACET_EXTENSION_ID]
  const localState: Record<string, unknown> = { background_mode: { enabled: false } }
  if (brave) merge(localState, braveLocalState())
  patchPreferences(path.join(directory, 'Local State'), localState, logger)
  const profilePatch: Record<string, unknown> = {
    browser: { check_default_browser: false },
    // Grupos fechados com a janela viram "grupos salvos" (verificado no Brave 158): sem isso,
    // cada abertura deixaria uma cópia do grupo de identificação na barra de favoritos.
    ...(identity ? { bookmark_bar: { show_tab_groups: false } } : {}),
    intl: { accept_languages: languages.join(',') },
    ...(options.webrtcPolicy ? { webrtc: { ip_handling_policy: options.webrtcPolicy } } : {}),
    profile: {
      default_content_setting_values: {
        ...(options.blockGeolocation !== undefined ? { geolocation: options.blockGeolocation ? 2 : 3 } : {}),
      },
    },
  }
  // mescla profunda: o farbling do Brave fica junto da geolocalização em `profile`
  if (brave) merge(profilePatch, braveProfile(options))
  patchPreferences(path.join(directory, 'Default', 'Preferences'), profilePatch, logger, (current) => {
    pinExtensions(current, pin, unpin)
    setPdfViewer(current, options.pdfViewer)
  })
}

/** Liga ou desliga o visualizador de PDF; só desfaz a mudança que o próprio Facet fez. */
function setPdfViewer(preferences: Record<string, unknown>, viewer: boolean | undefined): void {
  if (viewer === undefined) return
  const plugins = object(preferences.plugins) ? preferences.plugins : {}
  if (!viewer) {
    preferences.plugins = { ...plugins, always_open_pdf_externally: true }
    preferences[PDF_MARK] = true
  } else if (preferences[PDF_MARK] === true) {
    preferences.plugins = { ...plugins, always_open_pdf_externally: false }
    delete preferences[PDF_MARK]
  }
}

/**
 * Fixa as extensões `pin`, nesta ordem, no início da barra de ferramentas e tira as `unpin`;
 * os ícones fixados pelo usuário continuam depois delas.
 */
export function pinExtensions(
  preferences: Record<string, unknown>,
  pin: readonly string[],
  unpin: readonly string[] = [],
): void {
  const current =
    object(preferences.extensions) && Array.isArray(preferences.extensions.pinned_extensions)
      ? (preferences.extensions.pinned_extensions as unknown[])
      : []
  const managed = new Set([...pin, ...unpin])
  // nada a fixar nem a tirar: as preferências ficam como estão
  if (pin.length === 0 && !current.some((value) => typeof value === 'string' && managed.has(value))) return
  if (!object(preferences.extensions)) preferences.extensions = {}
  const others = current.filter((value): value is string => typeof value === 'string' && !managed.has(value))
  ;(preferences.extensions as Record<string, unknown>).pinned_extensions = [...pin, ...others]
}
