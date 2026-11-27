import { z } from 'zod'
import type { BrowserKind } from '../constants'
import { browserKindSchema } from './common'
import type { FingerprintCapabilities } from './fingerprint'

export const browserKindInputSchema = z.object({ kind: browserKindSchema })
export const browserPathSchema = z.object({
  kind: browserKindSchema,
  path: z.string().trim().min(1).max(4096),
})

/**
 * De onde veio o executável: `bundled` = o Ungoogled Chromium que vem com o Facet; `detected` =
 * instalação encontrada nesta máquina; `custom` = escolhido nas Configurações.
 */
export type BrowserSource = 'bundled' | 'detected' | 'custom'

export interface BrowserInfo {
  kind: BrowserKind
  /** Nome exibido ("Google Chrome"). */
  name: string
  available: boolean
  executablePath: string | null
  source: BrowserSource | null
  product: string | null
  userAgent: string | null
  profilesDir: string
  error: string | null
  /** Ainda procurando ou sondando o navegador (na abertura do app, ou ao trocar o executável). */
  checking: boolean
  fingerprintCapabilities?: FingerprintCapabilities
}

/** Navegadores suportados e o padrão dos perfis novos (Configurações → Navegadores). */
export interface BrowsersInfo {
  defaultBrowser: BrowserKind
  browsers: BrowserInfo[]
}
