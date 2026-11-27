import type { EmitFn } from '@shared/ipc/events'
import type { BulkCountResult } from '@shared/schemas/common'
import { toListItem } from '@shared/schemas/profile'
import { AppError } from '@shared/ipc/result'
import type { Repositories } from '../repositories/types'
import type { ProfileRuntime } from '../runtime/types'
import type { ProfileFiles } from '../browser/profile-files'
import type { Logger } from '../logger'

export interface TrashServiceDeps {
  repos: Repositories
  runtime: ProfileRuntime
  emit: EmitFn
  now: () => number
  files?: ProfileFiles
  logger?: Logger
}
export class TrashService {
  constructor(private readonly deps: TrashServiceDeps) {}
  private async stopped<T>(id: string, action: () => T): Promise<T> {
    if (this.deps.runtime.runStopped) return this.deps.runtime.runStopped(id, action)
    await this.deps.runtime.stop(id)
    if (this.deps.runtime.isActive(id)) throw new AppError('PROFILE_RUNNING', 'O perfil ainda está aberto')
    return action()
  }
  async trash(ids: readonly string[]): Promise<BulkCountResult> {
    let count = 0
    for (const id of new Set(ids)) {
      if (this.deps.repos.profiles.get(id)?.deletedAt !== null) continue
      count += await this.stopped(id, () => {
        const current = this.deps.repos.profiles.get(id)
        if (!current || current.deletedAt !== null) return 0
        const now = this.deps.now()
        const profile = this.deps.repos.profiles.update(id, { deletedAt: now, updatedAt: now })
        this.deps.emit('profiles.changed', { upserted: [toListItem(profile)], removedIds: [] })
        return 1
      })
    }
    return { count }
  }
  restore(ids: readonly string[]): BulkCountResult {
    const targets = this.deps.repos.profiles.getMany(ids).filter((p) => p.deletedAt !== null)
    const updated = this.deps.repos.profiles.updateMany(
      targets.map((p) => p.id),
      { deletedAt: null, updatedAt: this.deps.now() },
    )
    this.deps.emit('profiles.changed', { upserted: updated.map(toListItem), removedIds: [] })
    return { count: updated.length }
  }
  async deletePermanently(ids: readonly string[]): Promise<BulkCountResult> {
    let count = 0
    for (const id of new Set(ids)) {
      const profile = this.deps.repos.profiles.get(id)
      if (!profile || profile.deletedAt === null) continue
      count += await this.stopped(id, () => {
        const current = this.deps.repos.profiles.get(id)
        if (!current || current.deletedAt === null) return 0
        this.deps.files?.stageDeletion(id)
        let removed: number
        try {
          removed = this.deps.repos.transaction(() => this.deps.repos.profiles.deleteMany([id]))
        } catch (error) {
          this.deps.files?.rollbackDeletion(id)
          throw error
        }
        this.deps.emit('profiles.changed', { upserted: [], removedIds: [id] })
        try {
          this.deps.files?.finishDeletion(id)
        } catch (error) {
          this.deps.logger?.warn('Limpeza de pasta pendente será retomada na inicialização', id, error)
          throw new AppError('IO_ERROR', 'Registro excluído; a limpeza da pasta será retomada ao reiniciar')
        }
        return removed
      })
    }
    return { count }
  }
  emptyTrash(): Promise<BulkCountResult> {
    return this.deletePermanently(this.deps.repos.profiles.list('trash').map((p) => p.id))
  }
}
