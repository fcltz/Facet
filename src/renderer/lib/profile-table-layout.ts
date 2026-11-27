import type { ProfileTablePreferences } from '@shared/schemas/profile-table'

export const PROFILE_COLUMN_LAYOUT = [
  { id: 'select', min: 44, base: 44, weight: 0 },
  { id: 'serial', min: 72, base: 72, weight: 0 },
  { id: 'name', min: 150, base: 210, weight: 2 },
  { id: 'status', min: 104, base: 118, weight: 0 },
  { id: 'group', min: 128, base: 144, weight: 0.8 },
  { id: 'tags', min: 160, base: 192, weight: 1 },
  { id: 'proxy', min: 120, base: 190, weight: 1.4 },
  { id: 'system', min: 100, base: 150, weight: 1 },
  { id: 'lastOpened', min: 104, base: 124, weight: 0.5 },
  { id: 'action', min: 108, base: 108, weight: 0 },
  { id: 'menu', min: 48, base: 48, weight: 0 },
] as const

/** Só colunas automáticas dividem ou cedem espaço; larguras manuais são preservadas. */
export function profileTableLayout(available: number, preferences: ProfileTablePreferences) {
  const hidden = new Set<string>(preferences.hidden)
  const columns = PROFILE_COLUMN_LAYOUT.filter((column) => !hidden.has(column.id))
  const custom = preferences.widths as Record<string, number | undefined>
  const widths: Record<string, number> = {}
  for (const column of columns) widths[column.id] = Math.max(column.min, custom[column.id] ?? column.base)
  const initial = Object.values(widths).reduce((sum, width) => sum + width, 0)
  const automatic = columns.filter((column) => custom[column.id] === undefined)
  if (available > initial) {
    const weight = automatic.reduce((sum, column) => sum + column.weight, 0)
    if (weight)
      for (const column of automatic) widths[column.id]! += ((available - initial) * column.weight) / weight
  } else {
    const capacity = automatic.reduce((sum, column) => sum + column.base - column.min, 0)
    const shrink = Math.min(initial - Math.max(0, available), capacity)
    if (capacity)
      for (const column of automatic) widths[column.id]! -= (shrink * (column.base - column.min)) / capacity
  }
  return {
    widths,
    template: columns.map((column) => `${widths[column.id]}px`).join(' '),
    total: Object.values(widths).reduce((sum, width) => sum + width, 0),
  }
}
