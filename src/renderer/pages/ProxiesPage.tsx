import {
  Activity,
  Globe,
  LoaderCircle,
  Network,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  PROXY_CHECK_STATUSES,
  PROXY_TYPES,
  type ProxyCheckStatus,
  type ProxyType,
} from '@shared/schemas/proxy'
import { CountryFlag } from '@renderer/components/common/CountryFlag'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { MultiFilter, type FilterOption } from '@renderer/components/profiles/ProfileFilters'
import { ProxiesTable } from '@renderer/components/proxies/ProxiesTable'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Separator } from '@renderer/components/ui/separator'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { countryName, formatNumber } from '@renderer/lib/format'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import {
  filterProxyRows,
  hasProxyFilters,
  NO_COUNTRY,
  useProxiesStore,
  type ProxyRow,
} from '@renderer/stores/proxies.store'
import { useUiStore } from '@renderer/stores/ui.store'

const TYPE_LABELS: Record<ProxyType, string> = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5' }

function TableSkeleton() {
  return (
    <div className="flex flex-col" aria-busy="true">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-6 border-b px-4">
          <Skeleton className="size-4 rounded-[4px]" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-8 w-24 rounded-md" />
        </div>
      ))}
    </div>
  )
}

function ProxiesToolbar({ rows }: { rows: ProxyRow[] }) {
  const { t } = useTranslation()
  const filters = useProxiesStore((s) => s.filters)
  const setFilters = useProxiesStore((s) => s.setFilters)
  const clearFilters = useProxiesStore((s) => s.clearFilters)
  const inputRef = useRef<HTMLInputElement>(null)

  const typeOptions: FilterOption[] = PROXY_TYPES.map((type) => ({
    value: type,
    label: TYPE_LABELS[type],
    count: rows.filter((row) => row.type === type).length,
  }))
  const statusOptions: FilterOption[] = PROXY_CHECK_STATUSES.map((status) => ({
    value: status,
    label: t(`proxies.statusFilter.${status}`),
    count: rows.filter((row) => row.checkStatus === status).length,
  }))
  const countryOptions = useMemo<FilterOption[]>(() => {
    const counts = new Map<string, number>()
    for (const row of rows) {
      const code = row.countryCode ?? NO_COUNTRY
      counts.set(code, (counts.get(code) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([code, count]) => ({
        value: code,
        label: code === NO_COUNTRY ? t('proxies.noCountry') : (countryName(code) ?? code),
        icon: code === NO_COUNTRY ? undefined : <CountryFlag code={code} />,
        count,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [rows, t])

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={filters.search}
          onChange={(event) => setFilters({ search: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filters.search) {
              event.stopPropagation()
              setFilters({ search: '' })
            }
          }}
          placeholder={t('proxies.searchPlaceholder')}
          className="h-9 bg-card pr-9 pl-9"
          spellCheck={false}
          data-testid="proxies-search"
        />
        {filters.search && (
          <button
            type="button"
            onClick={() => {
              setFilters({ search: '' })
              inputRef.current?.focus()
            }}
            aria-label={t('common.clear')}
            className="absolute top-1/2 right-2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <MultiFilter
        icon={Network}
        label={t('proxies.filters.type')}
        options={typeOptions}
        selected={filters.types}
        onChange={(values) => setFilters({ types: values as ProxyType[] })}
        testId="proxy-filter-type"
      />
      <MultiFilter
        icon={Activity}
        label={t('proxies.filters.status')}
        options={statusOptions}
        selected={filters.statuses}
        onChange={(values) => setFilters({ statuses: values as ProxyCheckStatus[] })}
        testId="proxy-filter-status"
      />
      <MultiFilter
        icon={Globe}
        label={t('proxies.filters.country')}
        options={countryOptions}
        selected={filters.countries}
        onChange={(values) => setFilters({ countries: values })}
        testId="proxy-filter-country"
      />
      {hasProxyFilters(filters) && (
        <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
          {t('filters.clearAll')}
        </Button>
      )}
    </div>
  )
}

/** Progresso da verificação em lote (todas as verificações em andamento somadas). */
function CheckProgressBanner() {
  const { t } = useTranslation()
  const progress = useProxiesStore((s) => s.progress)
  const cancelCheck = useProxiesStore((s) => s.cancelCheck)
  if (!progress?.running || progress.total === 0) return null
  const percent = Math.min(100, Math.round((progress.done / progress.total) * 100))
  return (
    <div
      className="mb-3 flex items-center gap-4 rounded-lg border bg-card px-4 py-2.5 text-sm shadow-soft"
      role="status"
      data-testid="check-progress"
    >
      <LoaderCircle className="size-4 shrink-0 animate-spin text-primary" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <span className="font-medium">
            {t('proxies.progress', {
              done: formatNumber(progress.done),
              total: formatNumber(progress.total),
            })}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {t('proxies.progressDetails', { online: progress.online, offline: progress.offline })}
          </span>
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={() => void cancelCheck()} data-testid="check-cancel">
        {t('common.cancel')}
      </Button>
    </div>
  )
}

function ProxyBulkBar() {
  const { t } = useTranslation()
  const selection = useProxiesStore((s) => s.selection)
  const check = useProxiesStore((s) => s.check)
  const remove = useProxiesStore((s) => s.remove)
  const clearSelection = useProxiesStore((s) => s.clearSelection)
  const ids = useMemo(
    () =>
      Object.entries(selection)
        .filter(([, selected]) => selected)
        .map(([id]) => id),
    [selection],
  )
  if (ids.length === 0) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-10 z-20 flex justify-center px-6">
      <div
        role="toolbar"
        aria-label={t('bulk.selected', { count: ids.length })}
        data-testid="proxy-bulk-bar"
        className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border bg-popover p-1.5 shadow-float animate-in fade-in slide-in-from-bottom-2"
      >
        <span className="px-3 text-sm font-semibold whitespace-nowrap tabular-nums">
          {t('bulk.selected', { count: ids.length })}
        </span>
        <Separator orientation="vertical" className="mx-1 h-6!" />
        <Button variant="ghost" size="sm" onClick={() => void check(ids)} data-testid="proxy-bulk-check">
          <RefreshCw />
          {t('proxies.check')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => void remove(ids)}
          data-testid="proxy-bulk-delete"
        >
          <Trash2 />
          {t('common.delete')}
        </Button>
        <Separator orientation="vertical" className="mx-1 h-6!" />
        <Button variant="ghost" size="icon-sm" onClick={clearSelection} aria-label={t('bulk.clearSelection')}>
          <X />
        </Button>
      </div>
    </div>
  )
}

export function ProxiesPage() {
  const { t } = useTranslation()
  const loaded = useCatalogStore((s) => s.loaded)
  const proxies = useCatalogStore((s) => s.proxies)
  const profilesById = useProfilesStore((s) => s.byId)
  const filters = useProxiesStore((s) => s.filters)
  const setSelection = useProxiesStore((s) => s.setSelection)
  const setVisibleIds = useProxiesStore((s) => s.setVisibleIds)
  const clearFilters = useProxiesStore((s) => s.clearFilters)
  const openProxyEditor = useUiStore((s) => s.openProxyEditor)
  const setProxyImportOpen = useUiStore((s) => s.setProxyImportOpen)

  const rows = useMemo<ProxyRow[]>(() => {
    const usage = new Map<string, number>()
    for (const profile of Object.values(profilesById)) {
      if (profile.deletedAt === null && profile.proxyId) {
        usage.set(profile.proxyId, (usage.get(profile.proxyId) ?? 0) + 1)
      }
    }
    return proxies.map((proxy) => ({ ...proxy, usage: usage.get(proxy.id) ?? 0 }))
  }, [proxies, profilesById])
  const visible = useMemo(() => filterProxyRows(rows, filters), [rows, filters])

  // a seleção acompanha o que está visível: um filtro novo nunca deixa proxies escondidos selecionados
  useEffect(() => {
    const visibleIds = new Set(visible.map((row) => row.id))
    const current = useProxiesStore.getState().selection
    const selected = Object.keys(current).filter((id) => current[id])
    if (selected.some((id) => !visibleIds.has(id))) {
      setSelection(Object.fromEntries(selected.filter((id) => visibleIds.has(id)).map((id) => [id, true])))
    }
    if (visible.length === 0) setVisibleIds([])
  }, [visible, setSelection, setVisibleIds])

  const description = hasProxyFilters(filters)
    ? t('proxies.filteredCount', { shown: visible.length, total: rows.length })
    : t('proxies.count', { count: rows.length })

  const actions = (
    <>
      <Button variant="outline" onClick={() => setProxyImportOpen(true)} data-testid="proxy-import">
        <Upload />
        {t('proxies.import')}
      </Button>
      <Button onClick={() => openProxyEditor(null)} data-testid="proxy-add">
        <Plus />
        {t('proxies.add')}
      </Button>
    </>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={t('proxiesPage.title')}
        description={loaded ? description : t('common.loading')}
        actions={actions}
      >
        {rows.length > 0 && <ProxiesToolbar rows={rows} />}
      </PageHeader>
      <div className="relative flex min-h-0 flex-1 flex-col px-6 pb-6">
        <CheckProgressBanner />
        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-card shadow-soft">
          {!loaded ? (
            <TableSkeleton />
          ) : rows.length === 0 ? (
            <EmptyState
              variant="proxies"
              title={t('proxiesPage.emptyTitle')}
              description={t('proxiesPage.emptyDescription')}
              action={
                <div className="flex gap-2">
                  <Button variant="outline" onClick={() => setProxyImportOpen(true)}>
                    <Upload />
                    {t('proxies.import')}
                  </Button>
                  <Button onClick={() => openProxyEditor(null)}>
                    <Plus />
                    {t('proxies.add')}
                  </Button>
                </div>
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              variant="search"
              title={t('profiles.noResults.title')}
              description={t('proxies.noResults')}
              action={
                <Button variant="outline" onClick={clearFilters}>
                  {t('profiles.noResults.action')}
                </Button>
              }
            />
          ) : (
            <ProxiesTable rows={visible} />
          )}
        </div>
        <ProxyBulkBar />
      </div>
    </div>
  )
}
