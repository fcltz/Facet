import type { RowSelectionState, SortingState } from '@tanstack/react-table'
import i18next from 'i18next'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { BROWSER_NAMES } from '@shared/constants'
import type { ProfilesChangedEvent, RuntimeStatusEvent } from '@shared/ipc/events'
import { AppError, type AppErrorPayload } from '@shared/ipc/result'
import {
  formatSerial,
  toListItem,
  type BulkCreateInput,
  type Profile,
  type ProfileCreateInput,
  type ProfileListItem,
  type ProfilePatchInput,
  type RuntimeActionResult,
  type RuntimeStatus,
} from '@shared/schemas/profile'
import type { ProxySummary } from '@shared/schemas/proxy'
import { countryName } from '@renderer/lib/format'
import { invoke, toastError } from '@renderer/lib/ipc'
import { useCatalogStore } from './catalog.store'
import { useUiStore } from './ui.store'

export type StatusFilter = 'running' | 'stopped' | 'busy' | 'error'
export type ProxyFilterMode = 'any' | 'with' | 'without'
/** Valor especial do filtro de grupo para "sem grupo". */
export const NO_GROUP = '__none__'

export interface ProfileFilters {
  search: string
  groupIds: string[]
  tagIds: string[]
  statuses: StatusFilter[]
  proxyMode: ProxyFilterMode
  countries: string[]
}

export const EMPTY_FILTERS: ProfileFilters = {
  search: '',
  groupIds: [],
  tagIds: [],
  statuses: [],
  proxyMode: 'any',
  countries: [],
}

export function hasActiveFilters(filters: ProfileFilters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.groupIds.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.statuses.length > 0 ||
    filters.proxyMode !== 'any' ||
    filters.countries.length > 0
  )
}

/** Linha da tabela: o perfil já com status de execução e nomes resolvidos. */
export interface ProfileRow extends ProfileListItem {
  status: RuntimeStatus
  groupName: string | null
  tagNames: string[]
  proxy: ProxySummary | null
}

interface ProfilesState {
  byId: Record<string, ProfileListItem>
  loaded: boolean
  loadError: boolean
  statuses: Record<string, RuntimeStatus>
  runtimeErrors: Record<string, AppErrorPayload>
  filters: ProfileFilters
  selection: RowSelectionState
  sorting: SortingState
  /** Âncora da seleção com Shift. */
  lastToggledId: string | null
  /** Ids visíveis na tabela (após busca e filtros), na ordem exibida. */
  visibleIds: string[]

  load: () => Promise<void>
  applyChanges: (event: ProfilesChangedEvent) => void
  applyStatus: (event: RuntimeStatusEvent) => void
  setFilters: (patch: Partial<ProfileFilters>) => void
  clearFilters: () => void
  setSelection: (selection: RowSelectionState) => void
  clearSelection: () => void
  selectVisible: () => void
  setSorting: (sorting: SortingState) => void
  setLastToggled: (id: string | null) => void
  setVisibleIds: (ids: string[]) => void
  selectedIds: () => string[]

  /** create/update/bulkCreate lançam o erro: o formulário decide como mostrá-lo. */
  create: (input: ProfileCreateInput) => Promise<Profile>
  update: (id: string, patch: ProfilePatchInput) => Promise<Profile>
  bulkCreate: (input: BulkCreateInput) => Promise<ProfileListItem[]>
  clone: (id: string) => Promise<void>
  trash: (ids: string[]) => Promise<void>
  restore: (ids: string[]) => Promise<void>
  deletePermanently: (ids: string[]) => Promise<void>
  emptyTrash: () => Promise<void>
  start: (ids: string[]) => Promise<void>
  stop: (ids: string[]) => Promise<void>
  restart: (ids: string[]) => Promise<void>
  assignProxy: (ids: string[], proxyId: string | null) => Promise<void>
  moveToGroup: (ids: string[], groupId: string | null) => Promise<void>
}

function reportFailures(result: RuntimeActionResult, byId: Record<string, ProfileListItem>): void {
  for (const failure of result.failed) {
    const name = byId[failure.id]?.name ?? failure.id
    toastError(AppError.fromPayload(failure.error), i18next.t('toasts.startFailed', { name }))
  }
}

export const useProfilesStore = create<ProfilesState>()((set, get) => ({
  byId: {},
  loaded: false,
  loadError: false,
  statuses: {},
  runtimeErrors: {},
  filters: EMPTY_FILTERS,
  selection: {},
  sorting: [],
  lastToggledId: null,
  visibleIds: [],

  load: async () => {
    try {
      const [items, statuses] = await Promise.all([
        invoke('profiles.list', { scope: 'all' }),
        invoke('runtime.statuses'),
      ])
      const statusMap: Record<string, RuntimeStatus> = {}
      const errors: Record<string, AppErrorPayload> = {}
      for (const entry of statuses) {
        statusMap[entry.profileId] = entry.status
        if (entry.error) errors[entry.profileId] = entry.error
      }
      set({
        byId: Object.fromEntries(items.map((item) => [item.id, item])),
        statuses: statusMap,
        runtimeErrors: errors,
        loaded: true,
        loadError: false,
      })
    } catch (error) {
      set({ loaded: true, loadError: true })
      toastError(error, i18next.t('errors.loadFailed'))
    }
  },

  applyChanges: ({ upserted, removedIds }) => {
    if (upserted.length === 0 && removedIds.length === 0) return
    set((state) => {
      const byId = { ...state.byId }
      const selection = { ...state.selection }
      for (const item of upserted) {
        const current = byId[item.id]
        if (!current || item.updatedAt >= current.updatedAt) byId[item.id] = item
        if (item.deletedAt !== null) delete selection[item.id]
      }
      for (const id of removedIds) {
        delete byId[id]
        delete selection[id]
      }
      return { byId, selection }
    })
  },

  applyStatus: ({ profileId, status, error }) => {
    set((state) => {
      const statuses = { ...state.statuses }
      const runtimeErrors = { ...state.runtimeErrors }
      if (status === 'stopped') delete statuses[profileId]
      else statuses[profileId] = status
      if ((status === 'error' || status === 'disconnected') && error) runtimeErrors[profileId] = error
      else delete runtimeErrors[profileId]
      return { statuses, runtimeErrors }
    })
  },

  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  clearFilters: () => set({ filters: EMPTY_FILTERS }),
  setSelection: (selection) => set({ selection }),
  clearSelection: () => set({ selection: {}, lastToggledId: null }),
  selectVisible: () =>
    set((state) => ({ selection: Object.fromEntries(state.visibleIds.map((id) => [id, true])) })),
  setSorting: (sorting) => set({ sorting }),
  setLastToggled: (id) => set({ lastToggledId: id }),
  setVisibleIds: (ids) => set({ visibleIds: ids }),
  selectedIds: () =>
    Object.entries(get().selection)
      .filter(([, selected]) => selected)
      .map(([id]) => id),

  create: async (input) => {
    const profile = await invoke('profiles.create', input)
    get().applyChanges({ upserted: [toListItem(profile)], removedIds: [] })
    toast.success(i18next.t('toasts.profileCreated', { name: profile.name }))
    return profile
  },

  update: async (id, patch) => {
    const profile = await invoke('profiles.update', { id, patch })
    get().applyChanges({ upserted: [toListItem(profile)], removedIds: [] })
    toast.success(i18next.t('toasts.profileSaved', { name: profile.name }))
    return profile
  },

  bulkCreate: async (input) => {
    const items = await invoke('profiles.bulkCreate', input)
    get().applyChanges({ upserted: items, removedIds: [] })
    toast.success(i18next.t('toasts.bulkCreated', { count: items.length }))
    return items
  },

  clone: async (id) => {
    try {
      const profile = await invoke('profiles.clone', { id })
      get().applyChanges({ upserted: [toListItem(profile)], removedIds: [] })
      toast.success(i18next.t('toasts.profileCloned', { name: profile.name }), {
        action: {
          label: i18next.t('common.edit'),
          onClick: () => useUiStore.getState().openEditDrawer(profile.id),
        },
      })
    } catch (error) {
      toastError(error)
    }
  },

  trash: async (ids) => {
    if (ids.length === 0) return
    try {
      const { count } = await invoke('profiles.trash', { ids })
      toast.success(i18next.t('toasts.trashed', { count }), {
        action: { label: i18next.t('common.undo'), onClick: () => void get().restore(ids) },
      })
    } catch (error) {
      toastError(error)
    }
  },

  restore: async (ids) => {
    if (ids.length === 0) return
    try {
      const { count } = await invoke('profiles.restore', { ids })
      toast.success(i18next.t('toasts.restored', { count }))
    } catch (error) {
      toastError(error)
    }
  },

  deletePermanently: async (ids) => {
    if (ids.length === 0) return
    try {
      const { count } = await invoke('profiles.deletePermanently', { ids })
      get().applyChanges({ upserted: [], removedIds: ids })
      toast.success(i18next.t('toasts.deleted', { count }))
    } catch (error) {
      toastError(error)
    }
  },

  emptyTrash: async () => {
    try {
      const trashed = Object.values(get().byId)
        .filter((p) => p.deletedAt !== null)
        .map((p) => p.id)
      const { count } = await invoke('profiles.emptyTrash')
      get().applyChanges({ upserted: [], removedIds: trashed })
      toast.success(i18next.t('toasts.deleted', { count }))
    } catch (error) {
      toastError(error)
    }
  },

  start: async (ids) => {
    if (ids.length === 0) return
    try {
      reportFailures(await invoke('runtime.start', { ids }), get().byId)
    } catch (error) {
      toastError(error)
    }
  },

  stop: async (ids) => {
    if (ids.length === 0) return
    try {
      reportFailures(await invoke('runtime.stop', { ids }), get().byId)
    } catch (error) {
      toastError(error)
    }
  },

  restart: async (ids) => {
    if (ids.length === 0) return
    try {
      const result = await invoke('runtime.restart', { ids })
      reportFailures(result, get().byId)
      if (result.done.length > 0) toast.success(i18next.t('toasts.restarted', { count: result.done.length }))
    } catch (error) {
      toastError(error)
    }
  },

  assignProxy: async (ids, proxyId) => {
    if (ids.length === 0) return
    try {
      const result = await invoke('profiles.assignProxy', { ids, proxyId })
      get().applyChanges({ upserted: result.updated, removedIds: [] })
      const count = result.updated.length
      toast.success(
        proxyId ? i18next.t('toasts.proxyAssigned', { count }) : i18next.t('toasts.proxyRemoved', { count }),
      )
      if (result.runningIds.length > 0) useUiStore.getState().openRestartPrompt(result.runningIds)
    } catch (error) {
      toastError(error)
    }
  },

  moveToGroup: async (ids, groupId) => {
    if (ids.length === 0) return
    try {
      const updated = await invoke('profiles.moveToGroup', { ids, groupId })
      get().applyChanges({ upserted: updated, removedIds: [] })
      toast.success(i18next.t('toasts.movedToGroup', { count: updated.length }))
    } catch (error) {
      toastError(error)
    }
  },
}))

/** Linhas (perfis ativos ou da lixeira) com status e nomes do catálogo resolvidos. */
export function useProfileRows(scope: 'active' | 'trash'): ProfileRow[] {
  const byId = useProfilesStore((s) => s.byId)
  const statuses = useProfilesStore((s) => s.statuses)
  const groupsById = useCatalogStore((s) => s.groupsById)
  const tagsById = useCatalogStore((s) => s.tagsById)
  const proxiesById = useCatalogStore((s) => s.proxiesById)

  return useMemo(() => {
    const rows: ProfileRow[] = []
    for (const profile of Object.values(byId)) {
      const trashed = profile.deletedAt !== null
      if ((scope === 'trash') !== trashed) continue
      rows.push({
        ...profile,
        status: statuses[profile.id] ?? 'stopped',
        groupName: profile.groupId ? (groupsById[profile.groupId]?.name ?? null) : null,
        tagNames: profile.tagIds
          .map((id) => tagsById[id]?.name)
          .filter((name): name is string => Boolean(name)),
        proxy: profile.proxyId ? (proxiesById[profile.proxyId] ?? null) : null,
      })
    }
    return rows
  }, [byId, statuses, groupsById, tagsById, proxiesById, scope])
}

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

function matchesStatus(status: RuntimeStatus, filters: StatusFilter[]): boolean {
  if (filters.length === 0) return true
  return filters.some((filter) =>
    filter === 'busy'
      ? status === 'starting' || status === 'stopping'
      : filter === 'error'
        ? status === 'error' || status === 'disconnected'
        : filter === status,
  )
}

/** Busca (todas as palavras precisam aparecer) + filtros combinados. */
export function filterProfileRows(rows: readonly ProfileRow[], filters: ProfileFilters): ProfileRow[] {
  const tokens = normalize(filters.search).split(/\s+/).filter(Boolean)
  return rows.filter((row) => {
    if (filters.groupIds.length > 0) {
      const key = row.groupId ?? NO_GROUP
      if (!filters.groupIds.includes(key)) return false
    }
    if (filters.tagIds.length > 0 && !filters.tagIds.some((id) => row.tagIds.includes(id))) return false
    if (!matchesStatus(row.status, filters.statuses)) return false
    if (filters.proxyMode === 'with' && !row.proxy) return false
    if (filters.proxyMode === 'without' && row.proxy) return false
    if (filters.countries.length > 0 && !filters.countries.includes(row.proxy?.countryCode ?? ''))
      return false
    if (tokens.length === 0) return true
    const haystack = normalize(
      [
        // "02", "#02" ou "2" encontram o perfil número 2
        `#${formatSerial(row.serial)} #${row.serial}`,
        row.name,
        row.notes,
        row.groupName ?? '',
        ...row.tagNames,
        row.proxy?.exitIp ?? '',
        row.proxy?.host ?? '',
        row.proxy?.city ?? '',
        row.proxy?.countryCode ?? '',
        countryName(row.proxy?.countryCode) ?? '',
        row.proxy?.name ?? '',
        // "chrome", "opera", "android", "ios" encontram os perfis desse navegador ou sistema
        BROWSER_NAMES[row.browser],
        row.os,
      ].join(' '),
    )
    return tokens.every((token) => haystack.includes(token))
  })
}
