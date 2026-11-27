import type { Protocol } from 'devtools-protocol'
import { AppError } from '@shared/ipc/result'
import type { FingerprintConfig, FingerprintObservation } from '@shared/schemas/fingerprint'
import type { Logger } from '../../logger'
import type { CdpClient } from '../cdp/client'
import { trackTargets } from '../cdp/auto-attach'
import { applyFingerprint, geoPermission } from './apply'
import { OBSERVE_FINGERPRINT } from './scripts'

interface PreparedTarget {
  sessionId: string
  target: Protocol.Target.TargetInfo
  ready: Promise<void>
}

/** Quanto esperar o navegador deixar de listar um alvo cuja preparação falhou. */
const VANISH_WAIT_MS = 2000
/** Espera pela resposta do site numa navegação do Facet; depois, a aba segue carregando. */
const NAVIGATION_WAIT_MS = 5000
/** Prazo do pedido que segue em segundo plano depois da espera (só para o log). */
const NAVIGATION_REQUEST_MS = 60000

/** Uma instância por conexão, sempre usando a cópia da configuração da sessão. */
export class FingerprintController {
  private readonly targets = new Map<string, PreparedTarget>()
  private readonly failures = new Map<string, unknown>()
  private readonly warningSet = new Set<string>(['externalNavigation'])
  private off: (() => void) | undefined
  private closed = false
  private waiters = new Set<() => void>()

  constructor(
    private readonly client: CdpClient,
    private readonly config: FingerprintConfig,
    private readonly logger: Logger,
    private readonly fatal: (error: unknown) => void,
    private readonly options: { navigationWaitMs?: number; viewScale?: number } = {},
  ) {
    if (config.mode === 'emulated') this.warningSet.add('partialEmulation')
    // iPhone num motor Chromium: o que é próprio do WebKit não tem como ser imitado.
    if (config.mode === 'emulated' && config.os === 'ios') this.warningSet.add('iosEngine')
    if (config.webrtc.mode === 'disabled') this.warningSet.add('pageWebrtc')
  }
  async start(): Promise<void> {
    await this.client.send('Browser.setPermission', {
      permission: { name: 'geolocation' },
      setting: geoPermission(this.config),
    })
    this.off = await trackTargets(this.client, this.logger, {
      prepare: (sessionId, target) => {
        const ready = applyFingerprint(
          this.client,
          sessionId,
          target,
          this.config,
          (code) => this.warningSet.add(code),
          { viewScale: this.options.viewScale },
        )
        this.targets.set(target.targetId, { sessionId, target, ready })
        this.changed()
        return ready
      },
      failed: (target, error) => {
        void this.failed(target, error)
      },
      detached: (sessionId) => {
        for (const [id, entry] of this.targets) if (entry.sessionId === sessionId) this.targets.delete(id)
        this.changed()
      },
    })
  }
  /**
   * Um alvo que fechou durante a preparação (iframe removido logo depois de inserido, como os de
   * anúncios, ou pop-up fechado ao abrir) não tem o que proteger. Só uma falha num alvo que
   * continua vivo fecha o perfil (falha fechada).
   */
  private async failed(target: Protocol.Target.TargetInfo, error: unknown): Promise<void> {
    const gone = await this.vanished(target.targetId)
    if (gone) this.logger.debug('Alvo fechado durante a preparação do fingerprint', target.type)
    this.failures.set(
      target.targetId,
      gone ? new AppError('CANCELLED', 'A aba fechou durante a preparação do fingerprint') : error,
    )
    // Só as aberturas do Facet consultam (ready); numa sessão longa com muitos iframes de anúncio
    // que somem, guarda apenas as falhas recentes.
    for (const id of this.failures.keys()) {
      if (this.failures.size <= 100) break
      this.failures.delete(id)
    }
    this.changed()
    if (!gone && !this.closed) this.fatal(error)
  }
  /**
   * O navegador deixa de listar o alvo em até 500 ms (Brave 158 parado); com a máquina ocupada
   * (vários navegadores abrindo) leva mais, por isso a espera vai a 2 s antes de fechar o perfil.
   * Conexão perdida também conta como fechado.
   */
  private async vanished(targetId: string): Promise<boolean> {
    const deadline = Date.now() + VANISH_WAIT_MS
    for (;;) {
      const alive = await this.client.send('Target.getTargetInfo', { targetId }, undefined, 2000).then(
        () => true,
        () => false,
      )
      if (!alive) return true
      if (this.closed || Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  private changed(): void {
    for (const notify of this.waiters) notify()
  }
  stop(): void {
    this.closed = true
    this.off?.()
    this.changed()
  }
  warnings(): string[] {
    return [...this.warningSet]
  }

  async ready(targetId: string): Promise<string> {
    // acima do prazo de cada comando de preparação (PREPARE_TIMEOUT_MS)
    const deadline = Date.now() + 20000
    for (;;) {
      if (this.closed) throw new AppError('CANCELLED', 'Preparação do fingerprint interrompida')
      if (this.failures.has(targetId)) throw this.failures.get(targetId)
      const entry = this.targets.get(targetId)
      if (entry) {
        await entry.ready
        return entry.sessionId
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new AppError('FINGERPRINT_FAILED', 'O navegador não preparou a aba a tempo')
      await new Promise<void>((resolve) => {
        const notify = (): void => {
          clearTimeout(timer)
          this.waiters.delete(notify)
          resolve()
        }
        const timer = setTimeout(notify, Math.min(remaining, 100))
        this.waiters.add(notify)
      })
    }
  }
  async createPage(): Promise<string> {
    const { targetId } = await this.client.send('Target.createTarget', { url: 'about:blank' })
    await this.ready(targetId)
    return targetId
  }
  /**
   * O Page.navigate só responde quando o site responde (verificado no Brave 158: 7 s para um
   * servidor de 7 s, nada em 40 s para um travado). Site ou proxy lento não pode impedir o
   * perfil de abrir: depois de NAVIGATION_WAIT_MS a aba segue carregando e o resultado só
   * vai para o log. Um erro do próprio comando, antes disso, continua sendo erro.
   */
  async navigate(targetId: string, url: string): Promise<void> {
    const sessionId = await this.ready(targetId)
    const navigation = this.client.send('Page.navigate', { url }, sessionId, NAVIGATION_REQUEST_MS)
    let timer: ReturnType<typeof setTimeout> | undefined
    const waited = new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), this.options.navigationWaitMs ?? NAVIGATION_WAIT_MS)
    })
    try {
      const result = await Promise.race([navigation, waited])
      if (result !== 'pending') {
        if (result.errorText) this.logger.warn('Navegação inicial não terminou', result.errorText)
        return
      }
      this.logger.warn('O site ainda não respondeu; o perfil abre com a aba carregando')
      void navigation.then(
        (late) => {
          if (late.errorText) this.logger.warn('Navegação inicial não terminou', late.errorText)
        },
        () => undefined,
      )
    } finally {
      clearTimeout(timer)
    }
  }
  async observe(): Promise<FingerprintObservation[]> {
    const entries = [...this.targets.values()]
      .filter(
        (entry) =>
          !entry.target.url.startsWith('chrome-extension:') &&
          ['page', 'iframe', 'worker', 'shared_worker', 'service_worker'].includes(entry.target.type),
      )
      .slice(0, 12)
    const results = await Promise.allSettled(
      entries.map(async (entry) => {
        await entry.ready
        const result = await this.client.send(
          'Runtime.evaluate',
          {
            expression: OBSERVE_FINGERPRINT,
            returnByValue: true,
          },
          entry.sessionId,
          2000,
        )
        if (result.exceptionDetails || !result.result.value) throw new Error('Contexto indisponível')
        return {
          ...(result.result.value as Omit<FingerprintObservation, 'targetType'>),
          targetType: entry.target.type,
        }
      }),
    )
    return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
  }
}
