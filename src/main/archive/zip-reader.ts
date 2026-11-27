import fs from 'node:fs'
import path from 'node:path'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import zlib from 'node:zlib'
import yauzl, { type Entry, type ZipFile } from 'yauzl'
import { AppError } from '@shared/ipc/result'

export interface ZipLimits {
  maxEntries: number
  maxTotalBytes: number
}

export interface UnpackResult {
  files: number
  bytes: number
}

/** Cria o erro do domínio (extensão, pacote de perfis, backup) com um motivo. */
export type InvalidZip = (message: string, reason?: string) => AppError

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
const FORBIDDEN_CHARS = /[<>:"|?*]/

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) if (value.charCodeAt(i) < 32) return true
  return false
}

const defaultInvalid: InvalidZip = (message, reason = 'package') =>
  new AppError('EXTENSION_INVALID', message, { reason })

/**
 * Nome relativo (com "/") de um arquivo do ZIP. Recusa caminhos absolutos, "..",
 * nomes reservados do Windows, caracteres proibidos e segmentos com ponto ou espaço no
 * fim (o Windows os removeria e dois nomes diferentes virariam o mesmo arquivo).
 */
export function validateEntryName(name: string, invalid: InvalidZip = defaultInvalid): string[] {
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name
  if (!trimmed || trimmed.startsWith('/') || /^[a-zA-Z]:/.test(trimmed) || trimmed.includes('\\')) {
    throw invalid(`Caminho inválido no pacote: ${name}`)
  }
  const segments = trimmed.split('/')
  for (const segment of segments) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      FORBIDDEN_CHARS.test(segment) ||
      hasControlChar(segment) ||
      WINDOWS_RESERVED.test(segment) ||
      /[. ]$/.test(segment)
    ) {
      throw invalid(`Caminho inválido no pacote: ${name}`)
    }
  }
  return segments
}

/** Conta bytes e calcula o CRC32 enquanto o arquivo é gravado. */
class Checked extends Transform {
  crc = 0
  bytes = 0
  constructor(private readonly onBytes: (count: number) => void) {
    super()
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length
    this.crc = zlib.crc32(chunk, this.crc)
    try {
      this.onBytes(chunk.length)
      callback(null, chunk)
    } catch (error) {
      callback(error as Error)
    }
  }
}

const OPTIONS = { lazyEntries: true, validateEntrySizes: true, decodeStrings: true, strictFileNames: false }

export function openZipBuffer(zip: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(zip, OPTIONS, (error, zipfile) => (error ? reject(error) : resolve(zipfile)))
  })
}

/** Abre do disco, sem carregar o arquivo inteiro (pacotes de perfis podem ter vários GB). */
export function openZipFile(file: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { ...OPTIONS, autoClose: false }, (error, zipfile) =>
      error ? reject(error) : resolve(zipfile),
    )
  })
}

export function openEntry(zipfile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)))
  })
}

export interface EntryVisit {
  entry: Entry
  /** Nome já conferido, em segmentos. */
  segments: string[]
  directory: boolean
}

/**
 * Percorre as entradas em ordem, conferindo quantidade, nomes, repetidos, links e senha.
 * `visit` é chamado uma vez por entrada e pode ler o conteúdo antes da próxima.
 */
export async function forEachEntry(
  zipfile: ZipFile,
  visit: (item: EntryVisit) => Promise<void>,
  options: { maxEntries: number; invalid: InvalidZip; signal?: AbortSignal },
): Promise<void> {
  const seen = new Set<string>()
  let entries = 0
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown): void => {
      reject(
        error instanceof AppError
          ? error
          : options.invalid(`ZIP inválido: ${error instanceof Error ? error.message : String(error)}`),
      )
    }
    zipfile.on('error', fail)
    zipfile.on('end', () => resolve())
    zipfile.on('entry', (entry: Entry) => {
      void (async () => {
        options.signal?.throwIfAborted()
        entries++
        if (entries > options.maxEntries) throw options.invalid('Pacote com arquivos demais', 'tooLarge')
        const segments = validateEntryName(entry.fileName, options.invalid)
        const key = segments.join('/').toLowerCase()
        if (seen.has(key)) throw options.invalid(`Arquivo repetido no pacote: ${entry.fileName}`)
        seen.add(key)
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if (mode === 0o120000) throw options.invalid(`Links simbólicos não são aceitos: ${entry.fileName}`)
        if (entry.isEncrypted()) throw options.invalid('ZIP protegido por senha não é suportado')
        await visit({ entry, segments, directory: entry.fileName.endsWith('/') })
        zipfile.readEntry()
      })().catch(fail)
    })
    zipfile.readEntry()
  })
}

/** Lê uma entrada pequena (manifesto, JSON) para a memória, com limite. */
export async function readEntryBuffer(
  zipfile: ZipFile,
  entry: Entry,
  maxBytes: number,
  invalid: InvalidZip,
): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes)
    throw invalid(`Arquivo grande demais no pacote: ${entry.fileName}`, 'tooLarge')
  const chunks: Buffer[] = []
  let size = 0
  const checked = new Checked((count) => {
    size += count
    if (size > maxBytes) throw invalid(`Arquivo grande demais no pacote: ${entry.fileName}`, 'tooLarge')
  })
  checked.on('data', (chunk: Buffer) => chunks.push(chunk))
  await pipeline(await openEntry(zipfile, entry), checked)
  if (checked.crc >>> 0 !== entry.crc32 >>> 0)
    throw invalid(`Arquivo corrompido no pacote: ${entry.fileName}`)
  return Buffer.concat(chunks)
}

/** Grava uma entrada num arquivo novo, conferindo o CRC32 e o orçamento de bytes. */
export async function extractEntry(
  zipfile: ZipFile,
  entry: Entry,
  destination: string,
  addBytes: (count: number) => void,
  invalid: InvalidZip,
): Promise<number> {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const checked = new Checked(addBytes)
  await pipeline(await openEntry(zipfile, entry), checked, fs.createWriteStream(destination, { flags: 'wx' }))
  if (checked.crc >>> 0 !== entry.crc32 >>> 0)
    throw invalid(`Arquivo corrompido no pacote: ${entry.fileName}`)
  return checked.bytes
}

/** Orçamento de bytes descompactados (proteção contra zip bomb). */
export function byteBudget(maxTotalBytes: number, invalid: InvalidZip): (count: number) => void {
  let total = 0
  return (count) => {
    total += count
    if (total > maxTotalBytes) throw invalid('Pacote grande demais depois de descompactado', 'tooLarge')
  }
}

/** Extrai tudo numa pasta vazia, com limites, nomes conferidos, links recusados e CRC32. */
export async function unpackAll(
  zipfile: ZipFile,
  target: string,
  limits: ZipLimits,
  invalid: InvalidZip,
): Promise<UnpackResult> {
  const root = path.resolve(target)
  let files = 0
  let bytes = 0
  const budget = byteBudget(limits.maxTotalBytes, invalid)
  await forEachEntry(
    zipfile,
    async ({ entry, segments, directory }) => {
      const destination = path.join(root, ...segments)
      if (!destination.startsWith(root + path.sep))
        throw invalid(`Caminho inválido no pacote: ${entry.fileName}`)
      if (directory) {
        fs.mkdirSync(destination, { recursive: true })
        return
      }
      if (entry.uncompressedSize > limits.maxTotalBytes - bytes)
        throw invalid('Pacote grande demais depois de descompactado', 'tooLarge')
      bytes += await extractEntry(zipfile, entry, destination, budget, invalid)
      files++
    },
    { maxEntries: limits.maxEntries, invalid },
  )
  return { files, bytes }
}
