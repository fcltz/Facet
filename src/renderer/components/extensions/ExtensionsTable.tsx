import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { useState } from 'react'
import type { ExtensionRow } from '@renderer/stores/extensions.store'
import { EXTENSION_GRID, EXTENSION_ROW_HEIGHT, EXTENSION_TABLE_MIN_WIDTH, extensionColumns } from './columns'

/**
 * Biblioteca de extensões (poucas linhas: sem virtualização). As colunas são da tabela inteira:
 * cabeçalho e linhas são subgrids, então a largura de cada coluna considera todas as linhas.
 */
export function ExtensionsTable({ rows }: { rows: ExtensionRow[] }) {
  const [sorting, setSorting] = useState<SortingState>([])
  const table = useReactTable({
    data: rows,
    columns: extensionColumns,
    getRowId: (row) => row.id,
    state: { sorting },
    onSortingChange: setSorting,
    enableMultiSort: false,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })
  const headerGroup = table.getHeaderGroups()[0]

  return (
    <div className="relative h-full overflow-auto" data-testid="extensions-table">
      <div
        role="table"
        aria-rowcount={rows.length}
        className="grid"
        style={{ gridTemplateColumns: EXTENSION_GRID, minWidth: EXTENSION_TABLE_MIN_WIDTH }}
      >
        <div
          role="row"
          className="sticky top-0 z-10 col-span-full grid h-10 grid-cols-subgrid items-center border-b bg-card/95 text-xs font-medium text-muted-foreground backdrop-blur"
        >
          {headerGroup?.headers.map((header) => (
            <div key={header.id} role="columnheader" className="flex min-w-0 items-center px-3">
              {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
            </div>
          ))}
        </div>
        <div role="rowgroup" className="col-span-full grid grid-cols-subgrid">
          {table.getRowModel().rows.map((row) => (
            <div
              key={row.id}
              role="row"
              data-testid="extension-row"
              data-extension-id={row.id}
              className="col-span-full grid grid-cols-subgrid items-center border-b border-border/70 transition-colors hover:bg-accent/60"
              style={{ minHeight: EXTENSION_ROW_HEIGHT }}
            >
              {row.getVisibleCells().map((cell) => (
                <div key={cell.id} role="cell" className="flex min-w-0 items-center px-3 py-2">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
