import type { CdpClient } from './client'
import type { Logger } from '../../logger'
import type { Protocol } from 'devtools-protocol'

export interface TargetPreparation {
  prepare(sessionId: string, target: Protocol.Target.TargetInfo): Promise<void>
  failed(target: Protocol.Target.TargetInfo, error: unknown): void
  detached?(sessionId: string): void
}
export const FINGERPRINT_TARGET_FILTER: Protocol.Target.TargetFilter = [
  { type: 'page' },
  { type: 'iframe' },
  { type: 'worker' },
  { type: 'shared_worker' },
  { type: 'service_worker' },
  { exclude: true },
]

/** Prepara o ponto de aplicação futuro; todo target pausado é liberado, mesmo em falha. */
export async function trackTargets(
  client: CdpClient,
  logger: Logger,
  preparation?: TargetPreparation,
): Promise<() => void> {
  const off = client.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    void (async () => {
      try {
        if (['page', 'iframe', 'worker'].includes(targetInfo.type)) {
          await client.send(
            'Target.setAutoAttach',
            {
              autoAttach: true,
              waitForDebuggerOnStart: true,
              flatten: true,
              filter: FINGERPRINT_TARGET_FILTER,
            },
            sessionId,
          )
        }
        await preparation?.prepare(sessionId, targetInfo)
      } catch (error) {
        logger.warn('Não foi possível acompanhar targets relacionados', error)
        preparation?.failed(targetInfo, error)
      } finally {
        await client.send('Runtime.runIfWaitingForDebugger', undefined, sessionId).catch(() => undefined)
      }
    })()
  })
  const offDetached = client.on('Target.detachedFromTarget', ({ sessionId }) =>
    preparation?.detached?.(sessionId),
  )
  try {
    await client.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      filter: FINGERPRINT_TARGET_FILTER,
    })
    return () => {
      off()
      offDetached()
    }
  } catch (error) {
    off()
    offDetached()
    throw error
  }
}
