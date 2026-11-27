import crypto from 'node:crypto'
import { Transform, type TransformCallback } from 'node:stream'
import { AppError } from '@shared/ipc/result'
import type { KdfParams } from '@shared/schemas/transfer'

/**
 * Cifragem do conteúdo de um pacote protegido por senha: chave de 256 bits derivada com
 * scrypt e AES-256-GCM em registros de até 1 MiB ("STREAM"). O nonce de cada registro é
 * prefixo aleatório + número do registro + marca de último: trocar a ordem, remover ou
 * cortar registros falha na autenticação.
 */

export const DEFAULT_KDF = { name: 'scrypt', N: 2 ** 17, r: 8, p: 1 } as const
const MAGIC = Buffer.from('FACETENC1', 'ascii')
const PREFIX_BYTES = 7
const RECORD_BYTES = 1024 * 1024
const TAG_BYTES = 16
const VERIFIER_LABEL = 'facet-transfer-verifier-v1'

export function newKdfParams(base: Omit<KdfParams, 'salt'> = DEFAULT_KDF): KdfParams {
  return { ...base, salt: crypto.randomBytes(16).toString('base64') }
}

export function deriveKey(password: string, params: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFC'),
      Buffer.from(params.salt, 'base64'),
      32,
      { N: params.N, r: params.r, p: params.p, maxmem: 512 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    )
  })
}

export function verifierFor(key: Buffer): string {
  return crypto.createHmac('sha256', key).update(VERIFIER_LABEL).digest('base64')
}

export function checkVerifier(key: Buffer, verifier: string): boolean {
  const expected = Buffer.from(verifierFor(key), 'base64')
  const actual = Buffer.from(verifier, 'base64')
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}

function nonce(prefix: Buffer, index: number, last: boolean): Buffer {
  const value = Buffer.alloc(12)
  prefix.copy(value, 0)
  value.writeUInt32BE(index, PREFIX_BYTES)
  value[11] = last ? 1 : 0
  return value
}

/** Fila de bytes sem concatenar a cada pedaço recebido. */
class ByteQueue {
  private chunks: Buffer[] = []
  length = 0
  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    this.chunks.push(chunk)
    this.length += chunk.length
  }
  peek(count: number): Buffer {
    return this.take(count, false)
  }
  read(count: number): Buffer {
    return this.take(count, true)
  }
  private take(count: number, consume: boolean): Buffer {
    const parts: Buffer[] = []
    let needed = count
    let index = 0
    while (needed > 0) {
      const chunk = this.chunks[index]!
      const part = chunk.subarray(0, Math.min(needed, chunk.length))
      parts.push(part)
      needed -= part.length
      index++
    }
    const result = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
    if (consume) {
      let remaining = count
      while (remaining > 0) {
        const chunk = this.chunks[0]!
        if (chunk.length <= remaining) {
          this.chunks.shift()
          remaining -= chunk.length
        } else {
          this.chunks[0] = chunk.subarray(remaining)
          remaining = 0
        }
      }
      this.length -= count
    }
    return result
  }
}

export class EncryptStream extends Transform {
  private readonly prefix = crypto.randomBytes(PREFIX_BYTES)
  private readonly queue = new ByteQueue()
  private index = 0
  private started = false

  constructor(private readonly key: Buffer) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.start()
      this.queue.push(chunk)
      // Sempre sobra algo (ou nada) para o registro final, marcado como último.
      while (this.queue.length > RECORD_BYTES) this.record(this.queue.read(RECORD_BYTES), false)
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.start()
      this.record(this.queue.read(this.queue.length), true)
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  private start(): void {
    if (this.started) return
    this.started = true
    this.push(Buffer.concat([MAGIC, this.prefix]))
  }

  private record(plain: Buffer, last: boolean): void {
    if (this.index >= 0xffffffff) throw new AppError('TRANSFER_INVALID', 'Conteúdo grande demais para cifrar')
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce(this.prefix, this.index++, last))
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
    const header = Buffer.alloc(4)
    header.writeUInt32BE(plain.length)
    this.push(Buffer.concat([header, encrypted, cipher.getAuthTag()]))
  }
}

function tampered(): AppError {
  return new AppError('TRANSFER_INVALID', 'Pacote alterado, incompleto ou corrompido', { reason: 'tampered' })
}

export class DecryptStream extends Transform {
  private readonly queue = new ByteQueue()
  private prefix: Buffer | null = null
  private held: Buffer | null = null
  private index = 0

  constructor(private readonly key: Buffer) {
    super()
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      this.queue.push(chunk)
      if (!this.prefix) {
        if (this.queue.length < MAGIC.length + PREFIX_BYTES) {
          callback()
          return
        }
        if (!this.queue.read(MAGIC.length).equals(MAGIC)) throw tampered()
        this.prefix = Buffer.from(this.queue.read(PREFIX_BYTES))
      }
      for (;;) {
        if (this.queue.length < 4) break
        const size = this.queue.peek(4).readUInt32BE(0)
        if (size > RECORD_BYTES) throw tampered()
        if (this.queue.length < 4 + size + TAG_BYTES) break
        const record = Buffer.from(this.queue.read(4 + size + TAG_BYTES))
        // Um registro fica guardado: só no fim se sabe qual é o último.
        if (this.held) this.push(this.open(this.held, false))
        this.held = record
      }
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (!this.prefix || !this.held || this.queue.length !== 0) throw tampered()
      this.push(this.open(this.held, true))
      callback()
    } catch (error) {
      callback(error as Error)
    }
  }

  private open(record: Buffer, last: boolean): Buffer {
    const size = record.readUInt32BE(0)
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce(this.prefix!, this.index++, last))
    decipher.setAuthTag(record.subarray(4 + size, 4 + size + TAG_BYTES))
    try {
      return Buffer.concat([decipher.update(record.subarray(4, 4 + size)), decipher.final()])
    } catch {
      throw tampered()
    }
  }
}
