import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_TABLE, profileTableSchema } from '@shared/schemas/profile-table'
import { PROFILE_COLUMN_LAYOUT, profileTableLayout } from '../../src/renderer/lib/profile-table-layout'

describe('layout configurável dos perfis', () => {
  it('distribui espaço em telas largas e respeita mínimos na janela estreita', () => {
    const wide = profileTableLayout(1700, DEFAULT_PROFILE_TABLE)
    expect(wide.total).toBeCloseTo(1700)
    expect(wide.widths.name).toBeGreaterThan(wide.widths.status!)
    const narrow = profileTableLayout(650, DEFAULT_PROFILE_TABLE)
    expect(narrow.total).toBeGreaterThan(650)
    for (const column of PROFILE_COLUMN_LAYOUT)
      expect(narrow.widths[column.id]).toBeGreaterThanOrEqual(column.min)
  })
  it('ocultar colunas libera espaço; largura manual fica exata ao mudar a janela', () => {
    const preferences = profileTableSchema.parse({
      hidden: ['serial', 'group', 'tags', 'proxy', 'system', 'lastOpened'],
      widths: { name: 420 },
    })
    for (const width of [700, 1200, 1900]) {
      const result = profileTableLayout(width, preferences)
      expect(result.widths.name).toBe(420)
      expect(Object.keys(result.widths)).toEqual(['select', 'name', 'status', 'action', 'menu'])
    }
  })
  it('recusa colunas essenciais ocultas e larguras inválidas ou desconhecidas', () => {
    expect(profileTableSchema.safeParse({ hidden: ['name'], widths: {} }).success).toBe(false)
    for (const width of [-1, 0, 1.5, NaN, Infinity, 32001])
      expect(profileTableSchema.safeParse({ hidden: [], widths: { name: width } }).success).toBe(false)
    expect(profileTableSchema.safeParse({ hidden: [], widths: { unknown: 100 } }).success).toBe(false)
  })
})
