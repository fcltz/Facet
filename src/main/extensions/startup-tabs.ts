import type { Protocol } from 'devtools-protocol'
import { FACET_EXTENSION_ID } from '@shared/facet-extension'
import type { CdpClient } from '../browser/cdp/client'
import type { Logger } from '../logger'

/** Abas que nunca são fechadas: nova aba, em branco (do próprio Brave) e DevTools. */
const NEVER_CLOSE =
  /^(about:blank|chrome:\/\/(newtab|new-tab-page)|brave:\/\/(newtab|new-tab-page)|devtools:)/i
/**
 * Páginas da Facet (o popup do ícone aparece como aba no CDP): ela nunca abre boas-vindas,
 * então qualquer página dela foi o usuário que abriu, mesmo nos primeiros segundos.
 */
const FACET_PAGES = `chrome-extension://${FACET_EXTENSION_ID}/`

export interface StartupTabs {
  /** Aba aberta pelo próprio Facet (páginas iniciais, abas restauradas). */
  keep(targetId: string): void
  /** O perfil está pronto: fecha as abas abertas pelas extensões até o fim da janela de inicialização. */
  arm(): void
  stop(): void
}

export const NO_STARTUP_TABS: StartupTabs = {
  keep: () => undefined,
  arm: () => undefined,
  stop: () => undefined,
}

/**
 * Com --load-extension o Brave trata as extensões como recém-instaladas a cada abertura,
 * e muitas abrem a página de boas-vindas de novo. Nos primeiros segundos, fecha as abas
 * que o Facet não abriu, que não têm opener (não vieram de um link ou popup) e que não
 * são "nova aba". Nunca fecha a última aba (o Brave fecharia a janela).
 */
export class StartupTabGuard implements StartupTabs {
  private readonly ours = new Set<string>()
  private readonly candidates = new Map<string, string>()
  private armed = false
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private offs: (() => void)[] = []
  /** Abas fechadas (exposto para testes e log). */
  closed = 0

  constructor(
    private readonly client: CdpClient,
    private readonly options: { windowMs: number; logger: Logger },
  ) {}

  async start(): Promise<void> {
    this.offs.push(
      this.client.on('Target.targetCreated', ({ targetInfo }) => this.seen(targetInfo)),
      this.client.on('Target.targetInfoChanged', ({ targetInfo }) => this.seen(targetInfo)),
      this.client.on('Target.targetDestroyed', ({ targetId }) => {
        this.candidates.delete(targetId)
      }),
    )
    await this.client.send('Target.setDiscoverTargets', { discover: true })
    for (const info of (await this.client.send('Target.getTargets', {})).targetInfos) this.seen(info)
  }

  private seen(info: Protocol.Target.TargetInfo): void {
    if (this.stopped || info.type !== 'page' || this.ours.has(info.targetId)) return
    // Aberta a partir de outra página (link, popup): não foi a extensão.
    if (info.openerId) {
      this.ours.add(info.targetId)
      this.candidates.delete(info.targetId)
      return
    }
    // Nova aba ou aba em branco: pode ser o usuário; mesmo se navegar depois, fica.
    if (NEVER_CLOSE.test(info.url) || info.url.startsWith(FACET_PAGES)) {
      this.ours.add(info.targetId)
      this.candidates.delete(info.targetId)
      return
    }
    this.candidates.set(info.targetId, info.url)
    if (this.armed) void this.sweep()
  }

  keep(targetId: string): void {
    this.ours.add(targetId)
    this.candidates.delete(targetId)
  }

  arm(): void {
    if (this.stopped) return
    this.armed = true
    this.timer = setTimeout(() => this.stop(), this.options.windowMs)
    void this.sweep()
  }

  private async sweep(): Promise<void> {
    const ids = [...this.candidates.keys()].filter((id) => !this.ours.has(id))
    if (ids.length === 0) return
    for (const id of ids) this.candidates.delete(id)
    let pages: string[]
    try {
      pages = (await this.client.send('Target.getTargets', {})).targetInfos
        .filter((target) => target.type === 'page')
        .map((target) => target.targetId)
    } catch {
      return
    }
    const present = ids.filter((id) => pages.includes(id))
    const others = pages.filter((id) => !present.includes(id))
    const toClose = others.length > 0 ? present : present.slice(1)
    for (const targetId of toClose) {
      try {
        await this.client.send('Target.closeTarget', { targetId })
        this.closed++
      } catch (error) {
        this.options.logger.warn('Não foi possível fechar uma aba aberta por extensão', error)
      }
    }
    if (toClose.length > 0)
      this.options.logger.info(`Abas de extensão fechadas ao iniciar: ${toClose.length}`)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    for (const off of this.offs) off()
    this.offs = []
    this.candidates.clear()
  }
}
