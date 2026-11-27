import { BROWSER_NAMES, type BrowserKind } from '@shared/constants'
import { installCandidates, operaBrowserExecutable } from './detect'

/** O que muda de um navegador Chromium para outro; o resto (CDP, perfil, proxy) é igual. */
export interface BrowserFlavor {
  kind: BrowserKind
  name: string
  /** Onde o navegador costuma estar, na ordem de preferência (o primeiro que existir vence). */
  candidates(): Promise<string[]>
  /** Executável que de fato abre o navegador (Opera: do lançador para a pasta da versão). */
  resolve(candidate: string): Promise<string>
  /**
   * `flag`: `--load-extension` (Brave, Opera e Ungoogled Chromium). `pipe`: o Chrome 137+ ignora
   * a flag; as extensões entram pelo comando `Extensions.loadUnpacked`, que só existe com
   * `--remote-debugging-pipe` e `--enable-unsafe-extension-debugging` (verificado no Chrome 158).
   */
  extensionLoading: 'flag' | 'pipe'
  /** Ruído nativo de canvas, WebGL e áudio (farbling do Brave, flags do Ungoogled Chromium). */
  nativeNoise: boolean
  /** Flags próprias de uma abertura com ou sem o ruído nativo. */
  args(options: { noise: boolean }): string[]
  /**
   * Mantém os cookies de sessão entre aberturas com `--restore-last-session` (como "continuar de
   * onde parou"; sem a flag, o Chromium os apaga ao abrir). Só onde foi verificado que as abas
   * antigas não voltam: no Ungoogled Chromium 158 elas não voltam (o Facet apaga a sessão nativa);
   * no Chrome 158 voltariam em dobro com as do Facet, e o Brave 158 ignora a flag para cookies. O
   * Opera 140 já mantém os cookies de sessão sozinho.
   */
  keepSessionCookies: boolean
}

/** Abre restaurando a sessão anterior: os cookies de sessão continuam valendo. */
export const RESTORE_SESSION_FLAG = '--restore-last-session'

/**
 * Flags de fingerprinting do Ungoogled Chromium (presentes no 158): ruído nos pixels lidos do
 * canvas, nas medidas de texto e nos retângulos dos elementos, com semente nova a cada abertura.
 */
const UNGOOGLED_NOISE_FLAGS = [
  '--fingerprinting-canvas-image-data-noise',
  '--fingerprinting-canvas-measuretext-noise',
  '--fingerprinting-client-rects-noise',
]

const same = (candidate: string): Promise<string> => Promise.resolve(candidate)

export function createFlavors(options: {
  /** Executável do Ungoogled Chromium que vem com o Facet; null = não empacotado (testes). */
  bundledUngoogled: string | null
}): Record<BrowserKind, BrowserFlavor> {
  return {
    ungoogled: {
      kind: 'ungoogled',
      name: BROWSER_NAMES.ungoogled,
      candidates: async () => (options.bundledUngoogled ? [options.bundledUngoogled] : []),
      resolve: same,
      extensionLoading: 'flag',
      nativeNoise: true,
      args: ({ noise }) => (noise ? UNGOOGLED_NOISE_FLAGS : []),
      keepSessionCookies: true,
    },
    chrome: {
      kind: 'chrome',
      name: BROWSER_NAMES.chrome,
      candidates: () => installCandidates('chrome'),
      resolve: same,
      extensionLoading: 'pipe',
      nativeNoise: false,
      args: () => [],
      keepSessionCookies: false,
    },
    brave: {
      kind: 'brave',
      name: BROWSER_NAMES.brave,
      candidates: () => installCandidates('brave'),
      resolve: same,
      extensionLoading: 'flag',
      // o farbling é uma preferência do perfil (ver preparePreferences), não uma flag
      nativeNoise: true,
      args: () => [],
      keepSessionCookies: false,
    },
    opera: {
      kind: 'opera',
      name: BROWSER_NAMES.opera,
      candidates: () => installCandidates('opera'),
      resolve: operaBrowserExecutable,
      extensionLoading: 'flag',
      nativeNoise: false,
      args: () => [],
      keepSessionCookies: false,
    },
  }
}
