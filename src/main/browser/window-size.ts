import { fingerprintDevice, type FingerprintConfig } from '@shared/schemas/fingerprint'

export interface WindowSize {
  width: number
  height: number
}

/** Janela padrão de um perfil de computador sem tamanho próprio. */
export const DEFAULT_WINDOW: WindowSize = { width: 1280, height: 800 }
/**
 * Moldura do Chromium no Windows a 100%: bordas e abas + barra de endereço (medido no Brave 158:
 * janela de 1280 × 800, página de 1264 × 711).
 */
export const WINDOW_FRAME: WindowSize = { width: 16, height: 89 }
/** Menor largura de janela que o Chromium aceita (medido no Ungoogled Chromium 158: 516 px). */
export const MIN_WINDOW_WIDTH = 516

export interface ProfileWindow {
  window: WindowSize
  /** Escala visual da página do celular (1 = tamanho real; menor quando a janela não cabe). */
  scale: number
}

/**
 * Janela do perfil. No computador: a das opções do perfil ou a padrão. No celular a página tem o
 * tamanho do aparelho (a emulação fixa a largura e a altura), então a janela vem do aparelho; se
 * ela não couber na área de trabalho desta máquina, a imagem da página é reduzida (só visual).
 */
export function profileWindow(
  config: FingerprintConfig,
  requested: WindowSize | null,
  workArea: WindowSize | null,
): ProfileWindow {
  const device = config.mode === 'emulated' ? fingerprintDevice(config) : null
  if (!device) return { window: requested ?? { ...DEFAULT_WINDOW }, scale: 1 }
  const viewport = { width: device.screen.width, height: device.viewportHeight }
  let window = requested ?? {
    width: Math.max(viewport.width + WINDOW_FRAME.width, MIN_WINDOW_WIDTH),
    height: viewport.height + WINDOW_FRAME.height,
  }
  if (workArea)
    window = {
      width: Math.min(window.width, workArea.width),
      height: Math.min(window.height, workArea.height),
    }
  const fit = Math.min(
    1,
    (window.height - WINDOW_FRAME.height) / viewport.height,
    (window.width - WINDOW_FRAME.width) / viewport.width,
  )
  return { window, scale: Math.max(0.25, Math.floor(fit * 100) / 100) }
}
