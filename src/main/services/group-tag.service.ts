import type { EmitFn } from '@shared/ipc/events'
import { AppError } from '@shared/ipc/result'
import type {
  DeleteCatalogResult,
  Group,
  GroupInput,
  GroupUpdateInput,
  Tag,
  TagInput,
  TagUpdateInput,
} from '@shared/schemas/group-tag'
import { toListItem, type Profile } from '@shared/schemas/profile'
import type { Repositories } from '../repositories/types'

export interface CatalogServiceDeps {
  repos: Repositories
  emit: EmitFn
  now: () => number
  newId: () => string
}

function compact<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

function duplicateName(entity: 'group' | 'tag'): AppError {
  return new AppError('CONFLICT', `Nome já usado (${entity})`, {
    field: 'name',
    reason: 'duplicateName',
    entity,
  })
}

function emitProfiles(emit: EmitFn, profiles: readonly Profile[]): void {
  if (profiles.length > 0) emit('profiles.changed', { upserted: profiles.map(toListItem), removedIds: [] })
}

export class GroupService {
  constructor(private readonly deps: CatalogServiceDeps) {}

  list(): Group[] {
    return this.deps.repos.groups
      .list()
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
  }

  create(input: GroupInput): Group {
    const { groups } = this.deps.repos
    if (groups.findByName(input.name)) throw duplicateName('group')
    const now = this.deps.now()
    const sortOrder = groups.list().reduce((max, g) => Math.max(max, g.sortOrder), -1) + 1
    const group: Group = {
      id: this.deps.newId(),
      name: input.name,
      color: input.color,
      sortOrder,
      createdAt: now,
      updatedAt: now,
    }
    groups.insert(group)
    this.deps.emit('catalog.changed', { entity: 'groups' })
    return group
  }

  update(input: GroupUpdateInput): Group {
    const { groups } = this.deps.repos
    if (!groups.get(input.id))
      throw new AppError('NOT_FOUND', `Grupo não encontrado: ${input.id}`, { entity: 'group', id: input.id })
    const patch = compact(input.patch)
    if (patch.name) {
      const other = groups.findByName(patch.name)
      if (other && other.id !== input.id) throw duplicateName('group')
    }
    const updated = groups.update(input.id, { ...patch, updatedAt: this.deps.now() })
    this.deps.emit('catalog.changed', { entity: 'groups' })
    return updated
  }

  /** Os perfis do grupo continuam existindo, só ficam "sem grupo". */
  delete(id: string): DeleteCatalogResult {
    const { groups, profiles } = this.deps.repos
    if (!groups.get(id))
      throw new AppError('NOT_FOUND', `Grupo não encontrado: ${id}`, { entity: 'group', id })
    const affected = this.deps.repos.transaction(() => {
      const changed = profiles.clearGroup(id, this.deps.now())
      groups.delete(id)
      return changed
    })
    this.deps.emit('catalog.changed', { entity: 'groups' })
    emitProfiles(this.deps.emit, affected)
    return { affectedProfiles: affected.length }
  }
}

export class TagService {
  constructor(private readonly deps: CatalogServiceDeps) {}

  list(): Tag[] {
    return this.deps.repos.tags.list().sort((a, b) => a.name.localeCompare(b.name))
  }

  create(input: TagInput): Tag {
    const { tags } = this.deps.repos
    if (tags.findByName(input.name)) throw duplicateName('tag')
    const tag: Tag = {
      id: this.deps.newId(),
      name: input.name,
      color: input.color,
      createdAt: this.deps.now(),
    }
    tags.insert(tag)
    this.deps.emit('catalog.changed', { entity: 'tags' })
    return tag
  }

  update(input: TagUpdateInput): Tag {
    const { tags } = this.deps.repos
    if (!tags.get(input.id))
      throw new AppError('NOT_FOUND', `Tag não encontrada: ${input.id}`, { entity: 'tag', id: input.id })
    const patch = compact(input.patch)
    if (patch.name) {
      const other = tags.findByName(patch.name)
      if (other && other.id !== input.id) throw duplicateName('tag')
    }
    const updated = tags.update(input.id, patch)
    this.deps.emit('catalog.changed', { entity: 'tags' })
    return updated
  }

  delete(id: string): DeleteCatalogResult {
    const { tags, profiles } = this.deps.repos
    if (!tags.get(id)) throw new AppError('NOT_FOUND', `Tag não encontrada: ${id}`, { entity: 'tag', id })
    const affected = this.deps.repos.transaction(() => {
      const changed = profiles.clearTag(id, this.deps.now())
      tags.delete(id)
      return changed
    })
    this.deps.emit('catalog.changed', { entity: 'tags' })
    emitProfiles(this.deps.emit, affected)
    return { affectedProfiles: affected.length }
  }
}
