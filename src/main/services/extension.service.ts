import { LIMITS } from '@shared/constants'
import { FACET_EXTENSION_ID, isBuiltinExtension } from '@shared/facet-extension'
import type { EmitFn } from '@shared/ipc/events'
import { AppError } from '@shared/ipc/result'
import {
  parseExtensionConfig,
  parseWebStoreInput,
  type ExtensionAssignResult,
  type ExtensionCaptureResult,
  type ExtensionConfigData,
  type ExtensionConfigInput,
  type ExtensionConfigMode,
  type ExtensionDeleteResult,
  type ExtensionFileKind,
  type ExtensionImportResult,
  type ExtensionStorageArea,
  type ExtensionSummary,
  type ProfileExtensionState,
} from '@shared/schemas/extension'
import { toListItem, type Profile } from '@shared/schemas/profile'
import type { Logger } from '../logger'
import type { ExtensionPackage, Repositories } from '../repositories/types'
import type { ProfileRuntime } from '../runtime/types'
import { captureConfig } from '../extensions/autoconfig'
import type { ExtensionInstaller } from '../extensions/installer'
import type { ExtensionStore } from '../extensions/store'

export interface ExtensionServiceDeps {
  repos: Repositories
  installer: ExtensionInstaller
  store: ExtensionStore
  /** Limpeza de pastas que ninguém mais usa. */
  collectGarbage: () => number
  runtime: ProfileRuntime
  emit: EmitFn
  now: () => number
  logger: Logger
}

function notFound(id: string): AppError {
  return new AppError('NOT_FOUND', `Extensão não encontrada: ${id}`, { entity: 'extension', id })
}

/** A Facet vem com o app: atualiza junto com ele e só é desligada (por perfil ou como padrão). */
function builtinConflict(): AppError {
  return new AppError('CONFLICT', 'A extensão Facet vem com o app e não pode ser excluída nem substituída', {
    reason: 'builtinExtension',
  })
}

export class ExtensionService {
  /** Importações em fila: duas instalações nunca disputam a mesma extensão. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ExtensionServiceDeps) {}

  list(): ExtensionSummary[] {
    return this.deps.repos.extensions.list()
  }

  private require(id: string): ExtensionSummary {
    const extension = this.deps.repos.extensions.get(id)
    if (!extension) throw notFound(id)
    return extension
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(action)
    this.queue = next.catch(() => undefined)
    return next
  }

  importArchive(file: string): Promise<ExtensionImportResult> {
    return this.serialize(async () => this.save(await this.deps.installer.fromArchive(file)))
  }

  importFolder(directory: string): Promise<ExtensionImportResult> {
    return this.serialize(async () => this.save(await this.deps.installer.fromFolder(directory)))
  }

  /** Só para a pasta da Facet que vem com o app: não há canal de IPC para esta entrada. */
  installBuiltin(directory: string, expectedId: string): Promise<ExtensionImportResult> {
    return this.serialize(async () =>
      this.save({
        ...(await this.deps.installer.fromFolder(directory, { expectedId })),
        source: 'builtin',
      }),
    )
  }

  importWebStore(input: string): Promise<ExtensionImportResult> {
    const id = parseWebStoreInput(input)
    if (!id) {
      return Promise.reject(
        new AppError('VALIDATION_ERROR', 'ID ou endereço da Chrome Web Store inválido', [
          { path: 'input', message: 'invalidWebStoreInput' },
        ]),
      )
    }
    return this.serialize(async () => this.save(await this.deps.installer.fromWebStore(id)))
  }

  /** Baixa de novo da Chrome Web Store (a versão nova entra na próxima abertura de cada perfil). */
  refresh(id: string): Promise<ExtensionImportResult> {
    const row = this.deps.repos.extensions.row(id)
    if (!row) return Promise.reject(notFound(id))
    if (row.source !== 'webstore') {
      return Promise.reject(
        new AppError('CONFLICT', 'Só extensões da Chrome Web Store podem ser atualizadas por lá', {
          reason: 'notWebStore',
        }),
      )
    }
    return this.serialize(async () => this.save(await this.deps.installer.fromWebStore(id)))
  }

  /** Troca os arquivos de uma extensão mantendo o ID (a chave salva vai para o pacote novo). */
  replace(id: string, kind: ExtensionFileKind, source: string): Promise<ExtensionImportResult> {
    const row = this.deps.repos.extensions.row(id)
    if (!row) return Promise.reject(notFound(id))
    if (isBuiltinExtension(row)) return Promise.reject(builtinConflict())
    const request = { replaceKey: row.publicKey }
    return this.serialize(async () =>
      this.save(
        kind === 'folder'
          ? await this.deps.installer.fromFolder(source, request)
          : await this.deps.installer.fromArchive(source, request),
      ),
    )
  }

  private save(pkg: ExtensionPackage): ExtensionImportResult {
    try {
      // Uma cópia da pasta da Facet (a chave dela está no manifest) não toma o lugar da integrada.
      if (pkg.id === FACET_EXTENSION_ID && pkg.source !== 'builtin') throw builtinConflict()
      const { summary, previous } = this.deps.repos.extensions.savePackage(pkg, this.deps.now())
      this.deps.emit('extensions.changed', { upserted: [summary], removedIds: [] })
      const status = !previous ? 'added' : previous.version !== pkg.version ? 'updated' : 'reinstalled'
      this.deps.logger.info(`Extensão ${status}: ${pkg.name} ${pkg.version} (${pkg.id})`)
      return { extension: summary, status, previousVersion: previous?.version ?? null }
    } finally {
      // A pasta antiga sai quando nenhum perfil aberto a usa; a nova já está no banco.
      this.deps.store.settle(pkg.id, pkg.dirName)
      this.deps.collectGarbage()
    }
  }

  setDefault(ids: readonly string[], isDefault: boolean): ExtensionSummary[] {
    const updated = this.deps.repos.extensions.setDefault(ids, isDefault, this.deps.now())
    if (updated.length > 0) this.deps.emit('extensions.changed', { upserted: updated, removedIds: [] })
    return updated
  }

  setPreferences(id: string, mode: ExtensionConfigMode, isDefault: boolean): ExtensionSummary {
    this.require(id)
    const summary = this.deps.repos.extensions.setPreferences(id, mode, isDefault, this.deps.now())
    this.deps.emit('extensions.changed', { upserted: [summary], removedIds: [] })
    return summary
  }

  /** Liga ou desliga a extensão em vários perfis; os abertos só mudam ao reiniciar. */
  assign(
    extensionId: string,
    profileIds: readonly string[] | 'allActive',
    enabled: boolean,
  ): ExtensionAssignResult {
    this.require(extensionId)
    const { repos } = this.deps
    const targets =
      profileIds === 'allActive'
        ? repos.profiles.list('active')
        : repos.profiles.getMany(profileIds).filter((profile) => profile.deletedAt === null)
    const now = this.deps.now()
    const changed = repos.transaction(() =>
      targets.flatMap((profile): Profile[] => {
        if (profile.extensionIds.includes(extensionId) === enabled) return []
        if (enabled && profile.extensionIds.length >= LIMITS.extensionsPerProfileMax) {
          throw new AppError('CONFLICT', `O perfil ${profile.name} já tem o máximo de extensões`, {
            reason: 'tooManyExtensions',
            id: profile.id,
          })
        }
        const extensionIds = enabled
          ? [...profile.extensionIds, extensionId]
          : profile.extensionIds.filter((id) => id !== extensionId)
        return [repos.profiles.update(profile.id, { extensionIds, updatedAt: now })]
      }),
    )
    if (changed.length > 0) {
      this.deps.emit('profiles.changed', { upserted: changed.map(toListItem), removedIds: [] })
      this.deps.emit('extensions.changed', { upserted: [this.require(extensionId)], removedIds: [] })
    }
    return {
      changed: changed.length,
      runningIds: changed
        .filter((profile) => this.deps.runtime.isActive(profile.id))
        .map((profile) => profile.id),
    }
  }

  /**
   * Exclusão de extensões usadas por perfis exige `confirmInUse`. Perfis abertos
   * continuam com ela até fechar (a pasta só é apagada depois).
   */
  delete(ids: readonly string[], confirmInUse: boolean): ExtensionDeleteResult {
    const { repos } = this.deps
    const found = repos.extensions.getMany(ids)
    if (found.some(isBuiltinExtension)) throw builtinConflict()
    const targets = found.map((extension) => extension.id)
    const affected = repos.extensions.profileIdsUsing(targets)
    if (affected.length > 0 && !confirmInUse) {
      throw new AppError('EXTENSION_IN_USE', `${affected.length} perfis usam estas extensões`, {
        profiles: affected.length,
      })
    }
    const count = repos.extensions.deleteMany(targets)
    if (count > 0) this.deps.emit('extensions.changed', { upserted: [], removedIds: targets })
    const profiles = repos.profiles.getMany(affected)
    if (profiles.length > 0) {
      this.deps.emit('profiles.changed', { upserted: profiles.map(toListItem), removedIds: [] })
    }
    this.deps.collectGarbage()
    return { count, detachedProfiles: affected.length }
  }

  getConfig(id: string): ExtensionConfigData | null {
    this.require(id)
    const config = this.deps.repos.extensions.config(id)
    return config ? { ...config } : null
  }

  setConfig(id: string, input: ExtensionConfigInput | null, reapply: boolean): ExtensionSummary {
    const extension = this.require(id)
    let write = null
    if (input) {
      if (!extension.hasStorage) {
        throw new AppError('CONFLICT', 'A extensão não usa chrome.storage (permissão "storage")', {
          reason: 'noStorage',
        })
      }
      const parsed = parseExtensionConfig(input.json, input.area)
      if (!parsed.ok) {
        throw new AppError('VALIDATION_ERROR', 'Configuração inválida', [
          { path: 'json', message: parsed.error },
        ])
      }
      write = {
        area: input.area,
        mode: input.mode,
        json: JSON.stringify(parsed.values, null, 2),
        keys: Object.keys(parsed.values).length,
      }
    }
    const summary = this.deps.repos.extensions.setConfig(id, write, reapply, this.deps.now())
    this.deps.emit('extensions.changed', { upserted: [summary], removedIds: [] })
    return summary
  }

  /** Lê o chrome.storage da extensão num perfil aberto (configure uma vez, aplique em todos). */
  async captureConfig(
    id: string,
    profileId: string,
    area: ExtensionStorageArea,
  ): Promise<ExtensionCaptureResult> {
    this.require(id)
    const profile = this.deps.repos.profiles.get(profileId)
    if (!profile)
      throw new AppError('NOT_FOUND', `Perfil não encontrado: ${profileId}`, { entity: 'profile' })
    if (!profile.extensionIds.includes(id)) {
      throw new AppError('CONFLICT', 'A extensão não está neste perfil', { reason: 'notInProfile' })
    }
    const client = this.deps.runtime.client?.(profileId) ?? null
    if (!client) {
      throw new AppError('CONFLICT', 'Abra o perfil para capturar a configuração', {
        reason: 'profileNotRunning',
      })
    }
    return captureConfig(client, id, area)
  }

  profileState(profileId: string): ProfileExtensionState[] {
    return this.deps.repos.extensions.profileState(profileId)
  }

  /** A configuração volta a ser aplicada na próxima abertura do perfil. */
  reapplyConfig(profileId: string, extensionIds: readonly string[]): ProfileExtensionState[] {
    return this.deps.repos.extensions.resetConfig(profileId, extensionIds)
  }
}
