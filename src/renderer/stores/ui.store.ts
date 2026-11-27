import { create } from 'zustand'

export const PAGES = ['profiles', 'proxies', 'extensions', 'groups', 'trash', 'settings'] as const
export type Page = (typeof PAGES)[number]

export const DRAWER_TABS = ['general', 'proxy', 'fingerprint', 'extensions', 'cookies', 'advanced'] as const
export type DrawerTab = (typeof DRAWER_TABS)[number]

export interface ConfirmOptions {
  title: string
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

interface ConfirmState extends ConfirmOptions {
  open: boolean
}

interface DrawerState {
  open: boolean
  mode: 'create' | 'edit'
  profileId: string | null
  tab: DrawerTab
}

interface IdsDialogState {
  open: boolean
  ids: string[]
}

/** Por que os perfis abertos precisam reiniciar: proxy trocado, país do IP mudou ou extensões mudaram. */
export type RestartReason = 'proxy' | 'country' | 'extensions' | 'fingerprint' | 'browser'

interface RestartPromptState extends IdsDialogState {
  reason: RestartReason
}

interface ProxyEditorState {
  open: boolean
  /** `null` = novo proxy. */
  proxyId: string | null
}

interface ExtensionConfigState {
  open: boolean
  extensionId: string | null
}

interface UiState {
  page: Page
  drawer: DrawerState
  bulkCreateOpen: boolean
  exportProfiles: IdsDialogState
  importProfilesOpen: boolean
  assignProxy: IdsDialogState
  moveToGroup: IdsDialogState
  restartPrompt: RestartPromptState
  proxyEditor: ProxyEditorState
  proxyImportOpen: boolean
  webStoreOpen: boolean
  extensionConfig: ExtensionConfigState
  shortcutsOpen: boolean
  confirm: ConfirmState
  /** Incrementado para pedir foco no campo de busca (atalho Ctrl+F). */
  searchFocusSignal: number

  setPage: (page: Page) => void
  openCreateDrawer: () => void
  openEditDrawer: (profileId: string, tab?: DrawerTab) => void
  setDrawerTab: (tab: DrawerTab) => void
  closeDrawer: () => void
  setBulkCreateOpen: (open: boolean) => void
  openExportProfiles: (ids: string[]) => void
  closeExportProfiles: () => void
  setImportProfilesOpen: (open: boolean) => void
  openAssignProxy: (ids: string[]) => void
  closeAssignProxy: () => void
  openMoveToGroup: (ids: string[]) => void
  closeMoveToGroup: () => void
  openRestartPrompt: (ids: string[], reason?: RestartReason) => void
  closeRestartPrompt: () => void
  openProxyEditor: (proxyId: string | null) => void
  closeProxyEditor: () => void
  setProxyImportOpen: (open: boolean) => void
  setWebStoreOpen: (open: boolean) => void
  openExtensionConfig: (extensionId: string) => void
  closeExtensionConfig: () => void
  setShortcutsOpen: (open: boolean) => void
  /** Abre o diálogo de confirmação e resolve com a escolha do usuário. */
  requestConfirm: (options: ConfirmOptions) => Promise<boolean>
  resolveConfirm: (confirmed: boolean) => void
  focusSearch: () => void
  /** Algum painel ou diálogo do app está aberto (atalhos globais ficam inativos). */
  isOverlayOpen: () => boolean
}

let pendingConfirm: ((confirmed: boolean) => void) | null = null

const closedIds: IdsDialogState = { open: false, ids: [] }

export const useUiStore = create<UiState>()((set, get) => ({
  page: 'profiles',
  drawer: { open: false, mode: 'create', profileId: null, tab: 'general' },
  bulkCreateOpen: false,
  exportProfiles: closedIds,
  importProfilesOpen: false,
  assignProxy: closedIds,
  moveToGroup: closedIds,
  restartPrompt: { ...closedIds, reason: 'proxy' },
  proxyEditor: { open: false, proxyId: null },
  proxyImportOpen: false,
  webStoreOpen: false,
  extensionConfig: { open: false, extensionId: null },
  shortcutsOpen: false,
  confirm: { open: false, title: '' },
  searchFocusSignal: 0,

  setPage: (page) => set({ page }),
  openCreateDrawer: () => set({ drawer: { open: true, mode: 'create', profileId: null, tab: 'general' } }),
  openEditDrawer: (profileId, tab = 'general') =>
    set({ drawer: { open: true, mode: 'edit', profileId, tab } }),
  setDrawerTab: (tab) => set((state) => ({ drawer: { ...state.drawer, tab } })),
  closeDrawer: () => set((state) => ({ drawer: { ...state.drawer, open: false } })),
  setBulkCreateOpen: (open) => set({ bulkCreateOpen: open }),
  openExportProfiles: (ids) => set({ exportProfiles: { open: true, ids } }),
  closeExportProfiles: () => set({ exportProfiles: closedIds }),
  setImportProfilesOpen: (open) => set({ importProfilesOpen: open }),
  openAssignProxy: (ids) => set({ assignProxy: { open: true, ids } }),
  closeAssignProxy: () => set({ assignProxy: closedIds }),
  openMoveToGroup: (ids) => set({ moveToGroup: { open: true, ids } }),
  closeMoveToGroup: () => set({ moveToGroup: closedIds }),
  openRestartPrompt: (ids, reason = 'proxy') => set({ restartPrompt: { open: true, ids, reason } }),
  closeRestartPrompt: () =>
    set((state) => ({ restartPrompt: { ...closedIds, reason: state.restartPrompt.reason } })),
  openProxyEditor: (proxyId) => set({ proxyEditor: { open: true, proxyId } }),
  closeProxyEditor: () => set((state) => ({ proxyEditor: { ...state.proxyEditor, open: false } })),
  setProxyImportOpen: (open) => set({ proxyImportOpen: open }),
  setWebStoreOpen: (open) => set({ webStoreOpen: open }),
  openExtensionConfig: (extensionId) => set({ extensionConfig: { open: true, extensionId } }),
  closeExtensionConfig: () =>
    set((state) => ({ extensionConfig: { ...state.extensionConfig, open: false } })),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

  requestConfirm: (options) => {
    pendingConfirm?.(false)
    set({ confirm: { ...options, open: true } })
    return new Promise<boolean>((resolve) => {
      pendingConfirm = resolve
    })
  },
  resolveConfirm: (confirmed) => {
    pendingConfirm?.(confirmed)
    pendingConfirm = null
    set((state) => ({ confirm: { ...state.confirm, open: false } }))
  },

  focusSearch: () => set((state) => ({ searchFocusSignal: state.searchFocusSignal + 1 })),

  isOverlayOpen: () => {
    const state = get()
    return (
      state.drawer.open ||
      state.bulkCreateOpen ||
      state.exportProfiles.open ||
      state.importProfilesOpen ||
      state.assignProxy.open ||
      state.moveToGroup.open ||
      state.restartPrompt.open ||
      state.proxyEditor.open ||
      state.proxyImportOpen ||
      state.webStoreOpen ||
      state.extensionConfig.open ||
      state.shortcutsOpen ||
      state.confirm.open ||
      document.querySelector('[data-radix-popper-content-wrapper]') !== null
    )
  },
}))
