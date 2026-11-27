import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'

/** Decide o que entra: segmentos relativos à raiz e se é pasta. */
export type DirectoryFilter = (segments: readonly string[], isDirectory: boolean) => boolean

export interface DirectoryAdded {
  files: number
  bytes: number
  /** Resolve quando o último arquivo da pasta já foi lido para o ZIP (a pasta pode mudar depois). */
  done: Promise<void>
}

interface Destroyable {
  destroy(error?: Error): void
}

/**
 * ZIP gravado em fluxo (Zip64 automático) num arquivo `.partial` ao lado do destino; só
 * ganha o nome final em `finish()`. Cancelar ou falhar apaga o parcial.
 */
export class ZipWriter {
  private readonly zip = new ZipFile()
  private readonly partial: string
  private readonly written: Promise<void>
  private failure: unknown = null
  private settled = false
  /** Arquivos ainda não lidos: rejeitados se o ZIP falhar ou for cancelado antes. */
  private readonly unread = new Set<(error: unknown) => void>()

  constructor(
    readonly file: string,
    private readonly signal?: AbortSignal,
  ) {
    this.partial = `${file}.partial`
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.rmSync(this.partial, { force: true })
    this.zip.on('error', (error: unknown) => {
      this.failure ??= error
      ;(this.zip.outputStream as unknown as Destroyable).destroy(
        error instanceof Error ? error : new Error(String(error)),
      )
    })
    this.written = pipeline(this.zip.outputStream, fs.createWriteStream(this.partial, { flags: 'wx' }), {
      signal,
    })
    this.written.catch((error: unknown) => this.rejectUnread(this.failure ?? error))
  }

  private rejectUnread(error: unknown): void {
    for (const reject of this.unread) reject(error)
    this.unread.clear()
  }

  /** Abre o arquivo só na vez dele; a promessa resolve quando ele terminou de ser lido. */
  private addLazyFile(source: string, name: string, stat: fs.Stats): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const fail = (error: unknown): void => {
        this.unread.delete(fail)
        reject(error)
      }
      this.unread.add(fail)
      this.zip.addReadStreamLazy(name, { size: stat.size, mtime: stat.mtime }, (callback) => {
        const stream = fs.createReadStream(source)
        stream.once('end', () => {
          this.unread.delete(fail)
          resolve()
        })
        stream.once('error', fail)
        callback(null, stream)
      })
    })
  }

  addBuffer(data: Buffer | string, name: string): void {
    this.zip.addBuffer(typeof data === 'string' ? Buffer.from(data, 'utf8') : data, name)
  }

  /** O arquivo só é aberto na vez dele (milhares de arquivos não abrem de uma vez). */
  addFile(source: string, name: string): void {
    this.zip.addFile(source, name)
  }

  /** Conteúdo de tamanho desconhecido (ex.: o conteúdo cifrado), sem compressão. */
  addStream(stream: NodeJS.ReadableStream, name: string): void {
    this.zip.addReadStream(stream, name, { compress: false })
  }

  /** Acrescenta uma pasta sem seguir links; `prefix` é o caminho dentro do ZIP. */
  addDirectory(root: string, prefix: string, filter: DirectoryFilter): DirectoryAdded {
    let files = 0
    let bytes = 0
    const reads: Promise<void>[] = []
    const walk = (directory: string, segments: string[]): void => {
      this.signal?.throwIfAborted()
      for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) continue
        const child = [...segments, item.name]
        const full = path.join(directory, item.name)
        if (item.isDirectory()) {
          if (filter(child, true)) walk(full, child)
        } else if (item.isFile() && filter(child, false)) {
          const stat = fs.statSync(full)
          bytes += stat.size
          files++
          reads.push(this.addLazyFile(full, [prefix, ...child].filter(Boolean).join('/'), stat))
        }
      }
    }
    walk(root, [])
    const done = Promise.all(reads).then(() => undefined)
    done.catch(() => undefined)
    return { files, bytes, done }
  }

  /** Fecha o ZIP, dá o nome final e devolve o tamanho em bytes. */
  async finish(): Promise<number> {
    try {
      this.zip.end()
      await this.written
      if (this.failure) throw this.failure
      fs.renameSync(this.partial, this.file)
      this.settled = true
      return fs.statSync(this.file).size
    } catch (error) {
      await this.abort()
      if (this.signal?.aborted) throw this.signal.reason
      throw error
    }
  }

  async abort(): Promise<void> {
    if (this.settled) return
    this.settled = true
    ;(this.zip.outputStream as unknown as Destroyable).destroy()
    await this.written.catch(() => undefined)
    this.rejectUnread(this.signal?.reason ?? new Error('ZIP cancelado'))
    fs.rmSync(this.partial, { force: true })
  }
}
