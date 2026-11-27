import {
  flexRender,
  functionalUpdate,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RESIZABLE_PROFILE_COLUMNS, type ResizableProfileColumn } from '@shared/schemas/profile-table'
import { profileTableLayout } from '@renderer/lib/profile-table-layout'
import { useProfileTableStore } from '@renderer/stores/profile-table.store'
import { cn } from '@renderer/lib/utils'
import { useProfilesStore, type ProfileRow } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { profileColumns, ROW_HEIGHT, toggleRowSelection } from './columns'

const INTERACTIVE =
  'button, a, input, textarea, select, [role="checkbox"], [role="menuitem"], [role="option"], [role="combobox"]'

/**
 * Tabela de perfis com rolagem virtualizada: só as linhas visíveis existem no
 * DOM, então milhares de perfis rolam sem travar. Cabeçalho fixo no topo.
 */
export function ProfilesTable({ rows }: { rows: ProfileRow[] }) {
  const { t } = useTranslation()
  const preferences = useProfileTableStore((s) => s.preferences)
  const setWidth = useProfileTableStore((s) => s.setWidth)
  const [available, setAvailable] = useState(0)
  const layout = useMemo(() => profileTableLayout(available, preferences), [available, preferences])
  const sorting = useProfilesStore((s) => s.sorting)
  const selection = useProfilesStore((s) => s.selection)
  const setSorting = useProfilesStore((s) => s.setSorting)
  const setSelection = useProfilesStore((s) => s.setSelection)
  const setVisibleIds = useProfilesStore((s) => s.setVisibleIds)
  const openEditDrawer = useUiStore((s) => s.openEditDrawer)

  const table = useReactTable({
    data: rows,
    columns: profileColumns,
    getRowId: (row) => row.id,
    state: {
      sorting,
      rowSelection: selection,
      columnVisibility: Object.fromEntries(preferences.hidden.map((id) => [id, false])),
      columnSizing: layout.widths,
    },
    columnResizeMode: 'onEnd',
    onColumnSizingChange: (updater) => {
      const next = functionalUpdate(updater, layout.widths)
      for (const id of RESIZABLE_PROFILE_COLUMNS) {
        if (next[id] !== undefined && Math.abs(next[id]! - (layout.widths[id] ?? 0)) > 0.5)
          setWidth(id, next[id]!)
      }
    },
    onSortingChange: (updater) => setSorting(functionalUpdate(updater, useProfilesStore.getState().sorting)),
    onRowSelectionChange: (updater) =>
      setSelection(functionalUpdate(updater, useProfilesStore.getState().selection)),
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
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const measure = () => setAvailable(element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })

  const headerGroup = table.getHeaderGroups()[0]

  return (
    <div ref={scrollRef} className="relative h-full overflow-auto" data-testid="profiles-table">
      <div
        role="table"
        aria-rowcount={tableRows.length}
        aria-colcount={table.getVisibleLeafColumns().length}
        style={{ width: Math.max(available, layout.total) }}
      >
        <div
          role="row"
          className="sticky top-0 z-10 grid h-10 items-center border-b bg-card/95 text-xs font-medium text-muted-foreground backdrop-blur select-none"
          style={{ gridTemplateColumns: layout.template }}
        >
          {headerGroup?.headers.map((header) => (
            <div
              key={header.id}
              role="columnheader"
              data-column={header.column.id}
              className="relative flex h-full min-w-0 items-center px-3"
            >
              {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
              {header.column.getCanResize() && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  tabIndex={0}
                  aria-label={t('profileView.resize', {
                    column: t(`profiles.columns.${header.column.id as ResizableProfileColumn}`),
                  })}
                  aria-valuenow={Math.round(header.getSize())}
                  aria-valuemin={header.column.columnDef.minSize}
                  data-testid={`resize-${header.column.id}`}
                  title={t('profileView.resizeHint')}
                  className="absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-2 after:left-1/2 after:w-px after:bg-border hover:after:bg-primary focus:after:bg-primary"
                  style={
                    header.column.getIsResizing()
                      ? {
                          transform: `translateX(${table.getState().columnSizingInfo.deltaOffset ?? 0}px)`,
                          background: 'var(--primary)',
                        }
                      : undefined
                  }
                  onMouseDown={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    header.getResizeHandler()(event)
                  }}
                  onTouchStart={(event) => {
                    event.stopPropagation()
                    header.getResizeHandler()(event)
                  }}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => {
                    event.stopPropagation()
                    setWidth(header.column.id as ResizableProfileColumn, null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                      event.preventDefault()
                      event.stopPropagation()
                      setWidth(
                        header.column.id as ResizableProfileColumn,
                        header.getSize() + (event.key === 'ArrowRight' ? 16 : -16),
                      )
                    } else if (event.key === 'Enter' || event.key === 'Home') {
                      event.preventDefault()
                      setWidth(header.column.id as ResizableProfileColumn, null)
                    }
                  }}
                />
              )}
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
                data-testid="profile-row"
                data-profile-id={row.id}
                data-status={row.original.status}
                className={cn(
                  'absolute inset-x-0 grid items-center border-b border-border/70 transition-colors',
                  selected ? 'bg-primary/[0.06] hover:bg-primary/[0.09]' : 'hover:bg-accent/60',
                )}
                style={{
                  gridTemplateColumns: layout.template,
                  height: ROW_HEIGHT,
                  transform: `translateY(${item.start}px)`,
                }}
                onClick={(event) => {
                  if ((event.target as HTMLElement).closest(INTERACTIVE)) return
                  if (event.ctrlKey || event.metaKey || event.shiftKey)
                    toggleRowSelection(table, row, event.shiftKey)
                }}
                onDoubleClick={(event) => {
                  if ((event.target as HTMLElement).closest(INTERACTIVE)) return
                  openEditDrawer(row.id)
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <div
                    key={cell.id}
                    role="cell"
                    data-column={cell.column.id}
                    className="flex min-w-0 items-center overflow-hidden px-3 [&>*]:max-w-full"
                  >
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
