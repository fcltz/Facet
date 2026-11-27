import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod'
import type { BrowserInfo } from '@shared/schemas/browser'
import type { OsName } from '@shared/schemas/common'
import type { BrowserKind } from '@shared/constants'
import { PREVIEW_ENGINE_MAJOR } from '@shared/constants'
import {
  buildUaBrands,
  createDefaultFingerprint,
  type FingerprintCapabilities,
  type UaBrand,
} from '@shared/schemas/fingerprint'
import { AppError } from '@shared/ipc/result'
import type { CdpClient } from '../cdp/client'

export function hostOs(): OsName {
  return process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
}

/** O que o navegador acrescenta depois de "Safari/537.36" no User-Agent (Opera: " OPR/140.0.0.0"). */
export function userAgentSuffix(userAgent: string): string {
  return /Safari\/537\.36(.*)$/.exec(userAgent)?.[1] ?? ''
}

export function capabilitiesFor(
  info: Pick<BrowserInfo, 'product' | 'userAgent'>,
  extra: Partial<FingerprintCapabilities> = {},
): FingerprintCapabilities {
  const major = Number(/(?:Chrome|Chromium)\/(\d+)/.exec(info.product ?? '')?.[1])
  if (!Number.isInteger(major) || major < 100 || !info.userAgent)
    throw new AppError(
      'FINGERPRINT_UNSUPPORTED',
      'Não foi possível identificar a versão Chromium do navegador',
    )
  const nativeUserAgent = info.userAgent.replace('HeadlessChrome/', 'Chrome/')
  return {
    engineMajor: major,
    product: info.product!,
    hostOs: hostOs(),
    nativeUserAgent,
    uaSuffix: userAgentSuffix(nativeUserAgent),
    ...extra,
  }
}

/** Marca própria de cada navegador nas Client Hints (o Ungoogled Chromium não tem). */
const BRAND: Record<BrowserKind, string | null> = {
  ungoogled: null,
  chrome: 'Google Chrome',
  brave: 'Brave',
  opera: 'Opera',
}

/**
 * Marcas calculadas, para quando a sondagem não conseguiu lê-las. O Opera usa a versão dele
 * (do "OPR/140.0.0.0" do User-Agent) na marca "Opera", e não a do Chromium.
 */
export function fallbackBrands(
  kind: BrowserKind,
  capabilities: Pick<FingerprintCapabilities, 'engineMajor' | 'product' | 'uaSuffix'>,
): { brands: UaBrand[]; fullVersionList: UaBrand[] } {
  const full = /(?:Chrome|Chromium)\/([\d.]+)/.exec(capabilities.product)?.[1]
  const result = buildUaBrands(capabilities.engineMajor, full, BRAND[kind])
  const opera = kind === 'opera' ? /OPR\/(\d+)/.exec(capabilities.uaSuffix ?? '')?.[1] : undefined
  if (!opera) return result
  const swap = (list: UaBrand[], version: string): UaBrand[] =>
    list.map((brand) => (brand.brand === 'Opera' ? { brand: 'Opera', version } : brand))
  return {
    brands: swap(result.brands, opera),
    fullVersionList: swap(result.fullVersionList, `${opera}.0.0.0`),
  }
}

const brandsSchema = z.object({
  brands: z
    .array(z.object({ brand: z.string().min(1).max(100), version: z.string().min(1).max(50) }))
    .min(1)
    .max(5),
  fullVersionList: z
    .array(z.object({ brand: z.string().min(1).max(100), version: z.string().min(1).max(50) }))
    .min(1)
    .max(5),
})

/**
 * Marcas das Client Hints exatamente como o navegador as informa. `navigator.userAgentData` só
 * existe em contexto seguro: a sondagem abre uma página de um servidor local (127.0.0.1 é
 * seguro). Verificado no modo headless do Chrome, Brave, Opera e Ungoogled Chromium: as marcas
 * são as do navegador normal (o Brave informa a versão completa como "158.0.0.0").
 */
export async function readUaBrands(
  client: CdpClient,
  timeoutMs = 5000,
): Promise<{ brands: UaBrand[]; fullVersionList: UaBrand[] } | null> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end('<!doctype html><title>Facet</title>')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  let targetId: string | null = null
  try {
    const { port } = server.address() as AddressInfo
    targetId = (await client.send('Target.createTarget', { url: `http://127.0.0.1:${port}/` })).targetId
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const ready = await client
        .send(
          'Runtime.evaluate',
          {
            expression: `location.port === ${JSON.stringify(String(port))} && document.readyState === 'complete' && 'userAgentData' in navigator`,
            returnByValue: true,
          },
          sessionId,
          2000,
        )
        .catch(() => null)
      if (ready?.result.value === true) break
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const result = await client.send(
      'Runtime.evaluate',
      {
        expression: `navigator.userAgentData.getHighEntropyValues(['fullVersionList']).then((v) => ({ brands: v.brands, fullVersionList: v.fullVersionList }))`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
      timeoutMs,
    )
    const parsed = brandsSchema.safeParse(result.result.value)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  } finally {
    if (targetId) await client.send('Target.closeTarget', { targetId }).catch(() => undefined)
    server.close()
  }
}

/**
 * Antes de o navegador ser sondado (ou sem ele): versão de pré-visualização. Os rascunhos podem
 * ser gerados e salvos; UA e Client Hints são recalculados pela versão real em cada abertura.
 */
export function previewCapabilities(engineMajor = PREVIEW_ENGINE_MAJOR): FingerprintCapabilities {
  const os = hostOs()
  const base = createDefaultFingerprint({ os, engineMajor, timezone: 'UTC' })
  return {
    engineMajor,
    product: `Chrome/${engineMajor}.0.0.0`,
    hostOs: os,
    nativeUserAgent: base.userAgent,
    uaSuffix: '',
  }
}
