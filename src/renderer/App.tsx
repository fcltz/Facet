import { useEffect } from 'react'
import { toast } from 'sonner'
import { tr } from '@renderer/i18n'
import { useJobsStore } from '@renderer/stores/jobs.store'
import { ExportProfilesDialog } from '@renderer/components/transfer/ExportProfilesDialog'
import { ImportProfilesDialog } from '@renderer/components/transfer/ImportProfilesDialog'
import { ConfirmDialog } from '@renderer/components/common/ConfirmDialog'
import { ShortcutsDialog } from '@renderer/components/common/ShortcutsDialog'
import { AddFromWebStoreDialog } from '@renderer/components/extensions/AddFromWebStoreDialog'
import { ExtensionConfigDialog } from '@renderer/components/extensions/ExtensionConfigDialog'
import { AppShell } from '@renderer/components/layout/AppShell'
import { AssignProxyDialog } from '@renderer/components/profiles/AssignProxyDialog'
import { BulkCreateDialog } from '@renderer/components/profiles/BulkCreateDialog'
import { ProfileDrawer } from '@renderer/components/profiles/drawer/ProfileDrawer'
import { MoveToGroupDialog } from '@renderer/components/profiles/MoveToGroupDialog'
import { RestartPromptDialog } from '@renderer/components/profiles/RestartPromptDialog'
import { ImportProxiesDialog } from '@renderer/components/proxies/ImportProxiesDialog'
import { ProxyFormDialog } from '@renderer/components/proxies/ProxyFormDialog'
import { Toaster } from '@renderer/components/ui/sonner'
import { TooltipProvider } from '@renderer/components/ui/tooltip'
import { WelcomeScreen } from '@renderer/components/welcome/WelcomeScreen'
import { useHotkeys, type Hotkey } from '@renderer/hooks/use-hotkeys'
import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { useThemeSync } from '@renderer/hooks/use-theme'
import { ExtensionsPage } from '@renderer/pages/ExtensionsPage'
import { GroupsTagsPage } from '@renderer/pages/GroupsTagsPage'
import { ProfilesPage } from '@renderer/pages/ProfilesPage'
import { ProxiesPage } from '@renderer/pages/ProxiesPage'
import { SettingsPage } from '@renderer/pages/SettingsPage'
import { TrashPage } from '@renderer/pages/TrashPage'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { useExtensionsStore } from '@renderer/stores/extensions.store'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useProxiesStore } from '@renderer/stores/proxies.store'
import { useTrafficStore } from '@renderer/stores/traffic.store'
import { useSettingsStore } from '@renderer/stores/settings.store'
import { PAGES, useUiStore, type Page } from '@renderer/stores/ui.store'

/** Carrega os dados iniciais e mantém as stores em sincronia com os eventos do processo principal. */
function useBootstrap(): void {
  useIpcEvent('jobs.progress', (event) => useJobsStore.getState().apply(event))
  useIpcEvent('cookies.applied', (event) => {
    if (event.failed || event.error)
      toast.error(tr('cookiesEditor.applyFailed'), {
        description: event.error ?? tr('cookiesEditor.failedCount', undefined, { count: event.failed }),
      })
  })
  useEffect(() => {
    void useSettingsStore.getState().load()
    void useCatalogStore.getState().load()
    void useProfilesStore.getState().load()
    void useExtensionsStore.getState().load()
  }, [])

  useIpcEvent('profiles.changed', (event) => useProfilesStore.getState().applyChanges(event))
  useIpcEvent('runtime.statusChanged', (event) => {
    useProfilesStore.getState().applyStatus(event)
    // o aviso de falhas do proxy vale só para a sessão aberta
    if (event.status === 'stopped' || event.status === 'starting') {
      useProxiesStore.getState().clearHealth(event.profileId)
      useTrafficStore.getState().clear(event.profileId)
    }
  })
  useIpcEvent('runtime.proxyHealth', (event) => useProxiesStore.getState().applyHealth(event))
  useIpcEvent('runtime.traffic', (event) => useTrafficStore.getState().apply(event))
  useIpcEvent('proxies.changed', (event) => {
    useCatalogStore.getState().applyProxies(event)
    useProxiesStore.getState().forget(event.removedIds)
  })
  useIpcEvent('proxies.checkProgress', (progress) => useProxiesStore.getState().applyProgress(progress))
  useIpcEvent('extensions.changed', (event) => useExtensionsStore.getState().apply(event))
  useIpcEvent('extensions.configResult', (event) => useExtensionsStore.getState().applyConfigResult(event))
  useIpcEvent('catalog.changed', (event) => void useCatalogStore.getState().refresh(event.entity))
  useIpcEvent('settings.changed', (settings) => useSettingsStore.getState().apply(settings))
  useIpcEvent('browsers.changed', (info) => useSettingsStore.getState().setBrowsers(info))
}

/** `active` = falso na tela de boas-vindas: nenhum atalho global funciona por trás dela. */
function useGlobalHotkeys(page: Page, active: boolean): void {
  const ui = useUiStore.getState
  const profiles = useProfilesStore.getState

  const hotkeys: Hotkey[] = [
    {
      combo: 'mod+n',
      handler: () => {
        if (ui().isOverlayOpen()) return
        ui().setPage('profiles')
        ui().openCreateDrawer()
      },
    },
    {
      combo: 'mod+shift+n',
      handler: () => {
        if (ui().isOverlayOpen()) return
        ui().setPage('profiles')
        ui().setBulkCreateOpen(true)
      },
    },
    {
      combo: 'mod+f',
      handler: () => {
        if (ui().isOverlayOpen()) return
        ui().setPage('profiles')
        ui().focusSearch()
      },
    },
    {
      combo: 'mod+a',
      enabled: page === 'profiles',
      handler: () => {
        if (!ui().isOverlayOpen()) profiles().selectVisible()
      },
    },
    {
      combo: 'delete',
      enabled: page === 'profiles',
      handler: () => {
        if (ui().isOverlayOpen()) return
        const ids = profiles().selectedIds()
        if (ids.length > 0) void profiles().trash(ids)
      },
    },
    {
      combo: 'escape',
      enabled: page === 'profiles',
      handler: () => {
        if (!ui().isOverlayOpen()) profiles().clearSelection()
      },
    },
    ...PAGES.map((target, index): Hotkey => ({
      combo: `mod+${index + 1}`,
      handler: () => {
        if (!ui().isOverlayOpen()) ui().setPage(target)
      },
    })),
    {
      combo: 'mod+,',
      handler: () => {
        if (!ui().isOverlayOpen()) ui().setPage('settings')
      },
    },
    {
      combo: '?',
      handler: () => {
        if (!ui().isOverlayOpen()) ui().setShortcutsOpen(true)
      },
    },
  ]

  useHotkeys(active ? hotkeys : hotkeys.map((hotkey) => ({ ...hotkey, enabled: false })))
}

function CurrentPage({ page }: { page: Page }) {
  switch (page) {
    case 'profiles':
      return <ProfilesPage />
    case 'proxies':
      return <ProxiesPage />
    case 'extensions':
      return <ExtensionsPage />
    case 'groups':
      return <GroupsTagsPage />
    case 'trash':
      return <TrashPage />
    case 'settings':
      return <SettingsPage />
  }
}

export function App() {
  const theme = useThemeSync()
  const page = useUiStore((s) => s.page)
  const welcome = useSettingsStore((s) => !s.settings.onboardingCompleted)
  useBootstrap()
  useGlobalHotkeys(page, !welcome)

  // Primeira abertura neste computador: idioma, tema e navegador padrão antes de tudo.
  if (welcome)
    return (
      <TooltipProvider delayDuration={300}>
        <WelcomeScreen theme={theme} />
        <Toaster theme={theme} position="bottom-right" closeButton richColors />
      </TooltipProvider>
    )

  return (
    <TooltipProvider delayDuration={300}>
      <AppShell theme={theme}>
        <CurrentPage page={page} />
      </AppShell>
      <ProfileDrawer />
      <ExportProfilesDialog />
      <ImportProfilesDialog />
      <BulkCreateDialog />
      <AssignProxyDialog />
      <MoveToGroupDialog />
      <RestartPromptDialog />
      <ProxyFormDialog />
      <ImportProxiesDialog />
      <AddFromWebStoreDialog />
      <ExtensionConfigDialog />
      <ConfirmDialog />
      <ShortcutsDialog />
      <Toaster theme={theme} position="bottom-right" closeButton richColors />
    </TooltipProvider>
  )
}
