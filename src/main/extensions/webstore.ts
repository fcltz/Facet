import { LIMITS, PREVIEW_ENGINE_MAJOR } from '@shared/constants'
import { AppError } from '@shared/ipc/result'

/** Serviço de atualização do Google: devolve o CRX assinado da extensão. */
export const DEFAULT_WEBSTORE_URL = 'https://clients2.google.com/service/update2/crx'

/** O download só pode passar por hosts do Google (o serviço redireciona para um CDN). */
const ALLOWED_SUFFIXES = ['google.com', 'googleusercontent.com', 'gvt1.com']
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

export interface WebStoreOptions {
  /** Endereço do serviço (servidor local nos testes). */
  baseUrl?: string
  /** Versão do Chromium enviada como prodversion: a loja entrega a versão compatível. */
  prodVersion: () => string
  timeoutMs?: number
  maxBytes?: number
}

function failed(message: string, reason: string): AppError {
  return new AppError('EXTENSION_DOWNLOAD_FAILED', message, { reason })
}

/** "Chrome/158.0.8127.92" → "158.0.8127.92" (sem o navegador detectado, usa a versão de referência). */
export function prodVersionFrom(product: string | null | undefined): string {
  const match = /(\d+\.\d+\.\d+\.\d+)/.exec(product ?? '')
  return match?.[1] ?? `${PREVIEW_ENGINE_MAJOR}.0.0.0`
}

export function webStoreDownloadUrl(base: string, id: string, prodVersion: string): string {
  const url = new URL(base)
  url.searchParams.set('response', 'redirect')
  url.searchParams.set('prodversion', prodVersion)
  url.searchParams.set('acceptformat', 'crx2,crx3')
  url.searchParams.set('x', `id=${id}&uc`)
  return url.href
}

function allowed(url: URL, base: URL): boolean {
  if (url.origin === base.origin) return true
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  return ALLOWED_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

export class WebStoreClient {
  constructor(private readonly options: WebStoreOptions) {}

  /** Baixa o CRX (só pelo IP desta máquina: não passa pelo proxy de nenhum perfil). */
  async download(id: string, signal?: AbortSignal): Promise<Buffer> {
    const base = new URL(this.options.baseUrl ?? DEFAULT_WEBSTORE_URL)
    const maxBytes = this.options.maxBytes ?? LIMITS.extensionArchiveMaxBytes
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 180_000)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const networkError = (error: unknown): AppError =>
      timeout.aborted
        ? failed('Tempo esgotado ao baixar da Chrome Web Store', 'webStoreTimeout')
        : signal?.aborted
          ? new AppError('CANCELLED', 'Download cancelado')
          : failed(
              `Sem conexão com a Chrome Web Store: ${error instanceof Error ? error.message : String(error)}`,
              'webStoreNetwork',
            )
    let url = new URL(webStoreDownloadUrl(base.href, id, this.options.prodVersion()))
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!allowed(url, base))
        throw failed('O download foi redirecionado para um endereço não permitido', 'webStoreRedirect')
      let response: Response
      try {
        response = await fetch(url, {
          redirect: 'manual',
          signal: combined,
          headers: { accept: 'application/x-chrome-extension,application/octet-stream;q=0.9,*/*;q=0.1' },
        })
      } catch (error) {
        throw networkError(error)
      }
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel().catch(() => undefined)
        if (!location) throw failed('Redirecionamento sem destino', 'webStoreRedirect')
        url = new URL(location, url)
        continue
      }
      if (response.status === 204 || response.status === 404) {
        await response.body?.cancel().catch(() => undefined)
        throw failed(
          'Extensão não encontrada na Chrome Web Store (ou indisponível para esta versão do navegador)',
          'webStoreNotFound',
        )
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw failed(`A Chrome Web Store respondeu ${response.status}`, 'webStoreHttp')
      }
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => undefined)
        throw failed('A extensão é grande demais', 'webStoreTooLarge')
      }
      const reader = response.body?.getReader()
      if (!reader) throw failed('A Chrome Web Store não enviou o arquivo', 'webStoreEmpty')
      const chunks: Buffer[] = []
      let total = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.length
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw failed('A extensão é grande demais', 'webStoreTooLarge')
          }
          chunks.push(Buffer.from(value))
        }
      } catch (error) {
        if (error instanceof AppError) throw error
        throw networkError(error)
      }
      if (total === 0) {
        throw failed(
          'Extensão não encontrada na Chrome Web Store (ou indisponível para esta versão do navegador)',
          'webStoreNotFound',
        )
      }
      return Buffer.concat(chunks)
    }
    throw failed('Redirecionamentos demais', 'webStoreRedirect')
  }
}
