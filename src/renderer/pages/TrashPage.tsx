import { RotateCcw, Trash2 } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { GroupBadge } from '@renderer/components/common/GroupBadge'
import { OsBadge } from '@renderer/components/common/OsBadge'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { formatDateTime, formatRelative, useNow } from '@renderer/lib/format'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { useProfileRows, useProfilesStore, type ProfileRow } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'

function TrashRow({ row, now }: { row: ProfileRow; now: number }) {
  const { t } = useTranslation()
  const restore = useProfilesStore((s) => s.restore)
  const deletePermanently = useProfilesStore((s) => s.deletePermanently)
  const requestConfirm = useUiStore((s) => s.requestConfirm)
  const group = useCatalogStore((s) => (row.groupId ? s.groupsById[row.groupId] : undefined))

  const confirmDelete = async (): Promise<void> => {
    const confirmed = await requestConfirm({
      title: t('trash.confirmDeleteTitle', { name: row.name }),
      description: t('trash.confirmDeleteDescription'),
      confirmLabel: t('trash.deleteForever'),
      destructive: true,
    })
    if (confirmed) await deletePermanently([row.id])
  }

  return (
    <li className="flex items-center gap-4 px-5 py-3" data-testid="trash-row">
      <span
        aria-hidden
        className="h-8 w-1 shrink-0 rounded-full"
        style={{ backgroundColor: row.color ?? 'var(--border)' }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.name}</p>
        <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
          <OsBadge os={row.os} className="text-xs" />
          {group && <GroupBadge group={group} className="text-xs" />}
        </div>
      </div>
      {row.deletedAt !== null && (
        <span className="text-sm text-muted-foreground tabular-nums" title={formatDateTime(row.deletedAt)}>
          {t('trash.deletedAt', { when: formatRelative(row.deletedAt, Math.max(now, Date.now())) })}
        </span>
      )}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void restore([row.id])}
          data-testid="trash-restore"
        >
          <RotateCcw />
          {t('trash.restore')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => void confirmDelete()}
        >
          <Trash2 />
          {t('trash.deleteForever')}
        </Button>
      </div>
    </li>
  )
}

export function TrashPage() {
  const { t } = useTranslation()
  const now = useNow()
  const rows = useProfileRows('trash')
  const emptyTrash = useProfilesStore((s) => s.emptyTrash)
  const requestConfirm = useUiStore((s) => s.requestConfirm)
  const sorted = useMemo(() => [...rows].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)), [rows])

  const confirmEmpty = async (): Promise<void> => {
    const confirmed = await requestConfirm({
      title: t('trash.confirmEmptyTitle'),
      description: t('trash.confirmEmptyDescription', { count: rows.length }),
      confirmLabel: t('trash.emptyTrash'),
      destructive: true,
    })
    if (confirmed) await emptyTrash()
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={t('trash.title')}
        description={t('trash.subtitle')}
        actions={
          rows.length > 0 && (
            <Button
              variant="outline"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void confirmEmpty()}
              data-testid="empty-trash"
            >
              <Trash2 />
              {t('trash.emptyTrash')}
            </Button>
          )
        }
      />
      <div className="min-h-0 flex-1 px-6 pb-6">
        <div className="h-full overflow-hidden rounded-xl border bg-card shadow-soft">
          {sorted.length === 0 ? (
            <EmptyState
              variant="trash"
              title={t('trash.emptyTitle')}
              description={t('trash.emptyDescription')}
            />
          ) : (
            <ul className="h-full divide-y overflow-y-auto">
              {sorted.map((row) => (
                <TrashRow key={row.id} row={row} now={now} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
