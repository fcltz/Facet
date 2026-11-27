import { LIMITS } from '@shared/constants'
import { AppError } from '@shared/ipc/result'
import type { ExtensionStorageArea } from '@shared/schemas/extension'
import type { CdpClient } from '../browser/cdp/client'

function failed(message: string): AppError {
  return new AppError('EXTENSION_CONFIG_FAILED', message)
}

/** Espera `ms`, interrompida se o perfil fechar. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('CANCELLED', 'Perfil fechado'))
      return
    }
    const abort = (): void => {
      clearTimeout(timer)
      reject(new AppError('CANCELLED', 'Perfil fechado'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export interface ExtensionPage {
  sessionId: string
  close: () => Promise<void>
}

/**
 * Abre `chrome-extension://<id>/manifest.json` numa aba oculta (fora da barra de abas).
 * Qualquer página da extensão tem o chrome.storage dela, com ou sem service worker
 * ativo — verificado no Brave 158 com MV3, MV2 e extensões só de content script.
 */
export async function openExtensionPage(
  client: CdpClient,
  extensionId: string,
  signal?: AbortSignal,
): Promise<ExtensionPage> {
  const url = `chrome-extension://${extensionId}/manifest.json`
  let targetId: string
  try {
    ;({ targetId } = await client.send('Target.createTarget', { url, hidden: true, background: true }))
  } catch {
    // Sem abas ocultas (recurso experimental do CDP): aba em segundo plano, fechada logo depois.
    ;({ targetId } = await client.send('Target.createTarget', { url, background: true }))
  }
  const close = async (): Promise<void> => {
    await client.send('Target.closeTarget', { targetId }).catch(() => undefined)
  }
  try {
    const deadline = Date.now() + 5000
    for (;;) {
      signal?.throwIfAborted()
      const { targetInfo } = await client.send('Target.getTargetInfo', { targetId })
      if (targetInfo.url === url) break
      if (Date.now() >= deadline)
        throw failed('A página da extensão não abriu (ela está carregada no perfil?)')
      await pause(100, signal)
    }
    const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
    return { sessionId, close }
  } catch (error) {
    await close()
    throw error
  }
}

async function evaluate(
  client: CdpClient,
  sessionId: string,
  expression: string,
  signal?: AbortSignal,
): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted()
    try {
      const result = await client.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
        10_000,
      )
      if (result.exceptionDetails) {
        const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
        throw failed(`Erro no contexto da extensão: ${description}`)
      }
      return result.result.value
    } catch (error) {
      // O documento acabou de carregar: o contexto JS pode ainda não existir.
      const message = error instanceof Error ? error.message : String(error)
      if (attempt >= 10 || !/execution context/i.test(message)) throw error
      await pause(150, signal)
    }
  }
}

function storageArea(area: ExtensionStorageArea): string {
  return `globalThis.chrome && chrome.storage && chrome.storage[${JSON.stringify(area)}]`
}

const NO_STORAGE = 'NO_STORAGE'

function noStorage(): AppError {
  return failed('A extensão não tem acesso ao chrome.storage (permissão "storage")')
}

/** Grava as chaves do JSON (objeto) no chrome.storage da extensão; as demais chaves ficam. */
export async function writeStorage(
  client: CdpClient,
  sessionId: string,
  area: ExtensionStorageArea,
  json: string,
  signal?: AbortSignal,
): Promise<void> {
  // JSON.parse dentro da página (e não um literal): "__proto__" vira chave comum, como no JSON salvo.
  const expression = `(async () => {
    const area = ${storageArea(area)}
    if (!area) return ${JSON.stringify(NO_STORAGE)}
    await area.set(JSON.parse(${JSON.stringify(json)}))
    return 'OK'
  })()`
  if ((await evaluate(client, sessionId, expression, signal)) === NO_STORAGE) throw noStorage()
}

export async function readStorage(
  client: CdpClient,
  sessionId: string,
  area: ExtensionStorageArea,
  keys: string[] | null,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const expression = `(async () => {
    const area = ${storageArea(area)}
    if (!area) return ${JSON.stringify(NO_STORAGE)}
    return JSON.stringify(await area.get(${keys ? JSON.stringify(keys) : 'null'}))
  })()`
  const value = await evaluate(client, sessionId, expression, signal)
  if (value === NO_STORAGE) throw noStorage()
  if (typeof value !== 'string') throw failed('Resposta inesperada do chrome.storage')
  return JSON.parse(value) as Record<string, unknown>
}

/** JSON com chaves ordenadas: o chrome.storage não garante a ordem das chaves. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export interface ApplyOptions {
  signal?: AbortSignal
  /** Espera antes de conferir se a extensão sobrescreveu a configuração. */
  verifyDelayMs?: number
}

/**
 * Grava a configuração, espera e confere: se a extensão sobrescreveu as chaves durante a
 * própria inicialização (o Brave dispara onInstalled em toda abertura), grava de novo, uma vez.
 */
export async function applyConfig(
  client: CdpClient,
  extensionId: string,
  config: { area: ExtensionStorageArea; json: string },
  options: ApplyOptions = {},
): Promise<{ rewritten: boolean }> {
  const values = JSON.parse(config.json) as Record<string, unknown>
  const keys = Object.keys(values)
  const page = await openExtensionPage(client, extensionId, options.signal)
  try {
    await writeStorage(client, page.sessionId, config.area, config.json, options.signal)
    await pause(options.verifyDelayMs ?? 2000, options.signal)
    const stored = await readStorage(client, page.sessionId, config.area, keys, options.signal)
    const picked = Object.fromEntries(keys.filter((key) => key in stored).map((key) => [key, stored[key]]))
    if (canonicalJson(picked) === canonicalJson(values)) return { rewritten: false }
    await writeStorage(client, page.sessionId, config.area, config.json, options.signal)
    return { rewritten: true }
  } finally {
    await page.close()
  }
}

/** Lê todo o chrome.storage (área escolhida) de uma extensão num perfil aberto. */
export async function captureConfig(
  client: CdpClient,
  extensionId: string,
  area: ExtensionStorageArea,
  signal?: AbortSignal,
): Promise<{ json: string; keys: number }> {
  const page = await openExtensionPage(client, extensionId, signal)
  try {
    const values = await readStorage(client, page.sessionId, area, null, signal)
    const keys = Object.keys(values).length
    if (keys === 0) throw failed('A extensão não tem nada salvo nesta área do chrome.storage')
    const json = JSON.stringify(values, null, 2)
    if (json.length > LIMITS.extensionConfigMaxBytes) {
      throw failed('Os dados da extensão são grandes demais para a autoconfiguração')
    }
    return { json, keys }
  } finally {
    await page.close()
  }
}
