import {
  Ban,
  Copy,
  CopyPlus,
  Download,
  Ellipsis,
  FolderInput,
  FolderOpen,
  Globe,
  Pencil,
  RefreshCcwDot,
  Trash2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { invoke, toastError } from '@renderer/lib/ipc'
import { useProfilesStore, type ProfileRow } from '@renderer/stores/profiles.store'
import { useProxiesStore } from '@renderer/stores/proxies.store'
import { useUiStore } from '@renderer/stores/ui.store'

export function RowActions({ profile }: { profile: ProfileRow }) {
  const { t } = useTranslation()
  const openEditDrawer = useUiStore((s) => s.openEditDrawer)
  const openAssignProxy = useUiStore((s) => s.openAssignProxy)
  const openMoveToGroup = useUiStore((s) => s.openMoveToGroup)
  const clone = useProfilesStore((s) => s.clone)
  const trash = useProfilesStore((s) => s.trash)
  const assignProxy = useProfilesStore((s) => s.assignProxy)
  const rotate = useProxiesStore((s) => s.rotate)
  const rotating = useProxiesStore((s) => (profile.proxy ? Boolean(s.rotating[profile.proxy.id]) : false))

  const copyId = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(profile.id)
      toast.success(t('toasts.idCopied'), { description: profile.id })
    } catch (error) {
      toastError(error)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t('profiles.columns.menu')} data-testid="row-menu">
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => openEditDrawer(profile.id)}>
          <Pencil />
          {t('profiles.menu.edit')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void clone(profile.id)} data-testid="menu-clone">
          <CopyPlus />
          {t('profiles.menu.clone')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void copyId()}>
          <Copy />
          {t('profiles.menu.copyId')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => useUiStore.getState().openExportProfiles([profile.id])}
          data-testid="menu-export"
        >
          <Download />
          {t('bulk.export')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openAssignProxy([profile.id])}>
          <Globe />
          {t('profiles.menu.assignProxy')}
        </DropdownMenuItem>
        {profile.proxy?.rotating && (
          <DropdownMenuItem
            disabled={rotating}
            onSelect={() => profile.proxy && void rotate(profile.proxy.id)}
            data-testid="menu-rotate-ip"
          >
            <RefreshCcwDot />
            {t('proxies.rotate')}
          </DropdownMenuItem>
        )}
        {profile.proxyId && (
          <DropdownMenuItem onSelect={() => void assignProxy([profile.id], null)}>
            <Ban />
            {t('profiles.menu.removeProxy')}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => openMoveToGroup([profile.id])}>
          <FolderInput />
          {t('profiles.menu.moveToGroup')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => void invoke('browser.openProfileFolder', { id: profile.id }).catch(toastError)}
        >
          <FolderOpen />
          {t('profiles.menu.openFolder')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => void trash([profile.id])}
          data-testid="menu-trash"
        >
          <Trash2 />
          {t('profiles.menu.trash')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
