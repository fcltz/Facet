import { createHash } from 'node:crypto'

const ALPHABET = 'abcdefghijklmnop'

/** Os 16 primeiros bytes viram 32 letras: cada meio-byte (0–15) é uma letra de "a" a "p". */
export function extensionIdFromDigest(bytes: Buffer): string {
  if (bytes.length < 16) throw new Error('São necessários 16 bytes para o ID da extensão')
  let id = ''
  for (const byte of bytes.subarray(0, 16)) id += ALPHABET[byte >> 4]! + ALPHABET[byte & 15]!
  return id
}

/** ID que o Chrome dá à extensão cuja `key` (SPKI DER) é esta. */
export function extensionIdFromKey(spkiDer: Buffer): string {
  return extensionIdFromDigest(createHash('sha256').update(spkiDer).digest())
}

export function extensionIdFromKeyBase64(key: string): string {
  return extensionIdFromKey(Buffer.from(key, 'base64'))
}

/**
 * ID que o Chrome dá a uma pasta descompactada SEM `key`: depende do caminho absoluto
 * (no Windows, UTF-16LE com a letra da unidade em maiúscula — verificado no Brave 158).
 * O Facet sempre grava uma `key`, justamente para o ID não mudar com a pasta.
 */
export function extensionIdFromPath(directory: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32')
    return extensionIdFromDigest(createHash('sha256').update(directory, 'utf8').digest())
  const normalized = /^[a-z]:/.test(directory) ? directory[0]!.toUpperCase() + directory.slice(1) : directory
  return extensionIdFromDigest(createHash('sha256').update(Buffer.from(normalized, 'utf16le')).digest())
}
