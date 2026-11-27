import type { Protocol } from 'devtools-protocol'
import type { CdpClient } from './cdp/client'
import type { SessionRepository } from '../repositories/sqlite/sessions'
import type { Logger } from '../logger'

export function isWebUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
/** Salva URLs após mudanças estáveis; fechamento em lote não sobrescreve o último conjunto com vazio. */
export async function rememberPages(
  client: CdpClient,
  repository: SessionRepository,
  profileId: string,
  logger: Logger,
): Promise<() => void> {
  const targets = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closing = false
  const save = (): void => {
    const urls = [...targets.values()].filter(isWebUrl).slice(0, 100)
    try {
      if (urls.length) repository.saveUrls(profileId, urls)
    } catch (error) {
      logger.error('Não foi possível salvar as URLs da sessão', profileId, error)
    }
  }
  const changed = (target: Protocol.Target.TargetInfo): void => {
    if (target.type !== 'page') return
    targets.set(target.targetId, target.url)
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!closing) save()
    }, 400)
  }
  const off = [
    client.on('Target.targetCreated', ({ targetInfo }) => changed(targetInfo)),
    client.on('Target.targetInfoChanged', ({ targetInfo }) => changed(targetInfo)),
    client.on('Target.targetDestroyed', ({ targetId }) => {
      targets.delete(targetId)
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!closing) save()
      }, 400)
    }),
    client.onClose(() => {
      closing = true
      clearTimeout(timer)
    }),
  ]
  try {
    await client.send('Target.setDiscoverTargets', { discover: true })
    for (const target of (await client.send('Target.getTargets', {})).targetInfos) changed(target)
  } catch (error) {
    closing = true
    clearTimeout(timer)
    off.forEach((unsubscribe) => unsubscribe())
    throw error
  }
  return () => {
    closing = true
    clearTimeout(timer)
    save()
    off.forEach((unsubscribe) => unsubscribe())
  }
}
