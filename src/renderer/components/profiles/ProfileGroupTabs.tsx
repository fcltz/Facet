import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GroupDot } from '@renderer/components/common/GroupBadge'
import { cn } from '@renderer/lib/utils'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { useProfilesStore, type ProfileRow } from '@renderer/stores/profiles.store'

export function ProfileGroupTabs({ rows }: { rows: ProfileRow[] }) {
  const { t } = useTranslation()
  const groups = useCatalogStore((s) => s.groups)
  const loaded = useProfilesStore((s) => s.loaded)
  const groupIds = useProfilesStore((s) => s.filters.groupIds)
  const setFilters = useProfilesStore((s) => s.setFilters)
  const chosen = useRef<string | null>(null)
  const counts = useMemo(() => {
    const result = new Map<string, number>()
    for (const row of rows) if (row.groupId) result.set(row.groupId, (result.get(row.groupId) ?? 0) + 1)
    return result
  }, [rows])
  const used = groups.filter((group) => counts.has(group.id))
  useEffect(() => {
    // Só retorna automaticamente quando a aba que o usuário escolheu deixou de existir.
    if (
      loaded &&
      chosen.current &&
      groupIds.length === 1 &&
      groupIds[0] === chosen.current &&
      !used.some((group) => group.id === chosen.current)
    ) {
      chosen.current = null
      setFilters({ groupIds: [] })
    }
  }, [loaded, groupIds, used, setFilters])
  const pick = (id: string | null) => {
    chosen.current = id
    setFilters({ groupIds: id ? [id] : [] })
  }
  const classes = (active: boolean) =>
    cn(
      'flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
      active
        ? 'border-primary/40 bg-primary/10 font-medium text-primary'
        : 'border-transparent text-muted-foreground hover:bg-accent',
    )
  return (
    <div
      className="flex min-w-0 gap-1 overflow-x-auto pb-1"
      role="group"
      aria-label={t('profileView.groups')}
      data-testid="profile-group-tabs"
    >
      <button
        type="button"
        className={classes(groupIds.length === 0)}
        aria-pressed={groupIds.length === 0}
        onClick={() => pick(null)}
        data-testid="group-tab-all"
      >
        {t('profileView.all')}
        <span className="text-xs tabular-nums">{rows.length}</span>
      </button>
      {used.map((group) => (
        <button
          key={group.id}
          type="button"
          title={group.name}
          className={classes(groupIds.length === 1 && groupIds[0] === group.id)}
          aria-pressed={groupIds.length === 1 && groupIds[0] === group.id}
          onClick={() => pick(group.id)}
          data-testid="group-tab"
          data-group-id={group.id}
        >
          <GroupDot color={group.color} />
          <span className="max-w-48 truncate">{group.name}</span>
          <span className="text-xs tabular-nums">{counts.get(group.id)}</span>
        </button>
      ))}
    </div>
  )
}
