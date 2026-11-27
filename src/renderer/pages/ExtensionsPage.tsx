import { ChevronDown, FileArchive, FolderOpen, Info, LoaderCircle, Plus, Store } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Notice } from '@renderer/components/common/Field'
import { ExtensionsTable } from '@renderer/components/extensions/ExtensionsTable'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { useExtensionsStore, type ExtensionRow } from '@renderer/stores/extensions.store'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'

function TableSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="flex h-16 items-center gap-6 border-b px-4">
          <Skeleton className="size-9 rounded-lg" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="ml-auto h-8 w-24 rounded-md" />
        </div>
      ))}
    </div>
  )
}

function AddMenu() {
  const { t } = useTranslation()
  const importing = useExtensionsStore((s) => s.importing)
  const importFile = useExtensionsStore((s) => s.importFile)
  const setWebStoreOpen = useUiStore((s) => s.setWebStoreOpen)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button disabled={importing} data-testid="extension-add">
          {importing ? <LoaderCircle className="animate-spin" /> : <Plus />}
          {t('extensionsPage.add')}
          <ChevronDown className="opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuItem onSelect={() => void importFile('archive')} data-testid="extension-add-archive">
          <FileArchive />
          {t('extensionsPage.addArchive')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void importFile('folder')} data-testid="extension-add-folder">
          <FolderOpen />
          {t('extensionsPage.addFolder')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setWebStoreOpen(true)} data-testid="extension-add-webstore">
          <Store />
          {t('extensionsPage.addWebStore')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ExtensionsPage() {
  const { t } = useTranslation()
  const loaded = useExtensionsStore((s) => s.loaded)
  const list = useExtensionsStore((s) => s.list)
  const importing = useExtensionsStore((s) => s.importing)
  const importFile = useExtensionsStore((s) => s.importFile)
  const profilesById = useProfilesStore((s) => s.byId)
  const setWebStoreOpen = useUiStore((s) => s.setWebStoreOpen)

  // uso contado nos perfis ativos (o mesmo que a tabela de perfis mostra)
  const rows = useMemo<ExtensionRow[]>(() => {
    const usage = new Map<string, number>()
    for (const profile of Object.values(profilesById)) {
      if (profile.deletedAt !== null) continue
      for (const id of profile.extensionIds) usage.set(id, (usage.get(id) ?? 0) + 1)
    }
    return list.map((extension) => ({ ...extension, usage: usage.get(extension.id) ?? 0 }))
  }, [list, profilesById])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={t('extensionsPage.title')}
        description={loaded ? t('extensionsPage.count', { count: rows.length }) : t('common.loading')}
        actions={<AddMenu />}
      />
      <div className="relative flex min-h-0 flex-1 flex-col px-6 pb-6">
        {importing && (
          <div
            className="mb-3 flex items-center gap-3 rounded-lg border bg-card px-4 py-2.5 text-sm shadow-soft"
            role="status"
            data-testid="extension-importing"
          >
            <LoaderCircle className="size-4 animate-spin text-primary" />
            {t('extensionsPage.importing')}
          </div>
        )}
        {rows.length > 0 && (
          <Notice className="mb-3" icon={<Info className="size-4" />}>
            {t('extensionsPage.notice')}
          </Notice>
        )}
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-soft">
          {!loaded ? (
            <TableSkeleton />
          ) : rows.length === 0 ? (
            <EmptyState
              variant="extensions"
              title={t('extensionsPage.emptyTitle')}
              description={t('extensionsPage.emptyDescription')}
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button variant="outline" disabled={importing} onClick={() => void importFile('archive')}>
                    <FileArchive />
                    {t('extensionsPage.addArchive')}
                  </Button>
                  <Button variant="outline" disabled={importing} onClick={() => void importFile('folder')}>
                    <FolderOpen />
                    {t('extensionsPage.addFolder')}
                  </Button>
                  <Button onClick={() => setWebStoreOpen(true)}>
                    <Store />
                    {t('extensionsPage.addWebStore')}
                  </Button>
                </div>
              }
            />
          ) : (
            <ExtensionsTable rows={rows} />
          )}
        </div>
      </div>
    </div>
  )
}
