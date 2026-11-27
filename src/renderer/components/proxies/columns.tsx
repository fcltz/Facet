import type { Column, ColumnDef, Row, Table } from '@tanstack/react-table'
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Copy,
  Ellipsis,
  LoaderCircle,
  Pencil,
  RefreshCcwDot,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ProxyCheckStatus } from '@shared/schemas/proxy'
import { proxyEndpoint, proxyLabel } from '@shared/schemas/proxy'
import { CountryFlag } from '@renderer/components/common/CountryFlag'
import { exposesRealIp, proxyLocation, ProxyStatusPill } from '@renderer/components/common/pickers'
import { CheckSquare } from '@renderer/components/profiles/columns'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { formatDateTime, formatRelative, naturalCompare, useNow } from '@renderer/lib/format'
import { toastError } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { useProxiesStore, type ProxyRow } from '@renderer/stores/proxies.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { RotateIpButton } from './RotateIpButton'

export const PROXY_ROW_HEIGHT = 56
export const PROXY_GRID = '44px minmax(210px,1.4fr) 88px 132px minmax(200px,1.3fr) 88px 128px 136px'
export const PROXY_TABLE_MIN_WIDTH = 1080

const STATUS_RANK: Record<ProxyCheckStatus, number> = { online: 0, unknown: 1, offline: 2 }

/** Alterna a seleção de uma linha; com Shift seleciona o intervalo desde a última linha clicada. */
export function toggleProxySelection(table: Table<ProxyRow>, row: Row<ProxyRow>, withRange: boolean): void {
  const store = useProxiesStore.getState()
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

type HeaderKey =
  | 'proxies.columns.proxy'
  | 'proxies.columns.type'
  | 'proxies.columns.status'
  | 'proxies.columns.exit'
  | 'proxies.columns.profiles'
  | 'proxies.columns.lastCheck'
  | 'proxies.columns.actions'

function ColumnHeader({ column, labelKey }: { column: Column<ProxyRow>; labelKey: HeaderKey }) {
  const { t } = useTranslation()
  const label = t(labelKey)
  if (!column.getCanSort()) return <span>{label}</span>
  const sorted = column.getIsSorted()
  const Icon = sorted === 'asc' ? ArrowUp : sorted === 'desc' ? ArrowDown : ChevronsUpDown
  return (
    <button
      type="button"
      onClick={column.getToggleSortingHandler()}
      className={cn(
        '-ml-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-accent hover:text-foreground',
        sorted && 'text-foreground',
      )}
    >
      {label}
      <Icon className={cn('size-3.5', !sorted && 'opacity-50')} />
    </button>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>
}

function ProxyCell({ row }: { row: ProxyRow }) {
  const { t } = useTranslation()
  const openProxyEditor = useUiStore((s) => s.openProxyEditor)
  // Com apelido, o nome vem primeiro e o endereço desce para a linha de detalhes.
  const details = [
    row.name ? proxyEndpoint(row) : null,
    row.username ? t('proxies.userLabel', { user: row.username }) : t('proxies.noAuth'),
  ].filter(Boolean)
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={() => openProxyEditor(row.id)}
          className={cn(
            'block min-w-0 truncate text-left text-[13px] font-medium text-foreground underline-offset-2 hover:text-primary hover:underline',
            !row.name && 'font-mono',
          )}
          title={proxyLabel(row)}
          data-testid="proxy-endpoint"
        >
          {proxyLabel(row)}
        </button>
        {row.rotating && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-1.5 text-[11px] leading-5 font-medium text-primary">
            <RefreshCcwDot className="size-3" />
            {t('proxies.rotatingBadge')}
          </span>
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground" title={row.notes || undefined}>
        {details.join(' · ')}
      </p>
    </div>
  )
}

function TypeCell({ row }: { row: ProxyRow }) {
  return (
    <span className="rounded-md border px-1.5 text-xs leading-5 font-medium tracking-wide uppercase">
      {row.type}
    </span>
  )
}

function StatusCell({ row }: { row: ProxyRow }) {
  const { t } = useTranslation()
  const checking = useProxiesStore((s) => Boolean(s.checking[row.id]))
  if (checking) {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="proxy-status"
      >
        <LoaderCircle className="size-3.5 animate-spin" />
        {t('proxies.checking')}
      </span>
    )
  }
  const pill = <ProxyStatusPill proxy={row} />
  const realIp = exposesRealIp(row)
  if (row.checkStatus !== 'offline' || !row.lastError) {
    return (
      <span data-testid="proxy-status" data-status={row.checkStatus}>
        {pill}
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          data-testid="proxy-status"
          data-status={row.checkStatus}
          data-reason={realIp ? 'real-ip' : undefined}
        >
          {pill}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {realIp ? t('proxies.realIpHint', { ip: row.exitIp ?? '?' }) : row.lastError}
      </TooltipContent>
    </Tooltip>
  )
}

function ExitCell({ row }: { row: ProxyRow }) {
  const { t } = useTranslation()
  if (!row.exitIp && !row.countryCode) return <Muted>{t('proxies.notChecked')}</Muted>
  const location = proxyLocation(row)
  const realIp = exposesRealIp(row)
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <CountryFlag code={row.countryCode} />
      <div className="min-w-0">
        <div
          className={cn(
            'truncate font-mono text-[13px] tabular-nums',
            realIp && 'font-semibold text-destructive',
          )}
          data-testid="proxy-exit-ip"
          data-real-ip={realIp ? 'true' : undefined}
        >
          {row.exitIp ?? t('common.none')}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {[location, row.timezone].filter(Boolean).join(' · ')}
        </div>
      </div>
    </div>
  )
}

function UsageCell({ row }: { row: ProxyRow }) {
  const { t } = useTranslation()
  if (row.usage === 0) return <Muted>{t('common.none')}</Muted>
  return <span className="text-sm tabular-nums">{t('proxies.profilesCount', { count: row.usage })}</span>
}

function LastCheckCell({ row }: { row: ProxyRow }) {
  const { t } = useTranslation()
  const now = useNow()
  if (row.checkedAt === null) return <Muted>{t('common.never')}</Muted>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-sm tabular-nums">
          {formatRelative(row.checkedAt, Math.max(now, Date.now()))}
        </span>
      </TooltipTrigger>
      <TooltipContent>{formatDateTime(row.checkedAt)}</TooltipContent>
    </Tooltip>
  )
}

function ActionsCell({ row }: { row: ProxyRow }) {
  const { t } = useTranslation()
  const checking = useProxiesStore((s) => Boolean(s.checking[row.id]))
  const check = useProxiesStore((s) => s.check)
  const remove = useProxiesStore((s) => s.remove)
  const openProxyEditor = useUiStore((s) => s.openProxyEditor)

  const copyEndpoint = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(proxyEndpoint(row))
      toast.success(t('proxyToasts.copied'), { description: proxyEndpoint(row) })
    } catch (error) {
      toastError(error)
    }
  }

  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={checking}
            onClick={() => void check([row.id])}
            aria-label={t('proxies.check')}
            data-testid="proxy-check"
          >
            {checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t('proxies.check')}</TooltipContent>
      </Tooltip>
      <RotateIpButton proxy={row} iconOnly variant="ghost" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('proxies.columns.menu')}
            data-testid="proxy-menu"
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => openProxyEditor(row.id)} data-testid="proxy-menu-edit">
            <Pencil />
            {t('common.edit')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void check([row.id])}>
            <RefreshCw />
            {t('proxies.check')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copyEndpoint()}>
            <Copy />
            {t('proxies.copyEndpoint')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => void remove([row.id])}
            data-testid="proxy-menu-delete"
          >
            <Trash2 />
            {t('common.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function HeaderCheckbox({ table }: { table: Table<ProxyRow> }) {
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

function RowCheckbox({ table, row }: { table: Table<ProxyRow>; row: Row<ProxyRow> }) {
  const { t } = useTranslation()
  return (
    <CheckSquare
      state={row.getIsSelected()}
      label={t('proxies.selectRow', { name: proxyLabel(row.original) })}
      onClick={(event) => toggleProxySelection(table, row, event.shiftKey)}
    />
  )
}

export const proxyColumns: ColumnDef<ProxyRow>[] = [
  {
    id: 'select',
    enableSorting: false,
    header: ({ table }) => <HeaderCheckbox table={table} />,
    cell: ({ table, row }) => <RowCheckbox table={table} row={row} />,
  },
  {
    id: 'proxy',
    accessorFn: (row) => proxyLabel(row),
    sortingFn: (a, b) => naturalCompare(proxyLabel(a.original), proxyLabel(b.original)),
    header: ({ column }) => <ColumnHeader column={column} labelKey="proxies.columns.proxy" />,
    cell: ({ row }) => <ProxyCell row={row.original} />,
  },
  {
    id: 'type',
    accessorFn: (row) => row.type,
    header: ({ column }) => <ColumnHeader column={column} labelKey="proxies.columns.type" />,
    cell: ({ row }) => <TypeCell row={row.original} />,
  },
  {
    id: 'status',
    accessorFn: (row) => STATUS_RANK[row.checkStatus] * 100_000 + (row.latencyMs ?? 99_999),
    header: ({ column }) => <ColumnHeader column={column} labelKey="proxies.columns.status" />,
    cell: ({ row }) => <StatusCell row={row.original} />,
  },
  {
    id: 'exit',
    accessorFn: (row) => `${row.countryCode ?? 'ZZ'} ${row.city ?? ''} ${row.exitIp ?? ''}`,
    header: ({ column }) => <ColumnHeader column={column} labelKey="proxies.columns.exit" />,
    cell: ({ row }) => <ExitCell row={row.original} />,
  },
  {
    id: 'profiles',
    accessorFn: (row) => row.usage,
    sortDescFirst: true,
    header: ({ column }) => <ColumnHeader column={column} labelKey="proxies.columns.profiles" />,
    cell: ({ row }) => <UsageCell row={row.original} />,
  },
  {
    id: 'lastCheck',
    accessorFn: (row) => row.checkedAt ?? 0,
    sortDescFirst: true,
    header: ({ column }) => <ColumnHeader column={column} labelKey="proxies.columns.lastCheck" />,
    cell: ({ row }) => <LastCheckCell row={row.original} />,
  },
  {
    id: 'actions',
    enableSorting: false,
    header: ({ column }) => <ColumnHeader column={column} labelKey="proxies.columns.actions" />,
    cell: ({ row }) => <ActionsCell row={row.original} />,
  },
]
