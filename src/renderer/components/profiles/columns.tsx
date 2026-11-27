import type { Column, ColumnDef, Row, Table } from '@tanstack/react-table'
import type { MouseEvent, ReactNode } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Check,
  ChevronsUpDown,
  LoaderCircle,
  Minus,
  Play,
  Square,
  TriangleAlert,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AppError } from '@shared/ipc/result'
import { formatSerial, type RuntimeStatus } from '@shared/schemas/profile'
import { proxyEndpoint, proxyTitle } from '@shared/schemas/proxy'
import { CountryFlag } from '@renderer/components/common/CountryFlag'
import { BrowserMark, browserVersion } from '@renderer/components/common/BrowserBadge'
import { OsBadge } from '@renderer/components/common/OsBadge'
import { proxyLocation, ProxyStatusPill } from '@renderer/components/common/pickers'
import { StatusLabel } from '@renderer/components/common/StatusDot'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Sparkline } from '@renderer/components/common/Sparkline'
import {
  formatBytes,
  formatDateTime,
  formatRate,
  formatRelative,
  naturalCompare,
  useNow,
} from '@renderer/lib/format'
import { describeError } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { useProfilesStore, type ProfileRow } from '@renderer/stores/profiles.store'
import { useProxiesStore } from '@renderer/stores/proxies.store'
import { TRAFFIC_SAMPLES, useTrafficStore, type ProfileTraffic } from '@renderer/stores/traffic.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { BROWSER_NAMES } from '@shared/constants'
import { useBrowser } from '@renderer/stores/settings.store'
import { RowActions } from './RowActions'
import { PROFILE_COLUMN_LAYOUT } from '@renderer/lib/profile-table-layout'
import { RESIZABLE_PROFILE_COLUMNS } from '@shared/schemas/profile-table'
import { ProfileGroupEditor, ProfileTagsEditor } from './ProfileMetadataEditors'

export const ROW_HEIGHT = 56

const STATUS_RANK: Record<RuntimeStatus, number> = {
  running: 0,
  starting: 1,
  stopping: 2,
  disconnected: 3,
  error: 4,
  stopped: 5,
}

/** Alterna a seleção de uma linha; com Shift seleciona o intervalo desde a última linha clicada. */
export function toggleRowSelection(table: Table<ProfileRow>, row: Row<ProfileRow>, withRange: boolean): void {
  const store = useProfilesStore.getState()
  const nextValue = !row.getIsSelected()
  const rows = table.getRowModel().rows
  const anchor = withRange && store.lastToggledId ? rows.findIndex((r) => r.id === store.lastToggledId) : -1
  const target = rows.findIndex((r) => r.id === row.id)
  if (anchor >= 0 && target >= 0) {
    const [from, to] = anchor < target ? [anchor, target] : [target, anchor]
    const next = { ...table.getState().rowSelection }
    for (let i = from; i <= to; i++) {
      const id = rows[i]?.id
      if (!id) continue
      if (nextValue) next[id] = true
      else delete next[id]
    }
    table.setRowSelection(next)
  } else {
    row.toggleSelected(nextValue)
  }
  store.setLastToggled(row.id)
}

export function CheckSquare({
  state,
  label,
  onClick,
}: {
  state: boolean | 'indeterminate'
  label: string
  onClick: (event: MouseEvent) => void
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === 'indeterminate' ? 'mixed' : state}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'flex size-4 items-center justify-center rounded-[4px] border shadow-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        state
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-input bg-background hover:border-primary/60',
      )}
    >
      {state === 'indeterminate' ? (
        <Minus className="size-3" strokeWidth={3} />
      ) : state ? (
        <Check className="size-3" strokeWidth={3} />
      ) : null}
    </button>
  )
}

function HeaderCheckbox({ table }: { table: Table<ProfileRow> }) {
  const { t } = useTranslation()
  const state = table.getIsAllRowsSelected() ? true : table.getIsSomeRowsSelected() ? 'indeterminate' : false
  return (
    <CheckSquare
      state={state}
      label={t('profiles.columns.select')}
      onClick={() => table.toggleAllRowsSelected(state !== true)}
    />
  )
}

function RowCheckbox({ table, row }: { table: Table<ProfileRow>; row: Row<ProfileRow> }) {
  const { t } = useTranslation()
  return (
    <CheckSquare
      state={row.getIsSelected()}
      label={t('profiles.selectRow', { name: row.original.name })}
      onClick={(event) => toggleRowSelection(table, row, event.shiftKey)}
    />
  )
}

type HeaderKey =
  | 'profiles.columns.serial'
  | 'profiles.columns.name'
  | 'profiles.columns.status'
  | 'profiles.columns.group'
  | 'profiles.columns.tags'
  | 'profiles.columns.proxy'
  | 'profiles.columns.system'
  | 'profiles.columns.lastOpened'
  | 'profiles.columns.actions'

function ColumnHeader({ column, labelKey }: { column: Column<ProfileRow>; labelKey: HeaderKey }) {
  const { t } = useTranslation()
  const label = t(labelKey)
  if (!column.getCanSort())
    return (
      <span className="truncate" title={label}>
        {label}
      </span>
    )
  const sorted = column.getIsSorted()
  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ChevronsUpDown
  return (
    <button
      type="button"
      onClick={column.getToggleSortingHandler()}
      className={cn(
        '-ml-1.5 inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-accent hover:text-foreground',
        sorted && 'text-foreground',
      )}
    >
      <span className="truncate" title={label}>
        {label}
      </span>
      <Icon className={cn('size-3.5 shrink-0', !sorted && 'opacity-50')} />
    </button>
  )
}

function NameCell({ row }: { row: ProfileRow }) {
  const openEditDrawer = useUiStore((s) => s.openEditDrawer)
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <span
        aria-hidden
        className="h-8 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: row.color ?? 'transparent' }}
      />
      <div className="min-w-0">
        <button
          type="button"
          onClick={() => openEditDrawer(row.id)}
          className="block max-w-full truncate text-left text-sm font-medium text-foreground underline-offset-2 hover:text-primary hover:underline"
          data-testid="profile-name"
          title={row.name}
        >
          {row.name}
        </button>
        {row.notes && (
          <p className="truncate text-xs text-muted-foreground" title={row.notes}>
            {row.notes}
          </p>
        )}
      </div>
    </div>
  )
}

function StatusCell({ row }: { row: ProfileRow }) {
  const { t } = useTranslation()
  const error = useProfilesStore((s) => s.runtimeErrors[row.id])
  const health = useProxiesStore((s) => s.health[row.id])
  const label = (
    <span className="min-w-0 max-w-full" title={t(`status.${row.status}`)}>
      <StatusLabel status={row.status} className="min-w-0 max-w-full [&>span:last-child]:truncate" />
    </span>
  )
  if (row.status === 'running' && health && health.failures > 0) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="proxy-health-warning">
            {label}
            <TriangleAlert
              className="size-3.5 shrink-0 text-warning"
              aria-label={t('profiles.proxyFailing')}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs space-y-1">
          <p className="font-medium">{t('profiles.proxyFailingCount', { count: health.failures })}</p>
          {health.lastError && <p className="opacity-80">{health.lastError}</p>}
        </TooltipContent>
      </Tooltip>
    )
  }
  if (!['error', 'disconnected'].includes(row.status) || !error) return label
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{label}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{describeError(AppError.fromPayload(error))}</TooltipContent>
    </Tooltip>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>
}

function GroupCell({ row }: { row: ProfileRow }) {
  return <ProfileGroupEditor row={row} />
}

function TagsCell({ row }: { row: ProfileRow }) {
  return <ProfileTagsEditor row={row} />
}

/** Perfil aberto com proxy: tráfego do último minuto e a taxa atual, no lugar do nome da proxy. */
function ProxyTraffic({
  proxy,
  traffic,
}: {
  proxy: NonNullable<ProfileRow['proxy']>
  traffic: ProfileTraffic
}) {
  const { t } = useTranslation()
  const location = proxyLocation(proxy)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex min-w-0 items-center gap-2" data-testid="proxy-traffic">
          <Sparkline
            values={traffic.samples}
            points={TRAFFIC_SAMPLES}
            className="h-[18px] min-w-5 max-w-[72px] flex-1 text-primary"
            label={t('profiles.trafficChart')}
          />
          {/* a taxa nunca é cortada: numa coluna estreita, quem encolhe é o gráfico */}
          <span
            className="shrink-0 whitespace-nowrap text-[13px] tabular-nums"
            data-testid="proxy-traffic-rate"
          >
            {formatRate(traffic.bytesPerSecond)}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="space-y-1">
        <div className="font-medium">{proxy.name || proxyTitle(proxy)}</div>
        <div className="font-mono">
          {proxy.type.toUpperCase()} {proxyEndpoint(proxy)}
        </div>
        {/* IP de saída e local (a célula mostra o tráfego enquanto o perfil está aberto) */}
        {(proxy.exitIp || location) && (
          <div className="tabular-nums">{[location, proxy.exitIp].filter(Boolean).join(' · ')}</div>
        )}
        <div data-testid="proxy-traffic-total">
          {t('profiles.trafficTotal', { total: formatBytes(traffic.total) })}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function ProxyCell({ row }: { row: ProfileRow }) {
  const { t } = useTranslation()
  const traffic = useTrafficStore((s) => s.byProfile[row.id])
  const proxy = row.proxy
  if (!proxy) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"
        title={t('profiles.directConnection')}
      >
        <Ban className="size-3.5 shrink-0" />
        <span className="truncate">{t('profiles.directConnection')}</span>
      </span>
    )
  }
  if (traffic && (row.status === 'running' || row.status === 'disconnected')) {
    return <ProxyTraffic proxy={proxy} traffic={traffic} />
  }
  const location = proxyLocation(proxy)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex min-w-0 items-center gap-2.5" data-testid="proxy-cell">
          <span className="relative flex">
            <CountryFlag code={proxy.countryCode} />
            {proxy.checkStatus !== 'online' && (
              <span
                aria-hidden
                className={cn(
                  'absolute -right-1 -bottom-1 size-2 rounded-full ring-2 ring-card',
                  proxy.checkStatus === 'offline' ? 'bg-destructive' : 'bg-muted-foreground/60',
                )}
              />
            )}
          </span>
          <div className="min-w-0">
            {/* com apelido, o nome vem primeiro e o IP desce para a segunda linha */}
            <div className={cn('truncate text-[13px] tabular-nums', !proxy.name && 'font-mono')}>
              {proxyTitle(proxy)}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {[
                location,
                proxy.type.toUpperCase(),
                proxy.name ? (proxy.exitIp ?? proxyEndpoint(proxy)) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="space-y-1">
        {proxy.name && <div className="font-medium">{proxy.name}</div>}
        <div className="font-mono">
          {proxy.type.toUpperCase()} {proxyEndpoint(proxy)}
        </div>
        <ProxyStatusPill proxy={proxy} className="text-current" />
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Sistema emulado e, embaixo, o navegador do perfil com a versão instalada (ou o aviso de que não
 * está nesta máquina). O User-Agent completo fica no tooltip.
 */
function SystemCell({ row }: { row: ProfileRow }) {
  const { t } = useTranslation()
  const info = useBrowser(row.browser)
  const version = browserVersion(info)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="min-w-0">
          <OsBadge os={row.os} className="font-medium" />
          <p
            className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
            data-testid="profile-browser-cell"
          >
            <BrowserMark kind={row.browser} className="size-3" />
            <span className="truncate">
              {BROWSER_NAMES[row.browser]}
              {info && !info.available && !info.checking
                ? ` · ${t('browsers.notInstalled')}`
                : version
                  ? ` ${version}`
                  : ''}
            </span>
          </p>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm text-xs">
        <p className="font-medium">
          {BROWSER_NAMES[row.browser]}
          {version ? ` ${version}` : ''}
        </p>
        <p className="font-mono break-all">{row.userAgent}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function LastOpenedCell({ row }: { row: ProfileRow }) {
  const { t, i18n } = useTranslation()
  const now = useNow()
  if (row.lastOpenedAt === null) return <Muted>{t('common.never')}</Muted>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="truncate text-sm tabular-nums" lang={i18n.language}>
          {formatRelative(row.lastOpenedAt, Math.max(now, Date.now()))}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {formatDateTime(row.lastOpenedAt)} · {t('profiles.openedTimes', { count: row.openCount })}
      </TooltipContent>
    </Tooltip>
  )
}

function ActionCell({ row }: { row: ProfileRow }) {
  const { t } = useTranslation()
  const start = useProfilesStore((s) => s.start)
  const stop = useProfilesStore((s) => s.stop)
  const browser = useBrowser(row.browser)
  const available = browser?.available ?? false
  if (row.status === 'running' || row.status === 'disconnected' || row.status === 'starting') {
    return (
      <Button
        size="sm"
        variant="outline"
        className="w-[84px] border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => void stop([row.id])}
        data-testid="profile-stop"
      >
        <Square className="size-3 fill-current" />
        {t('profiles.stop')}
      </Button>
    )
  }
  if (row.status === 'stopping') {
    return (
      <Button size="sm" variant="outline" className="w-[84px]" disabled>
        <LoaderCircle className="animate-spin" />
        {t('profiles.stop')}
      </Button>
    )
  }
  return (
    <Button
      size="sm"
      className="w-[84px]"
      disabled={!available}
      title={
        available
          ? undefined
          : browser?.checking
            ? t('browsers.checking')
            : t('browser.unavailableNamed', { browser: BROWSER_NAMES[row.browser] })
      }
      onClick={() => void start([row.id])}
      data-testid="profile-open"
    >
      <Play className="size-3 fill-current" />
      {t('profiles.open')}
    </Button>
  )
}

const definitions: ColumnDef<ProfileRow>[] = [
  {
    id: 'select',
    enableSorting: false,
    header: ({ table }) => <HeaderCheckbox table={table} />,
    cell: ({ table, row }) => <RowCheckbox table={table} row={row} />,
  },
  {
    id: 'serial',
    accessorFn: (row) => row.serial,
    header: ({ column }) => <ColumnHeader column={column} labelKey="profiles.columns.serial" />,
    cell: ({ row }) => (
      <span className="font-mono text-[13px] tabular-nums text-muted-foreground" data-testid="profile-serial">
        {formatSerial(row.original.serial)}
      </span>
    ),
  },
  {
    id: 'name',
    accessorFn: (row) => row.name,
    sortingFn: (a, b) => naturalCompare(a.original.name, b.original.name),
    header: ({ column }) => <ColumnHeader column={column} labelKey="profiles.columns.name" />,
    cell: ({ row }) => <NameCell row={row.original} />,
  },
  {
    id: 'status',
    accessorFn: (row) => STATUS_RANK[row.status],
    header: ({ column }) => <ColumnHeader column={column} labelKey="profiles.columns.status" />,
    cell: ({ row }) => <StatusCell row={row.original} />,
  },
  {
    id: 'group',
    accessorFn: (row) => row.groupName ?? '',
    sortingFn: (a, b) => naturalCompare(a.original.groupName ?? '￿', b.original.groupName ?? '￿'),
    header: ({ column }) => <ColumnHeader column={column} labelKey="profiles.columns.group" />,
    cell: ({ row }) => <GroupCell row={row.original} />,
  },
  {
    id: 'tags',
    enableSorting: false,
    header: ({ column }) => <ColumnHeader column={column} labelKey="profiles.columns.tags" />,
    cell: ({ row }) => <TagsCell row={row.original} />,
  },
  {
    id: 'proxy',
    accessorFn: (row) =>
      row.proxy ? `${row.proxy.countryCode ?? 'ZZ'} ${row.proxy.exitIp ?? row.proxy.host}` : '￿',
    header: ({ column }) => <ColumnHeader column={column} labelKey="profiles.columns.proxy" />,
    cell: ({ row }) => <ProxyCell row={row.original} />,
  },
  {
    id: 'system',
    accessorFn: (row) => row.os,
    header: ({ column }) => <ColumnHeader column={column} labelKey="profiles.columns.system" />,
    cell: ({ row }) => <SystemCell row={row.original} />,
  },
  {
    id: 'lastOpened',
    accessorFn: (row) => row.lastOpenedAt ?? 0,
    sortDescFirst: true,
    header: ({ column }) => <ColumnHeader column={column} labelKey="profiles.columns.lastOpened" />,
    cell: ({ row }) => <LastOpenedCell row={row.original} />,
  },
  {
    id: 'action',
    enableSorting: false,
    header: ({ column }) => <ColumnHeader column={column} labelKey="profiles.columns.actions" />,
    cell: ({ row }) => <ActionCell row={row.original} />,
  },
  {
    id: 'menu',
    enableSorting: false,
    header: () => null,
    cell: ({ row }) => <RowActions profile={row.original} />,
  },
]

export const profileColumns: ColumnDef<ProfileRow>[] = definitions.map((column) => {
  const layout = PROFILE_COLUMN_LAYOUT.find((item) => item.id === column.id)!
  return {
    ...column,
    size: layout.base,
    minSize: layout.min,
    maxSize: 32000,
    enableResizing: RESIZABLE_PROFILE_COLUMNS.some((id) => id === column.id),
  }
})
