import { AppError } from '@shared/ipc/result'
import {
  openZipBuffer,
  unpackAll,
  validateEntryName as validateName,
  type UnpackResult,
  type ZipLimits,
} from '../archive/zip-reader'

export type UnpackLimits = ZipLimits
export type { UnpackResult }

function invalid(message: string, reason = 'package'): AppError {
  return new AppError('EXTENSION_INVALID', message, { reason })
}

/** Nome relativo conferido de um arquivo de extensão (erros como EXTENSION_INVALID). */
export function validateEntryName(name: string): string[] {
  return validateName(name, invalid)
}

/**
 * Extrai um ZIP (ou o ZIP de dentro de um CRX) numa pasta vazia, com limites contra
 * zip bomb, nomes conferidos, links simbólicos recusados e CRC32 de cada arquivo.
 */
export async function unpackZip(zip: Buffer, target: string, limits: UnpackLimits): Promise<UnpackResult> {
  let zipfile
  try {
    zipfile = await openZipBuffer(zip)
  } catch (error) {
    throw invalid(`ZIP inválido: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return await unpackAll(zipfile, target, limits, invalid)
  } finally {
    zipfile.close()
  }
}
