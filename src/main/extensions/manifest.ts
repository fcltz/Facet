import { createPublicKey, generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from '@shared/constants'
import { AppError } from '@shared/ipc/result'

export interface ManifestInfo {
  name: string
  version: string
  description: string
  manifestVersion: 2 | 3
  /** Permissões de API e acessos a sites (MV3: permissions + host_permissions). */
  permissions: string[]
  /** Ícone relativo à raiz da extensão. */
  iconPath: string | null
  /** `key` do manifest (SPKI em base64), se houver. */
  key: string | null
}

export interface ReadManifest {
  raw: Record<string, unknown>
  info: ManifestInfo
}

function invalid(message: string): AppError {
  return new AppError('EXTENSION_INVALID', message, { reason: 'manifest' })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * O Chrome aceita manifest com comentários e vírgula sobrando no fim de listas e
 * objetos. Remove os dois fora das strings antes do JSON.parse.
 */
export function relaxedJson(text: string): unknown {
  const source = text.replace(/^\uFEFF/, '')
  try {
    return JSON.parse(source)
  } catch {
    let out = ''
    let i = 0
    while (i < source.length) {
      const char = source[i]!
      if (char === '"') {
        let j = i + 1
        while (j < source.length && source[j] !== '"') j += source[j] === '\\' ? 2 : 1
        out += source.slice(i, j + 1)
        i = j + 1
      } else if (char === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i++
      } else if (char === '/' && source[i + 1] === '*') {
        const end = source.indexOf('*/', i + 2)
        i = end === -1 ? source.length : end + 2
      } else if (char === ',') {
        let j = i + 1
        while (j < source.length && /\s/.test(source[j]!)) j++
        if (source[j] !== '}' && source[j] !== ']') out += char
        i++
      } else {
        out += char
        i++
      }
    }
    return JSON.parse(out)
  }
}

/** Pasta que contém o manifest.json: a raiz do pacote ou uma única subpasta (ZIP de uma pasta). */
export function findManifestRoot(directory: string): string {
  if (fs.existsSync(path.join(directory, 'manifest.json'))) return directory
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.') && entry.name !== '__MACOSX')
  const only = entries.length === 1 ? entries[0] : undefined
  if (only?.isDirectory() && fs.existsSync(path.join(directory, only.name, 'manifest.json'))) {
    return path.join(directory, only.name)
  }
  throw invalid('manifest.json não encontrado no pacote')
}

/**
 * O Chrome recusa extensões descompactadas com arquivos ou pastas que começam com "_"
 * na raiz (reservados), exceto _locales. Remove-os: _metadata vem dos CRX da Web Store
 * e __MACOSX de ZIPs feitos no macOS.
 */
export function removeReservedEntries(root: string): string[] {
  const removed: string[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith('_') || entry.name === '_locales') continue
    fs.rmSync(path.join(root, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

const VERSION = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/

function validVersion(value: string): boolean {
  return VERSION.test(value) && value.split('.').every((part) => Number(part) <= 65535)
}

function messagesOf(root: string, locale: string): Map<string, string> {
  const file = path.join(root, '_locales', locale, 'messages.json')
  const messages = new Map<string, string>()
  let parsed: unknown
  try {
    parsed = relaxedJson(fs.readFileSync(file, 'utf8'))
  } catch {
    throw invalid(`Traduções inválidas ou ausentes em _locales/${locale}/messages.json`)
  }
  if (isObject(parsed)) {
    for (const [key, value] of Object.entries(parsed)) {
      if (isObject(value) && typeof value.message === 'string') messages.set(key.toLowerCase(), value.message)
    }
  }
  return messages
}

function localize(value: string, messages: Map<string, string> | null): string {
  return value.replace(
    /__MSG_([A-Za-z0-9_@]+)__/g,
    (_, key: string) => messages?.get(key.toLowerCase()) ?? '',
  )
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function pickIcon(raw: Record<string, unknown>): string | null {
  const candidates: Record<string, unknown>[] = []
  if (isObject(raw.icons)) candidates.push(raw.icons)
  for (const action of [raw.action, raw.browser_action, raw.page_action]) {
    if (!isObject(action)) continue
    if (typeof action.default_icon === 'string') return action.default_icon
    if (isObject(action.default_icon)) candidates.push(action.default_icon)
  }
  for (const icons of candidates) {
    const sizes = Object.entries(icons)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([size, file]) => ({ size: Number(size), file }))
      .filter((icon) => Number.isFinite(icon.size))
      .sort((a, b) => Math.abs(a.size - 48) - Math.abs(b.size - 48) || b.size - a.size)
    if (sizes[0]) return sizes[0].file
  }
  return null
}

function validKey(key: string): boolean {
  try {
    createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
    return true
  } catch {
    return false
  }
}

export function readManifest(root: string): ReadManifest {
  let raw: unknown
  try {
    raw = relaxedJson(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
  } catch (error) {
    if (error instanceof AppError) throw error
    throw invalid('manifest.json não é um JSON válido')
  }
  if (!isObject(raw)) throw invalid('manifest.json não é um objeto JSON')
  const manifestVersion = raw.manifest_version
  if (manifestVersion !== 2 && manifestVersion !== 3) {
    throw invalid('manifest_version ausente ou não suportado (use 2 ou 3)')
  }
  if ('app' in raw) throw invalid('Aplicativos do Chrome não são suportados, só extensões')
  if ('theme' in raw) throw invalid('Temas não são suportados, só extensões')
  const hasLocales = fs.existsSync(path.join(root, '_locales'))
  const defaultLocale = typeof raw.default_locale === 'string' ? raw.default_locale : null
  if (hasLocales && !defaultLocale)
    throw invalid('A extensão tem _locales, mas o manifest não define default_locale')
  if (defaultLocale && !hasLocales) throw invalid('default_locale definido, mas a pasta _locales não existe')
  const messages = defaultLocale ? messagesOf(root, defaultLocale) : null
  const name = typeof raw.name === 'string' ? localize(raw.name, messages).trim() : ''
  if (!name) throw invalid('O manifest não tem nome')
  const version = typeof raw.version === 'string' ? raw.version.trim() : ''
  if (!validVersion(version)) throw invalid(`Versão inválida no manifest: "${version}"`)
  const description =
    typeof raw.description === 'string' ? localize(raw.description, messages).trim().slice(0, 500) : ''
  const permissions = [
    ...new Set([
      ...strings(raw.permissions),
      ...(manifestVersion === 3 ? strings(raw.host_permissions) : []),
    ]),
  ]
  let key: string | null = null
  if (raw.key !== undefined) {
    if (typeof raw.key !== 'string' || !validKey(raw.key)) throw invalid('Campo "key" inválido no manifest')
    key = raw.key
  }
  return {
    raw,
    info: {
      name: name.slice(0, LIMITS.nameMax),
      version,
      description,
      manifestVersion,
      permissions,
      iconPath: pickIcon(raw),
      key,
    },
  }
}

/** Grava a `key` no manifest instalado (o ID passa a não depender da pasta). */
export function writeManifestKey(root: string, raw: Record<string, unknown>, key: string): void {
  if (raw.key === key) return
  const file = path.join(root, 'manifest.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ ...raw, key }, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * Dá ao service worker desta versão um arquivo de nome próprio (cópia ao lado do original).
 * Carregada de uma pasta nova com o mesmo arquivo do service worker, a extensão atualizada
 * lê o manifest novo, mas o Chromium continua executando o script antigo guardado no perfil
 * (verificado no Ungoogled 158: 1.1.1 → 1.2.0). Com outro nome, ele registra o novo.
 * Manifest ilegível ou caminho estranho: nada muda.
 */
export function uniqueServiceWorker(root: string, tag: string): void {
  const file = path.join(root, 'manifest.json')
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return
  }
  const background = raw.background as Record<string, unknown> | undefined
  const worker = background?.service_worker
  if (typeof worker !== 'string') return
  const relative = worker.replace(/^\.?\//, '')
  const source = path.resolve(root, relative)
  if (!source.startsWith(path.resolve(root) + path.sep) || !fs.existsSync(source)) return
  if (!/^[0-9a-z_-]+$/i.test(tag)) return
  const parsed = path.posix.parse(relative.replace(/\\/g, '/'))
  const renamed = path.posix.join(parsed.dir, `${parsed.name}.facet-${tag}${parsed.ext || '.js'}`)
  fs.copyFileSync(source, path.join(root, renamed))
  const tmp = `${file}.tmp`
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ ...raw, background: { ...background, service_worker: renamed } }, null, 2)}\n`,
    'utf8',
  )
  fs.renameSync(tmp, file)
}

/** Nova chave RSA-2048 (só a parte pública é usada: ela define o ID; nada é assinado). */
export function generatePublicKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

const ICON_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** Ícone como data URL (formatos que o Chrome aceita para ícones de extensão). */
export function readIcon(root: string, iconPath: string | null): string | null {
  if (!iconPath) return null
  const file = path.resolve(root, iconPath.replace(/^\/+/, ''))
  if (!file.startsWith(path.resolve(root) + path.sep)) return null
  const type = ICON_TYPES[path.extname(file).toLowerCase()]
  if (!type) return null
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > LIMITS.extensionIconMaxBytes) return null
    return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`
  } catch {
    return null
  }
}
