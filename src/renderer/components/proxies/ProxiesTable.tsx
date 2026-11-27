import {
  flexRender,
  functionalUpdate,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { cn } from '@renderer/lib/utils'
import { useProxiesStore, type ProxyRow } from '@renderer/stores/proxies.store'
import { useUiStore } from '@renderer/stores/ui.store'
import {
  PROXY_GRID,
  PROXY_ROW_HEIGHT,
  PROXY_TABLE_MIN_WIDTH,
  proxyColumns,
  toggleProxySelection,
} from './columns'

const INTERACTIVE = 'button, a, input, textarea, select, [role="checkbox"], [role="menuitem"]'

/** Tabela de proxies com rolagem virtualizada (milhares de linhas sem travar). */
export function ProxiesTable({ rows }: { rows: ProxyRow[] }) {
  const sorting = useProxiesStore((s) => s.sorting)
  const selection = useProxiesStore((s) => s.selection)
  const setSorting = useProxiesStore((s) => s.setSorting)
  const setSelection = useProxiesStore((s) => s.setSelection)
  const setVisibleIds = useProxiesStore((s) => s.setVisibleIds)
  const openProxyEditor = useUiStore((s) => s.openProxyEditor)

  const table = useReactTable({
    data: rows,
    columns: proxyColumns,
    getRowId: (row) => row.id,
    state: { sorting, rowSelection: selection },
    onSortingChange: (updater) => setSorting(functionalUpdate(updater, useProxiesStore.getState().sorting)),
    onRowSelectionChange: (updater) =>
      setSelection(functionalUpdate(updater, useProxiesStore.getState().selection)),
    enableRowSelection: true,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  const tableRows = table.getRowModel().rows

  useEffect(() => {
    setVisibleIds(tableRows.map((row) => row.id))
  }, [tableRows, setVisibleIds])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => PROXY_ROW_HEIGHT,
    overscan: 12,
  })

  const headerGroup = table.getHeaderGroups()[0]

  return (
    <div ref={scrollRef} className="relative h-full overflow-auto" data-testid="proxies-table">
      <div role="table" aria-rowcount={tableRows.length} style={{ minWidth: PROXY_TABLE_MIN_WIDTH }}>
        <div
          role="row"
          className="sticky top-0 z-10 grid h-10 items-center border-b bg-card/95 text-xs font-medium text-muted-foreground backdrop-blur"
          style={{ gridTemplateColumns: PROXY_GRID }}
        >
          {headerGroup?.headers.map((header) => (
            <div key={header.id} role="columnheader" className="flex min-w-0 items-center px-3">
              {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
            </div>
          ))}
        </div>

        <div role="rowgroup" className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = tableRows[item.index]
            if (!row) return null
            const selected = row.getIsSelected()
            return (
              <div
                key={row.id}
                role="row"
                aria-selected={selected}
                data-testid="proxy-row"
                data-proxy-id={row.id}
                className={cn(
                  'absolute inset-x-0 grid items-center border-b border-border/70 transition-colors',
                  selected ? 'bg-primary/[0.06] hover:bg-primary/[0.09]' : 'hover:bg-accent/60',
                )}
                style={{
                  gridTemplateColumns: PROXY_GRID,
                  height: PROXY_ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                }}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest(INTERACTIVE)) return
                  if (event.ctrlKey || event.metaKey || event.shiftKey)
                    toggleProxySelection(table, row, event.shiftKey)
                }}
                onDoubleClick={(event) => {
                  if ((event.target as HTMLElement).closest(INTERACTIVE)) return
                  openProxyEditor(row.id)
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <div key={cell.id} role="cell" className="flex min-w-0 items-center px-3">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
