import path from 'node:path'
import { BROWSER_KINDS, type BrowserKind } from '@shared/constants'
import type { BrowserInfo, BrowsersInfo } from '@shared/schemas/browser'
import type { AppSettings } from '@shared/schemas/settings'
import { ChromiumEngine } from './chromium-engine'
import { createFlavors } from './flavors'
import type { Logger } from '../logger'

export interface BrowserRegistryOptions {
  /** Raiz atual das pastas de perfil. */
  profilesDir: () => string
  /** Pasta das sondagens; cada navegador usa uma subpasta própria. */
  probeDir: string
  settings: () => Pick<AppSettings, 'browserPaths' | 'defaultBrowser'>
  /** Executável do Ungoogled Chromium que vem com o Facet (null = sem ele, como nos testes). */
  bundledUngoogled: string | null
  logger: Logger
  timeoutMs?: number
}

/** Os navegadores suportados: um motor por navegador, com a sondagem e as aberturas dele. */
export class BrowserRegistry {
  private readonly engines: Record<BrowserKind, ChromiumEngine>
  constructor(private readonly options: BrowserRegistryOptions) {
    const flavors = createFlavors({ bundledUngoogled: options.bundledUngoogled })
    this.engines = Object.fromEntries(
      BROWSER_KINDS.map((kind) => [
        kind,
        new ChromiumEngine({
          flavor: flavors[kind],
          profilesDir: options.profilesDir,
          probeDir: path.join(options.probeDir, kind),
          getPath: () => options.settings().browserPaths[kind],
          logger: options.logger,
          timeoutMs: options.timeoutMs,
        }),
      ]),
    ) as Record<BrowserKind, ChromiumEngine>
  }
  get(kind: BrowserKind): ChromiumEngine {
    return this.engines[kind]
  }
  info(kind: BrowserKind): BrowserInfo {
    return this.engines[kind].info()
  }
  infos(): BrowsersInfo {
    return {
      defaultBrowser: this.options.settings().defaultBrowser,
      browsers: BROWSER_KINDS.map((kind) => this.engines[kind].info()),
    }
  }
  /** Procura e sonda os navegadores, um por vez, começando pelo padrão. */
  async detectAll(kinds: readonly BrowserKind[] = BROWSER_KINDS): Promise<BrowsersInfo> {
    const first = this.options.settings().defaultBrowser
    const ordered = [...kinds].sort((a, b) => Number(b === first) - Number(a === first))
    for (const kind of ordered) await this.engines[kind].detect()
    return this.infos()
  }
}
