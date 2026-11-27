import { AppError } from '@shared/ipc/result'
import type { ProxyCheckOutcome } from '@shared/schemas/proxy'

export interface RotateOptions {
  changeIpUrl: string
  previousIp: string | null
  check: () => Promise<ProxyCheckOutcome>
  /** Quantas verificações esperar pelo IP novo (o provedor pode levar alguns segundos). */
  attempts?: number
  delayMs?: number
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Chama a URL de troca de IP do provedor (requisição direta, como os
 * provedores esperam) e verifica de novo até o IP de saída mudar.
 */
export async function rotateIp(
  options: RotateOptions,
): Promise<{ outcome: ProxyCheckOutcome; changed: boolean }> {
  let response: Response
  try {
    response = await fetch(options.changeIpUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      headers: { 'user-agent': 'Facet' },
    })
  } catch (error) {
    const timeout = error instanceof Error && error.name === 'TimeoutError'
    throw new AppError(
      'PROXY_ROTATE_FAILED',
      timeout ? 'A URL de troca de IP não respondeu a tempo' : 'Não foi possível chamar a URL de troca de IP',
    )
  }
  await response.body?.cancel().catch(() => undefined)
  if (!response.ok)
    throw new AppError('PROXY_ROTATE_FAILED', `A URL de troca de IP respondeu HTTP ${response.status}`)

  const sleep = options.sleep ?? defaultSleep
  const attempts = Math.max(1, options.attempts ?? 5)
  let outcome = await options.check()
  for (let attempt = 1; attempt < attempts; attempt++) {
    if (outcome.status === 'online' && outcome.exitIp && outcome.exitIp !== options.previousIp) break
    await sleep(options.delayMs ?? 3000)
    outcome = await options.check()
  }
  const changed =
    outcome.status === 'online' && outcome.exitIp !== null && outcome.exitIp !== options.previousIp
  return { outcome, changed }
}
