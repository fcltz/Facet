import i18next from 'i18next'
import { toast } from 'sonner'
import { create } from 'zustand'
import type { CatalogChangedEvent, ProxiesChangedEvent } from '@shared/ipc/events'
import type { Group, GroupInput, Tag, TagInput } from '@shared/schemas/group-tag'
import type { ProxySummary } from '@shared/schemas/proxy'
import { invoke, toastError } from '@renderer/lib/ipc'

function indexById<T extends { id: string }>(items: readonly T[]): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item.id, item]))
}

interface CatalogState {
  groups: Group[]
  tags: Tag[]
  proxies: ProxySummary[]
  groupsById: Record<string, Group>
  tagsById: Record<string, Tag>
  proxiesById: Record<string, ProxySummary>
  loaded: boolean

  load: () => Promise<void>
  refresh: (entity: CatalogChangedEvent['entity']) => Promise<void>
  /** Aplica cadastro, edição, verificação ou exclusão de proxies vindos do processo principal. */
  applyProxies: (event: ProxiesChangedEvent) => void
  /** Lançam AppError em caso de falha (os formulários mostram o erro). */
  createGroup: (input: GroupInput) => Promise<Group>
  updateGroup: (id: string, patch: Partial<GroupInput>) => Promise<Group>
  deleteGroup: (group: Group) => Promise<void>
  createTag: (input: TagInput) => Promise<Tag>
  updateTag: (id: string, patch: Partial<TagInput>) => Promise<Tag>
  deleteTag: (tag: Tag) => Promise<void>
}

function sortGroups(groups: Group[]): Group[] {
  return [...groups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

function sortTags(tags: Tag[]): Tag[] {
  return [...tags].sort((a, b) => a.name.localeCompare(b.name))
}

/** Mesma ordem da lista do processo principal: país, depois host. */
function sortProxies(proxies: ProxySummary[]): ProxySummary[] {
  return [...proxies].sort(
    (a, b) => (a.countryCode ?? 'ZZ').localeCompare(b.countryCode ?? 'ZZ') || a.host.localeCompare(b.host),
  )
}

export const useCatalogStore = create<CatalogState>()((set, get) => {
  const setGroups = (groups: Group[]): void => {
    const sorted = sortGroups(groups)
    set({ groups: sorted, groupsById: indexById(sorted) })
  }
  const setTags = (tags: Tag[]): void => {
    const sorted = sortTags(tags)
    set({ tags: sorted, tagsById: indexById(sorted) })
  }
  const setProxies = (proxies: ProxySummary[]): void => {
    const sorted = sortProxies(proxies)
    set({ proxies: sorted, proxiesById: indexById(sorted) })
  }

  return {
    groups: [],
    tags: [],
    proxies: [],
    groupsById: {},
    tagsById: {},
    proxiesById: {},
    loaded: false,

    load: async () => {
      try {
        const [groups, tags, proxies] = await Promise.all([
          invoke('groups.list'),
          invoke('tags.list'),
          invoke('proxies.list'),
        ])
        setGroups(groups)
        setTags(tags)
        setProxies(proxies)
        set({ loaded: true })
      } catch (error) {
        set({ loaded: true })
        toastError(error, i18next.t('errors.loadFailed'))
      }
    },

    refresh: async (entity) => {
      try {
        if (entity === 'groups') setGroups(await invoke('groups.list'))
        else if (entity === 'tags') setTags(await invoke('tags.list'))
        else setProxies(await invoke('proxies.list'))
      } catch (error) {
        toastError(error)
      }
    },

    applyProxies: ({ upserted, removedIds }) => {
      if (upserted.length === 0 && removedIds.length === 0) return
      const byId = { ...get().proxiesById }
      for (const proxy of upserted) byId[proxy.id] = proxy
      for (const id of removedIds) delete byId[id]
      setProxies(Object.values(byId))
    },

    createGroup: async (input) => {
      const group = await invoke('groups.create', input)
      setGroups([...get().groups.filter((g) => g.id !== group.id), group])
      toast.success(i18next.t('toasts.groupCreated', { name: group.name }))
      return group
    },

    updateGroup: async (id, patch) => {
      const group = await invoke('groups.update', { id, patch })
      setGroups(get().groups.map((g) => (g.id === id ? group : g)))
      toast.success(i18next.t('toasts.groupSaved'))
      return group
    },

    deleteGroup: async (group) => {
      try {
        await invoke('groups.delete', { id: group.id })
        setGroups(get().groups.filter((g) => g.id !== group.id))
        toast.success(i18next.t('toasts.groupDeleted', { name: group.name }))
      } catch (error) {
        toastError(error)
      }
    },

    createTag: async (input) => {
      const tag = await invoke('tags.create', input)
      setTags([...get().tags.filter((t) => t.id !== tag.id), tag])
      toast.success(i18next.t('toasts.tagCreated', { name: tag.name }))
      return tag
    },

    updateTag: async (id, patch) => {
      const tag = await invoke('tags.update', { id, patch })
      setTags(get().tags.map((t) => (t.id === id ? tag : t)))
      toast.success(i18next.t('toasts.tagSaved'))
      return tag
    },

    deleteTag: async (tag) => {
      try {
        await invoke('tags.delete', { id: tag.id })
        setTags(get().tags.filter((t) => t.id !== tag.id))
        toast.success(i18next.t('toasts.tagDeleted', { name: tag.name }))
      } catch (error) {
        toastError(error)
      }
    },
  }
})
