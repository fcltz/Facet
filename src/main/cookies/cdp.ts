import type { Protocol } from 'devtools-protocol'
import { AppError } from '@shared/ipc/result'
import type { BrowserCookie, CookieFailure } from '@shared/schemas/cookies'
import type { CdpClient } from '../browser/cdp/client'

/** Cookies por chamada; um cookie inválido faz o Brave recusar o lote inteiro. */
const BATCH = 200
const TIMEOUT_MS = 15000

export function fromCdp(cookie: Protocol.Network.Cookie): BrowserCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.session || cookie.expires <= 0 ? null : cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite ?? null,
    partitionKey: cookie.partitionKey
      ? {
          topLevelSite: cookie.partitionKey.topLevelSite,
          hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor,
        }
      : null,
  }
}

/** Domínio sem ponto = cookie só do host; com ponto = do domínio (verificado no Brave 158). */
export function toCdp(cookie: BrowserCookie): Protocol.Network.CookieParam {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
    ...(cookie.expires !== null ? { expires: cookie.expires } : {}),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  }
}

/** Todos os cookies do contexto padrão do navegador, inclusive httpOnly e particionados. */
export async function readCookies(client: CdpClient): Promise<BrowserCookie[]> {
  const { cookies } = await client.send('Storage.getCookies', {}, undefined, TIMEOUT_MS)
  return cookies.map(fromCdp)
}

function disconnected(error: unknown): boolean {
  return error instanceof AppError && error.code === 'BROWSER_DISCONNECTED'
}

/** Grava em lotes; um lote recusado é refeito um a um para apontar qual cookie falhou. */
export async function writeCookies(
  client: CdpClient,
  cookies: readonly BrowserCookie[],
  signal?: AbortSignal,
): Promise<{ imported: number; failed: CookieFailure[] }> {
  let imported = 0
  const failed: CookieFailure[] = []
  for (let start = 0; start < cookies.length; start += BATCH) {
    signal?.throwIfAborted()
    const batch = cookies.slice(start, start + BATCH)
    try {
      await client.send('Storage.setCookies', { cookies: batch.map(toCdp) }, undefined, TIMEOUT_MS)
      imported += batch.length
      continue
    } catch (error) {
      if (disconnected(error)) throw error
    }
    for (const cookie of batch) {
      signal?.throwIfAborted()
      try {
        await client.send('Storage.setCookies', { cookies: [toCdp(cookie)] }, undefined, TIMEOUT_MS)
        imported++
      } catch (error) {
        if (disconnected(error)) throw error
        failed.push({
          name: cookie.name,
          domain: cookie.domain,
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
  return { imported, failed }
}
