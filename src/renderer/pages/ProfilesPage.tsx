import { Plus } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { BulkActionsBar } from '@renderer/components/profiles/BulkActionsBar'
import { ProfilesTable } from '@renderer/components/profiles/ProfilesTable'
import { NewProfileButton, ProfilesToolbar } from '@renderer/components/profiles/ProfilesToolbar'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { naturalCompare } from '@renderer/lib/format'
import {
  filterProfileRows,
  hasActiveFilters,
  useProfileRows,
  useProfilesStore,
} from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { useSettingsStore } from '@renderer/stores/settings.store'
import { ProfileGroupTabs } from '@renderer/components/profiles/ProfileGroupTabs'

function TableSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true">
      <div className="flex h-10 items-center gap-6 border-b px-4">
        {[40, 120, 70, 90, 80, 120, 110, 80].map((width, i) => (
          <Skeleton key={i} className="h-3" style={{ width }} />
        ))}
      </div>
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-6 border-b px-4">
          <Skeleton className="size-4 rounded-[4px]" />
          <Skeleton className="h-4 w-44" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-28 rounded-md" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="ml-auto h-8 w-20 rounded-md" />
        </div>
      ))}
    </div>
  )
}

export function ProfilesPage() {
  const { t } = useTranslation()
  const loaded = useProfilesStore((s) => s.loaded)
  // O navegador padrão dos perfis novos (o que vem com o Facet, se ninguém trocou) não abre.
  const defaultBrowser = useSettingsStore((s) =>
    s.browsers.find((browser) => browser.kind === s.settings.defaultBrowser),
  )
  const setPage = useUiStore((s) => s.setPage)
  const filters = useProfilesStore((s) => s.filters)
  const setSelection = useProfilesStore((s) => s.setSelection)
  const setVisibleIds = useProfilesStore((s) => s.setVisibleIds)
  const clearFilters = useProfilesStore((s) => s.clearFilters)
  const openCreateDrawer = useUiStore((s) => s.openCreateDrawer)

  const rows = useProfileRows('active')
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => b.createdAt - a.createdAt || naturalCompare(a.name, b.name)),
    [rows],
  )
  const visible = useMemo(() => filterProfileRows(sortedRows, filters), [sortedRows, filters])

  // a seleção acompanha o que está visível: um filtro novo nunca deixa perfis escondidos selecionados
  useEffect(() => {
    const visibleIds = new Set(visible.map((row) => row.id))
    const current = useProfilesStore.getState().selection
    const selected = Object.keys(current).filter((id) => current[id])
    if (selected.some((id) => !visibleIds.has(id))) {
      setSelection(Object.fromEntries(selected.filter((id) => visibleIds.has(id)).map((id) => [id, true])))
    }
    if (visible.length === 0) setVisibleIds([])
  }, [visible, setSelection, setVisibleIds])

  const filtered = hasActiveFilters(filters)
  const description = filtered
    ? t('profiles.filteredCount', { shown: visible.length, total: rows.length })
    : t('profiles.count', { count: rows.length })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={t('profiles.title')}
        description={loaded ? description : t('common.loading')}
        actions={<NewProfileButton />}
      >
        <div className="grid min-w-0 gap-3">
          <ProfileGroupTabs rows={rows} />
          <ProfilesToolbar rows={rows} />
        </div>
      </PageHeader>

      <div className="relative flex min-h-0 flex-1 flex-col px-6 pb-6">
        {defaultBrowser && !defaultBrowser.available && !defaultBrowser.checking && (
          <div className="mb-3 flex items-center justify-between rounded-lg border border-warning/30 bg-warning/10 px-4 py-2 text-sm">
            <span data-testid="browser-unavailable">
              {t('browser.unavailableNamed', { browser: defaultBrowser.name })}
            </span>
            <Button size="sm" variant="outline" onClick={() => setPage('settings')}>
              {t('nav.settings')}
            </Button>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-soft">
          {!loaded ? (
            <TableSkeleton />
          ) : rows.length === 0 ? (
            <EmptyState
              variant="profiles"
              title={t('profiles.empty.title')}
              description={t('profiles.empty.description')}
              action={
                <Button onClick={openCreateDrawer}>
                  <Plus />
                  {t('profiles.empty.action')}
                </Button>
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              variant="search"
              title={t('profiles.noResults.title')}
              description={t('profiles.noResults.description')}
              action={
                <Button variant="outline" onClick={clearFilters}>
                  {t('profiles.noResults.action')}
                </Button>
              }
            />
          ) : (
            <ProfilesTable rows={visible} />
          )}
        </div>
        <BulkActionsBar />
      </div>
    </div>
  )
}
