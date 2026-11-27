import { Ban, Download, FolderInput, Globe, Play, Square, Trash2, X } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { useSettingsStore } from '@renderer/stores/settings.store'

/** Barra flutuante de ações em massa, visível quando há perfis selecionados. */
export function BulkActionsBar() {
  const { t } = useTranslation()
  const selection = useProfilesStore((s) => s.selection)
  // Cada perfil abre no navegador dele: basta um disponível (os outros falham com o motivo).
  const available = useSettingsStore((s) => s.browsers.some((browser) => browser.available))
  const start = useProfilesStore((s) => s.start)
  const stop = useProfilesStore((s) => s.stop)
  const assignProxy = useProfilesStore((s) => s.assignProxy)
  const trash = useProfilesStore((s) => s.trash)
  const clearSelection = useProfilesStore((s) => s.clearSelection)
  const openAssignProxy = useUiStore((s) => s.openAssignProxy)
  const openMoveToGroup = useUiStore((s) => s.openMoveToGroup)

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
        data-testid="bulk-bar"
        className="pointer-events-auto flex max-w-full items-center gap-0.5 overflow-x-auto rounded-xl border bg-popover p-1.5 shadow-float animate-in fade-in slide-in-from-bottom-2"
      >
        <span className="px-3 text-sm font-semibold whitespace-nowrap tabular-nums" data-testid="bulk-count">
          {t('bulk.selected', { count: ids.length })}
        </span>
        <Separator orientation="vertical" className="mx-1 h-6!" />
        <Button
          variant="ghost"
          size="sm"
          disabled={!available}
          onClick={() => void start(ids)}
          data-testid="bulk-open"
        >
          <Play className="text-success" />
          {t('bulk.open')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void stop(ids)} data-testid="bulk-stop">
          <Square />
          {t('bulk.stop')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openAssignProxy(ids)}>
          <Globe />
          {t('bulk.assignProxy')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void assignProxy(ids, null)}>
          <Ban />
          {t('bulk.removeProxy')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openMoveToGroup(ids)}>
          <FolderInput />
          {t('bulk.moveToGroup')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => useUiStore.getState().openExportProfiles(ids)}
          data-testid="bulk-export"
        >
          <Download />
          {t('bulk.export')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => void trash(ids)}
          data-testid="bulk-trash"
        >
          <Trash2 />
          {t('bulk.trash')}
        </Button>
        <Separator orientation="vertical" className="mx-1 h-6!" />
        <Button variant="ghost" size="icon-sm" onClick={clearSelection} aria-label={t('bulk.clearSelection')}>
          <X />
        </Button>
      </div>
    </div>
  )
}
