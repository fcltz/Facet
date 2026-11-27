import fs from 'node:fs'
import path from 'node:path'
import { LIMITS } from '@shared/constants'
import { AppError } from '@shared/ipc/result'
import type { ExtensionSource } from '@shared/schemas/extension'
import type { ExtensionPackage } from '../repositories/types'
import { isCrx, parseCrx } from './crx'
import { extensionIdFromKeyBase64 } from './ids'
import {
  findManifestRoot,
  generatePublicKey,
  readIcon,
  readManifest,
  removeReservedEntries,
  writeManifestKey,
} from './manifest'
import type { ExtensionStore } from './store'
import { unpackZip, type UnpackLimits } from './zip'

export interface InstallerLimits extends UnpackLimits {
  maxArchiveBytes: number
  maxPath: number
}

export interface InstallerDeps {
  store: ExtensionStore
  webStore: { download(id: string): Promise<Buffer> }
  limits?: Partial<InstallerLimits>
}

/** `expectedId`: o pacote precisa ter este ID; `replaceKey`: chave da extensão sendo substituída. */
export interface InstallRequest {
  expectedId?: string
  replaceKey?: string
}

function invalid(message: string, reason: string): AppError {
  return new AppError('EXTENSION_INVALID', message, { reason })
}

/**
 * Monta a extensão numa pasta temporária, valida, garante a `key` no manifest (o ID
 * fica estável) e move para extensions/<id>/<pasta>/. Quem chama grava no banco e
 * depois libera a pasta com `store.settle`.
 */
export class ExtensionInstaller {
  private readonly limits: InstallerLimits

  constructor(private readonly deps: InstallerDeps) {
    this.limits = {
      maxArchiveBytes: LIMITS.extensionArchiveMaxBytes,
      maxEntries: LIMITS.extensionMaxEntries,
      maxTotalBytes: LIMITS.extensionUnpackedMaxBytes,
      maxPath: LIMITS.extensionPathMax,
      ...deps.limits,
    }
  }

  /** Arquivo .zip ou .crx escolhido pelo usuário (o formato vem do conteúdo, não do nome). */
  async fromArchive(file: string, request: InstallRequest = {}): Promise<ExtensionPackage> {
    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      throw invalid('Arquivo não encontrado', 'package')
    }
    if (!stat.isFile()) throw invalid('Selecione um arquivo .zip ou .crx', 'package')
    if (stat.size > this.limits.maxArchiveBytes) throw invalid('Arquivo grande demais', 'tooLarge')
    const buffer = fs.readFileSync(file)
    return this.fromBuffer(buffer, isCrx(buffer) ? 'crx' : 'zip', request)
  }

  async fromWebStore(id: string): Promise<ExtensionPackage> {
    const buffer = await this.deps.webStore.download(id)
    if (!isCrx(buffer)) {
      throw new AppError('EXTENSION_DOWNLOAD_FAILED', 'A Chrome Web Store não devolveu um pacote CRX', {
        reason: 'notCrx',
      })
    }
    return this.fromBuffer(buffer, 'webstore', { expectedId: id })
  }

  async fromBuffer(
    buffer: Buffer,
    source: ExtensionSource,
    request: InstallRequest = {},
  ): Promise<ExtensionPackage> {
    if (buffer.length > this.limits.maxArchiveBytes) throw invalid('Arquivo grande demais', 'tooLarge')
    let zip = buffer
    let crxKey: string | null = null
    if (isCrx(buffer)) {
      const crx = parseCrx(buffer)
      zip = crx.zip
      crxKey = crx.publicKey.toString('base64')
    } else if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
      throw invalid('O arquivo não é um .zip nem um .crx', 'package')
    }
    return this.build(
      async (content) => {
        await unpackZip(zip, content, this.limits)
      },
      crxKey,
      source,
      request,
    )
  }

  async fromFolder(directory: string, request: InstallRequest = {}): Promise<ExtensionPackage> {
    return this.build(
      (content) => {
        this.deps.store.copyFolder(directory, content, this.limits)
        return Promise.resolve()
      },
      null,
      'folder',
      request,
    )
  }

  private async build(
    fill: (content: string) => Promise<void>,
    crxKey: string | null,
    source: ExtensionSource,
    request: InstallRequest,
  ): Promise<ExtensionPackage> {
    const { store } = this.deps
    const staging = store.createStaging()
    try {
      const content = path.join(staging, 'content')
      fs.mkdirSync(content)
      await fill(content)
      const root = findManifestRoot(content)
      removeReservedEntries(root)
      const { raw, info } = readManifest(root)
      // A chave do CRX é a do desenvolvedor: com ela o ID é o mesmo da Chrome Web Store.
      const packageKey = crxKey ?? info.key
      if (request.replaceKey && packageKey && packageKey !== request.replaceKey) {
        throw invalid('O pacote é de outra extensão (o ID é diferente)', 'differentId')
      }
      const key = packageKey ?? request.replaceKey ?? generatePublicKey()
      const id = extensionIdFromKeyBase64(key)
      if (request.expectedId && id !== request.expectedId) {
        throw invalid(`O pacote recebido tem outro ID (${id})`, 'differentId')
      }
      writeManifestKey(root, raw, key)
      const tree = store.scanTree(root)
      if (store.finalPathLength(id, tree.longest) > this.limits.maxPath) {
        throw invalid('A extensão tem caminhos de arquivo longos demais para o Windows', 'pathTooLong')
      }
      const icon = readIcon(root, info.iconPath)
      const dirName = await store.commit(root, id)
      return {
        id,
        name: info.name,
        version: info.version,
        description: info.description,
        manifestVersion: info.manifestVersion,
        source,
        publicKey: key,
        dirName,
        icon,
        permissions: info.permissions,
        sizeBytes: tree.bytes,
      }
    } finally {
      store.discardStaging(staging)
    }
  }
}
