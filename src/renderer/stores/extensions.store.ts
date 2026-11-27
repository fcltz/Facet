import i18next from 'i18next'
import { toast } from 'sonner'
import { create } from 'zustand'
import type { ExtensionConfigResultEvent, ExtensionsChangedEvent } from '@shared/ipc/events'
import { AppError } from '@shared/ipc/result'
import {
  permissionWarnings,
  hasCriticalWarning,
  CRITICAL_EXTENSION_WARNINGS,
  type ExtensionFileKind,
  type ExtensionImportResult,
  type ExtensionSummary,
} from '@shared/schemas/extension'
import { describeError, invoke, toastError } from '@renderer/lib/ipc'
import { useProfilesStore } from './profiles.store'
import { useUiStore } from './ui.store'

/** Linha da página de extensões: a extensão e quantos perfis ativos a carregam. */
export interface ExtensionRow extends ExtensionSummary {
  usage: number
}

interface ExtensionsState {
  loaded: boolean
  list: ExtensionSummary[]
  /** Instalação em andamento (arquivo, pasta ou Chrome Web Store). */
  importing: boolean
  /** Extensões sendo atualizadas ou substituídas. */
  busy: Record<string, true>
  /** Último resultado de autoconfiguração (a aba do perfil recarrega o estado). */
  lastConfigResult: ExtensionConfigResultEvent | null

  load: () => Promise<void>
  apply: (event: ExtensionsChangedEvent) => void
  applyConfigResult: (event: ExtensionConfigResultEvent) => void
  importFile: (kind: ExtensionFileKind) => Promise<void>
  /** Lança o erro: o diálogo decide como mostrá-lo. */
  importWebStore: (input: string) => Promise<ExtensionImportResult>
  refresh: (id: string) => Promise<void>
  replace: (id: string, kind: ExtensionFileKind) => Promise<void>
  setDefault: (id: string, isDefault: boolean) => Promise<void>
  assignAll: (id: string, enabled: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Lança o erro: o diálogo decide como mostrá-lo. */
}

/** Perfis ativos que carregam a extensão (o mesmo número que a página mostra). */
export function profilesUsingExtension(id: string): number {
  return Object.values(useProfilesStore.getState().byId).filter(
    (profile) => profile.deletedAt === null && profile.extensionIds.includes(id),
  ).length
}

/** Permissões críticas da extensão (ex.: "proxy", "privacy"), para os avisos. */
export function criticalPermissions(extension: Pick<ExtensionSummary, 'permissions' | 'source'>): string {
  return permissionWarnings(extension)
    .filter((warning) => CRITICAL_EXTENSION_WARNINGS.includes(warning))
    .map((warning) => `"${warning}"`)
    .join(', ')
}

function byName(a: ExtensionSummary, b: ExtensionSummary): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
}

function name(id: string): string {
  return useExtensionsStore.getState().list.find((extension) => extension.id === id)?.name ?? id
}

/** Falha de instalação: o motivo exato (manifest, assinatura, rede) vai na descrição. */
function importFailed(error: unknown): void {
  if (error instanceof AppError && error.code === 'CANCELLED') return
  toast.error(i18next.t('extensionToasts.importFailed'), { description: describeError(error) })
}

function importToast(result: ExtensionImportResult): void {
  const { extension, status, previousVersion } = result
  const values = { name: extension.name, version: extension.version }
  if (status === 'updated') {
    toast.success(i18next.t('extensionToasts.updated', values), {
      description: i18next.t('extensionToasts.updatedFrom', { version: previousVersion ?? '?' }),
    })
  } else if (status === 'reinstalled') {
    toast.success(i18next.t('extensionToasts.reinstalled', values), {
      description: i18next.t('extensionToasts.applyHint'),
    })
  } else {
    toast.success(i18next.t('extensionToasts.added', values))
  }
}

export const useExtensionsStore = create<ExtensionsState>()((set, get) => {
  const upsert = (items: readonly ExtensionSummary[]): void => {
    if (items.length === 0) return
    set((state) => {
      const byId = new Map(state.list.map((extension) => [extension.id, extension]))
      for (const item of items) byId.set(item.id, item)
      return { list: [...byId.values()].sort(byName) }
    })
  }

  const withBusy = async (id: string, action: () => Promise<void>): Promise<void> => {
    if (get().busy[id]) return
    set((state) => ({ busy: { ...state.busy, [id]: true } }))
    try {
      await action()
    } finally {
      set((state) => {
        const busy = { ...state.busy }
        delete busy[id]
        return { busy }
      })
    }
  }

  return {
    loaded: false,
    list: [],
    importing: false,
    busy: {},
    lastConfigResult: null,

    load: async () => {
      try {
        const list = await invoke('extensions.list')
        set({ list: [...list].sort(byName), loaded: true })
      } catch (error) {
        set({ loaded: true })
        toastError(error, i18next.t('errors.loadFailed'))
      }
    },

    apply: ({ upserted, removedIds }) => {
      if (removedIds.length > 0) {
        const removed = new Set(removedIds)
        set((state) => ({ list: state.list.filter((extension) => !removed.has(extension.id)) }))
      }
      upsert(upserted)
    },

    applyConfigResult: (event) => {
      set({ lastConfigResult: event })
      if (event.ok) return
      const profile = useProfilesStore.getState().byId[event.profileId]
      toast.error(
        i18next.t('extensionToasts.configFailed', {
          extension: name(event.extensionId),
          profile: profile?.name ?? event.profileId,
        }),
        { description: event.error ? describeError(AppError.fromPayload(event.error)) : undefined },
      )
    },

    importFile: async (kind) => {
      if (get().importing) return
      set({ importing: true })
      try {
        const result = await invoke('extensions.importFile', { kind })
        if (result) {
          upsert([result.extension])
          importToast(result)
        }
      } catch (error) {
        importFailed(error)
      } finally {
        set({ importing: false })
      }
    },

    importWebStore: async (input) => {
      set({ importing: true })
      try {
        const result = await invoke('extensions.importWebStore', { input })
        upsert([result.extension])
        importToast(result)
        return result
      } finally {
        set({ importing: false })
      }
    },

    refresh: (id) =>
      withBusy(id, async () => {
        try {
          const result = await invoke('extensions.refresh', { id })
          upsert([result.extension])
          importToast(result)
        } catch (error) {
          importFailed(error)
        }
      }),

    replace: (id, kind) =>
      withBusy(id, async () => {
        try {
          const result = await invoke('extensions.replace', { id, kind })
          if (!result) return
          upsert([result.extension])
          importToast(result)
        } catch (error) {
          importFailed(error)
        }
      }),

    setDefault: async (id, isDefault) => {
      try {
        const updated = await invoke('extensions.setDefault', { ids: [id], isDefault })
        upsert(updated)
        toast.success(
          i18next.t(isDefault ? 'extensionToasts.defaultOn' : 'extensionToasts.defaultOff', {
            name: name(id),
          }),
        )
      } catch (error) {
        toastError(error)
      }
    },

    assignAll: async (id, enabled) => {
      const extension = get().list.find((item) => item.id === id)
      if (!extension) return
      const risky = enabled && hasCriticalWarning(extension)
      const confirmed = await useUiStore.getState().requestConfirm({
        title: i18next.t(enabled ? 'extensionAssign.addTitle' : 'extensionAssign.removeTitle'),
        description: enabled
          ? risky
            ? i18next.t('extensionAssign.riskyAddDescription', {
                name: extension.name,
                permissions: criticalPermissions(extension),
              })
            : i18next.t('extensionAssign.addDescription', { name: extension.name })
          : i18next.t('extensionAssign.removeDescription', { name: extension.name }),
        confirmLabel: i18next.t('common.confirm'),
        destructive: risky || !enabled,
      })
      if (!confirmed) return
      try {
        const result = await invoke('extensions.assign', {
          extensionId: id,
          profileIds: 'allActive',
          enabled,
        })
        if (result.changed === 0) {
          toast.info(i18next.t('extensionToasts.nothingChanged'))
          return
        }
        toast.success(
          i18next.t(enabled ? 'extensionToasts.assigned' : 'extensionToasts.unassigned', {
            count: result.changed,
          }),
          { description: i18next.t('extensionToasts.applyHint') },
        )
        if (result.runningIds.length > 0)
          useUiStore.getState().openRestartPrompt(result.runningIds, 'extensions')
      } catch (error) {
        toastError(error)
      }
    },

    remove: async (id) => {
      const extension = get().list.find((item) => item.id === id)
      if (!extension) return
      const used = profilesUsingExtension(id)
      const ask = (count: number): Promise<boolean> =>
        useUiStore.getState().requestConfirm({
          title: i18next.t('extensionDelete.title'),
          description:
            count > 0
              ? i18next.t('extensionDelete.inUse', { name: extension.name, count })
              : i18next.t('extensionDelete.description', { name: extension.name }),
          confirmLabel: i18next.t('common.delete'),
          destructive: true,
        })
      if (!(await ask(used))) return
      const run = async (confirmInUse: boolean): Promise<void> => {
        const result = await invoke('extensions.delete', { ids: [id], confirmInUse })
        toast.success(i18next.t('extensionToasts.deleted'), {
          description:
            result.detachedProfiles > 0
              ? i18next.t('extensionToasts.detached', { count: result.detachedProfiles })
              : undefined,
        })
      }
      try {
        await run(used > 0)
      } catch (error) {
        // perfis na lixeira (ou alterados agora) também usam a extensão: confirma com o número real
        if (error instanceof AppError && error.code === 'EXTENSION_IN_USE') {
          const count = (error.details as { profiles?: number } | undefined)?.profiles ?? 0
          if (!(await ask(count))) return
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
  }
})
