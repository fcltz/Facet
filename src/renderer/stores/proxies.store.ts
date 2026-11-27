import type { RowSelectionState, SortingState } from '@tanstack/react-table'
import i18next from 'i18next'
import { toast } from 'sonner'
import { create } from 'zustand'
import type { ProxyHealthEvent } from '@shared/ipc/events'
import { AppError } from '@shared/ipc/result'
import type {
  ProxyCheckOutcome,
  ProxyCheckProgress,
  ProxyCheckStatus,
  ProxyCreateInput,
  ProxyImportResult,
  ProxySummary,
  ProxyTestDraftInput,
  ProxyType,
  ProxyUpdateInput,
} from '@shared/schemas/proxy'
import { proxyLabel } from '@shared/schemas/proxy'
import { countryName } from '@renderer/lib/format'
import { describeError, invoke, toastError } from '@renderer/lib/ipc'
import { useCatalogStore } from './catalog.store'
import { useProfilesStore } from './profiles.store'
import { useUiStore } from './ui.store'

export interface ProxyFilters {
  search: string
  types: ProxyType[]
  statuses: ProxyCheckStatus[]
  countries: string[]
}

export const EMPTY_PROXY_FILTERS: ProxyFilters = { search: '', types: [], statuses: [], countries: [] }

export function hasProxyFilters(filters: ProxyFilters): boolean {
  return (
    filters.search.trim() !== '' ||
    filters.types.length > 0 ||
    filters.statuses.length > 0 ||
    filters.countries.length > 0
  )
}

/** Linha da tabela de proxies: o proxy e quantos perfis ativos o usam. */
export interface ProxyRow extends ProxySummary {
  usage: number
}

/** Valor do filtro de país para proxies ainda sem país. */
export const NO_COUNTRY = '__none__'

/** Por quanto tempo um aviso de falha do proxy fica visível depois da última falha. */
const HEALTH_TTL_MS = 60_000
const healthTimers = new Map<string, ReturnType<typeof setTimeout>>()

interface ProxiesState {
  filters: ProxyFilters
  selection: RowSelectionState
  sorting: SortingState
  lastToggledId: string | null
  visibleIds: string[]
  progress: ProxyCheckProgress | null
  /** Proxies sendo verificados ou com troca de IP em andamento. */
  checking: Record<string, true>
  rotating: Record<string, true>
  /** Falhas recentes do proxy remoto por perfil aberto. */
  health: Record<string, ProxyHealthEvent>

  setFilters: (patch: Partial<ProxyFilters>) => void
  clearFilters: () => void
  setSelection: (selection: RowSelectionState) => void
  clearSelection: () => void
  setSorting: (sorting: SortingState) => void
  setLastToggled: (id: string | null) => void
  setVisibleIds: (ids: string[]) => void
  selectedIds: () => string[]
  /** Remove da seleção os proxies excluídos. */
  forget: (ids: readonly string[]) => void
  applyProgress: (progress: ProxyCheckProgress) => void
  applyHealth: (event: ProxyHealthEvent) => void
  clearHealth: (profileId: string) => void

  /** create/update lançam o erro: o formulário decide como mostrá-lo. */
  create: (input: ProxyCreateInput) => Promise<ProxySummary>
  update: (id: string, patch: ProxyUpdateInput['patch']) => Promise<ProxySummary>
  testDraft: (input: ProxyTestDraftInput) => Promise<ProxyCheckOutcome>
  importText: (text: string, defaultType: ProxyType, checkAfter: boolean) => Promise<ProxyImportResult>
  check: (ids: string[]) => Promise<void>
  cancelCheck: () => Promise<void>
  remove: (ids: string[]) => Promise<void>
  rotate: (id: string) => Promise<void>
}

function setFlag(record: Record<string, true>, ids: readonly string[], on: boolean): Record<string, true> {
  const next = { ...record }
  for (const id of ids) {
    if (on) next[id] = true
    else delete next[id]
  }
  return next
}

function profilesUsing(ids: readonly string[]): number {
  const targets = new Set(ids)
  return Object.values(useProfilesStore.getState().byId).filter(
    (profile) => profile.deletedAt === null && profile.proxyId !== null && targets.has(profile.proxyId),
  ).length
}

function location(outcome: ProxyCheckOutcome): string {
  return [outcome.city, countryName(outcome.countryCode)].filter(Boolean).join(', ')
}

/** Nome do proxy (apelido ou endereço) para os avisos; null se ele não está mais no catálogo. */
function nameOf(id: string | undefined): string | null {
  const proxy = id ? useCatalogStore.getState().proxiesById[id] : undefined
  return proxy ? proxyLabel(proxy) : null
}

function joinDetails(...parts: (string | null | undefined)[]): string | undefined {
  return parts.filter(Boolean).join(' · ') || undefined
}

export const useProxiesStore = create<ProxiesState>()((set, get) => ({
  filters: EMPTY_PROXY_FILTERS,
  selection: {},
  sorting: [],
  lastToggledId: null,
  visibleIds: [],
  progress: null,
  checking: {},
  rotating: {},
  health: {},

  setFilters: (patch) => set((state) => ({ filters: { ...state.filters, ...patch } })),
  clearFilters: () => set({ filters: EMPTY_PROXY_FILTERS }),
  setSelection: (selection) => set({ selection }),
  clearSelection: () => set({ selection: {}, lastToggledId: null }),
  setSorting: (sorting) => set({ sorting }),
  setLastToggled: (id) => set({ lastToggledId: id }),
  setVisibleIds: (ids) => set({ visibleIds: ids }),
  selectedIds: () =>
    Object.entries(get().selection)
      .filter(([, selected]) => selected)
      .map(([id]) => id),
  forget: (ids) => {
    if (ids.length === 0) return
    set((state) => {
      const selection = { ...state.selection }
      for (const id of ids) delete selection[id]
      return { selection }
    })
  },

  applyProgress: (progress) => set({ progress }),

  applyHealth: (event) => {
    clearTimeout(healthTimers.get(event.profileId))
    healthTimers.set(
      event.profileId,
      setTimeout(() => get().clearHealth(event.profileId), HEALTH_TTL_MS),
    )
    set((state) => ({ health: { ...state.health, [event.profileId]: event } }))
  },
  clearHealth: (profileId) => {
    clearTimeout(healthTimers.get(profileId))
    healthTimers.delete(profileId)
    if (!get().health[profileId]) return
    set((state) => {
      const health = { ...state.health }
      delete health[profileId]
      return { health }
    })
  },

  create: async (input) => {
    const proxy = await invoke('proxies.create', input)
    useCatalogStore.getState().applyProxies({ upserted: [proxy], removedIds: [] })
    toast.success(i18next.t('proxyToasts.created'))
    return proxy
  },

  update: async (id, patch) => {
    const proxy = await invoke('proxies.update', { id, patch })
    useCatalogStore.getState().applyProxies({ upserted: [proxy], removedIds: [] })
    toast.success(i18next.t('proxyToasts.saved'))
    return proxy
  },

  testDraft: (input) => invoke('proxies.testDraft', input),

  importText: async (text, defaultType, checkAfter) => {
    const result = await invoke('proxies.import', { text, defaultType, checkAfter })
    useCatalogStore.getState().applyProxies({ upserted: result.created, removedIds: [] })
    toast.success(i18next.t('proxyToasts.imported', { count: result.created.length }), {
      description: i18next.t('proxyToasts.importedDetails', {
        duplicates: result.duplicates,
        invalid: result.invalid,
      }),
    })
    return result
  },

  check: async (ids) => {
    const targets = ids.filter((id) => !get().checking[id])
    if (targets.length === 0) return
    set((state) => ({ checking: setFlag(state.checking, targets, true) }))
    try {
      const results = await invoke('proxies.check', { ids: targets })
      const done = results.filter((r) => r.outcome.error?.code !== 'CANCELLED')
      if (targets.length === 1 && done[0]) {
        const { outcome } = done[0]
        const name = nameOf(done[0].id)
        if (outcome.status === 'online') {
          toast.success(i18next.t('proxyToasts.online', { ip: outcome.exitIp ?? '?' }), {
            description: joinDetails(name, location(outcome)),
          })
        } else {
          const realIp = outcome.error?.code === 'PROXY_REAL_IP'
          toast.error(i18next.t(realIp ? 'proxyToasts.realIp' : 'proxyToasts.offline'), {
            description: joinDetails(
              name,
              outcome.error ? describeError(AppError.fromPayload(outcome.error)) : null,
            ),
          })
        }
      } else if (done.length > 0) {
        const online = done.filter((r) => r.outcome.status === 'online').length
        toast.success(i18next.t('proxyToasts.checked', { count: done.length }), {
          description: i18next.t('proxyToasts.checkedDetails', { online, offline: done.length - online }),
        })
      }
    } catch (error) {
      toastError(error)
    } finally {
      set((state) => ({ checking: setFlag(state.checking, targets, false) }))
    }
  },

  cancelCheck: async () => {
    try {
      await invoke('proxies.cancelCheck')
    } catch (error) {
      toastError(error)
    }
  },

  remove: async (ids) => {
    if (ids.length === 0) return
    const used = profilesUsing(ids)
    const confirmed = await useUiStore.getState().requestConfirm({
      title: i18next.t('proxyDelete.title', { count: ids.length }),
      description:
        used > 0
          ? i18next.t('proxyDelete.inUse', { count: used })
          : i18next.t('proxyDelete.description', { count: ids.length }),
      confirmLabel: i18next.t('common.delete'),
      destructive: true,
    })
    if (!confirmed) return
    const run = async (confirmInUse: boolean): Promise<void> => {
      const result = await invoke('proxies.delete', { ids, confirmInUse })
      get().forget(ids)
      toast.success(i18next.t('proxyToasts.deleted', { count: result.count }), {
        description:
          result.detachedProfiles > 0
            ? i18next.t('proxyToasts.detached', { count: result.detachedProfiles })
            : undefined,
      })
    }
    try {
      await run(used > 0)
    } catch (error) {
      // outro perfil passou a usar o proxy depois do aviso: confirma de novo com o número certo
      if (error instanceof AppError && error.code === 'PROXY_IN_USE') {
        const count = (error.details as { profiles?: number } | undefined)?.profiles ?? 0
        const again = await useUiStore.getState().requestConfirm({
          title: i18next.t('proxyDelete.title', { count: ids.length }),
          description: i18next.t('proxyDelete.inUse', { count }),
          confirmLabel: i18next.t('common.delete'),
          destructive: true,
        })
        if (!again) return
        try {
          await run(true)
        } catch (retryError) {
          toastError(retryError)
        }
        return
      }
      toastError(error)
    }
  },

  rotate: async (id) => {
    if (get().rotating[id]) return
    set((state) => ({ rotating: setFlag(state.rotating, [id], true) }))
    try {
      const result = await invoke('proxies.rotate', { id })
      const name = proxyLabel(result.proxy)
      if (result.proxy.checkStatus === 'offline' && result.proxy.lastErrorCode === 'PROXY_REAL_IP') {
        // O provedor trocou (ou não) o IP, mas a saída continua sendo a conexão do usuário.
        toast.error(i18next.t('proxyToasts.realIp'), {
          description: joinDetails(name, i18next.t('proxies.realIpHint', { ip: result.currentIp ?? '?' })),
        })
      } else if (result.changed) {
        toast.success(i18next.t('proxyToasts.rotated', { ip: result.currentIp ?? '?' }), {
          description: joinDetails(
            name,
            result.previousIp ? i18next.t('proxyToasts.rotatedFrom', { ip: result.previousIp }) : null,
          ),
        })
      } else {
        toast.warning(i18next.t('proxyToasts.rotateUnchanged'), {
          description: joinDetails(name, i18next.t('proxyToasts.rotateUnchangedHint')),
        })
      }
      // País novo tem a mensagem própria; fuso ou coordenadas novos no mesmo país também
      // pedem reinício, porque a sessão aberta mantém os valores da abertura.
      if (result.runningProfileIds.length > 0 && (result.countryChanged || result.fingerprintChanged)) {
        useUiStore
          .getState()
          .openRestartPrompt(result.runningProfileIds, result.countryChanged ? 'country' : 'fingerprint')
      }
    } catch (error) {
      toastError(error, i18next.t('proxyToasts.rotateFailed'))
    } finally {
      set((state) => ({ rotating: setFlag(state.rotating, [id], false) }))
    }
  },
}))

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

/** Busca (todas as palavras precisam aparecer) + filtros de tipo, status e país. */
export function filterProxyRows(rows: readonly ProxyRow[], filters: ProxyFilters): ProxyRow[] {
  const tokens = normalize(filters.search).split(/\s+/).filter(Boolean)
  return rows.filter((row) => {
    if (filters.types.length > 0 && !filters.types.includes(row.type)) return false
    if (filters.statuses.length > 0 && !filters.statuses.includes(row.checkStatus)) return false
    if (filters.countries.length > 0 && !filters.countries.includes(row.countryCode ?? NO_COUNTRY))
      return false
    if (tokens.length === 0) return true
    const haystack = normalize(
      [
        row.name ?? '',
        row.host,
        String(row.port),
        `${row.host}:${row.port}`,
        row.username,
        row.type,
        row.exitIp ?? '',
        row.city ?? '',
        row.region ?? '',
        row.countryCode ?? '',
        countryName(row.countryCode) ?? '',
        row.notes,
      ].join(' '),
    )
    return tokens.every((token) => haystack.includes(token))
  })
}
