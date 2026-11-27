import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import { AppError } from '@shared/ipc/result'
import { extensionIdFromDigest, extensionIdFromKey } from './ids'

/** Pacote CRX já conferido: o ZIP embutido e a chave do desenvolvedor (que define o ID). */
export interface CrxPackage {
  version: 2 | 3
  zip: Buffer
  /** SPKI DER da chave do desenvolvedor. */
  publicKey: Buffer
  id: string
}

const MAGIC = Buffer.from('Cr24', 'latin1')
const CRX3_SIGNED_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1')

function invalid(message: string): AppError {
  return new AppError('EXTENSION_INVALID', message, { reason: 'crx' })
}

export function isCrx(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).equals(MAGIC)
}

interface ProtoField {
  field: number
  wire: number
  bytes: Buffer | null
}

function readVarint(buffer: Buffer, start: number): [number, number] {
  let value = 0
  let multiplier = 1
  let position = start
  for (let i = 0; i < 10; i++) {
    if (position >= buffer.length) throw invalid('Cabeçalho CRX truncado')
    const byte = buffer[position++]!
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) {
      if (!Number.isSafeInteger(value)) throw invalid('Cabeçalho CRX inválido')
      return [value, position]
    }
    multiplier *= 128
  }
  throw invalid('Cabeçalho CRX inválido')
}

/** Leitor mínimo de protobuf: só o necessário para o CrxFileHeader. */
function parseProto(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = []
  let position = 0
  while (position < buffer.length) {
    const [key, afterKey] = readVarint(buffer, position)
    position = afterKey
    const field = Math.floor(key / 8)
    const wire = key % 8
    if (wire === 0) {
      ;[, position] = readVarint(buffer, position)
      fields.push({ field, wire, bytes: null })
    } else if (wire === 2) {
      const [length, afterLength] = readVarint(buffer, position)
      if (afterLength + length > buffer.length) throw invalid('Cabeçalho CRX truncado')
      fields.push({ field, wire, bytes: buffer.subarray(afterLength, afterLength + length) })
      position = afterLength + length
    } else if (wire === 1 || wire === 5) {
      position += wire === 1 ? 8 : 4
      if (position > buffer.length) throw invalid('Cabeçalho CRX truncado')
      fields.push({ field, wire, bytes: null })
    } else {
      throw invalid('Cabeçalho CRX com campo desconhecido')
    }
  }
  return fields
}

function publicKeyOf(der: Buffer): KeyObject {
  try {
    return createPublicKey({ key: der, format: 'der', type: 'spki' })
  } catch {
    throw invalid('Chave pública inválida no CRX')
  }
}

function zipStart(zip: Buffer): Buffer {
  if (zip.length < 4 || zip.readUInt32LE(0) !== 0x04034b50) throw invalid('O CRX não contém um ZIP válido')
  return zip
}

/**
 * CRX3: "Cr24", versão 3, tamanho do cabeçalho e o CrxFileHeader (protobuf). O ID
 * vem do `crx_id` assinado; a chave do desenvolvedor é a prova cujo hash dá esse ID,
 * e a assinatura dela sobre (prefixo + cabeçalho assinado + ZIP) precisa conferir.
 */
function parseCrx3(buffer: Buffer): CrxPackage {
  if (buffer.length < 12) throw invalid('Arquivo CRX truncado')
  const headerSize = buffer.readUInt32LE(8)
  if (headerSize > buffer.length - 12) throw invalid('Cabeçalho CRX maior que o arquivo')
  const header = parseProto(buffer.subarray(12, 12 + headerSize))
  const zip = zipStart(buffer.subarray(12 + headerSize))
  const signedHeader = header.find((f) => f.field === 10000 && f.bytes)?.bytes
  if (!signedHeader) throw invalid('CRX sem cabeçalho assinado')
  const crxId = parseProto(signedHeader).find((f) => f.field === 1 && f.bytes)?.bytes
  if (!crxId || crxId.length !== 16) throw invalid('CRX sem ID')
  const id = extensionIdFromDigest(crxId)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signedHeader.length)
  const signedData = Buffer.concat([CRX3_SIGNED_PREFIX, length, signedHeader, zip])
  // 2 = sha256_with_rsa, 3 = sha256_with_ecdsa; cada prova tem chave (1) e assinatura (2)
  for (const proof of header.filter((f) => (f.field === 2 || f.field === 3) && f.bytes)) {
    const parts = parseProto(proof.bytes!)
    const key = parts.find((p) => p.field === 1 && p.bytes)?.bytes
    const signature = parts.find((p) => p.field === 2 && p.bytes)?.bytes
    if (!key || !signature || extensionIdFromKey(key) !== id) continue
    if (!verify('sha256', signedData, publicKeyOf(key), signature)) {
      throw invalid('Assinatura do CRX não confere: o arquivo foi alterado ou está corrompido')
    }
    return { version: 3, zip, publicKey: Buffer.from(key), id }
  }
  throw invalid('CRX sem a assinatura da chave do desenvolvedor')
}

/** CRX2 (formato antigo): chave e assinatura SHA-1 do ZIP logo após o cabeçalho. */
function parseCrx2(buffer: Buffer): CrxPackage {
  if (buffer.length < 16) throw invalid('Arquivo CRX truncado')
  const keyLength = buffer.readUInt32LE(8)
  const signatureLength = buffer.readUInt32LE(12)
  const zipOffset = 16 + keyLength + signatureLength
  if (zipOffset > buffer.length) throw invalid('Cabeçalho CRX maior que o arquivo')
  const key = buffer.subarray(16, 16 + keyLength)
  const signature = buffer.subarray(16 + keyLength, zipOffset)
  const zip = zipStart(buffer.subarray(zipOffset))
  if (!verify('sha1', zip, publicKeyOf(key), signature)) {
    throw invalid('Assinatura do CRX não confere: o arquivo foi alterado ou está corrompido')
  }
  return { version: 2, zip, publicKey: Buffer.from(key), id: extensionIdFromKey(key) }
}

export function parseCrx(buffer: Buffer): CrxPackage {
  if (!isCrx(buffer)) throw invalid('O arquivo não é um CRX')
  const version = buffer.length >= 8 ? buffer.readUInt32LE(4) : 0
  if (version === 3) return parseCrx3(buffer)
  if (version === 2) return parseCrx2(buffer)
  throw invalid(`Versão de CRX não suportada: ${version}`)
}
