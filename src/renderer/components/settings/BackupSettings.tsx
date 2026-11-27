import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LIMITS } from '@shared/constants'
import { BACKUP_INTERVALS, type BackupInterval, type RestoreCandidate } from '@shared/schemas/backup'
import { Field, Notice } from '@renderer/components/common/Field'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { JobProgress } from '@renderer/components/transfer/JobProgress'
import { formatDateTime } from '@renderer/lib/format'
import { invoke, toastError } from '@renderer/lib/ipc'
import { runJob, useJobsStore } from '@renderer/stores/jobs.store'
import { useSettingsStore } from '@renderer/stores/settings.store'

export function BackupSettings() {
  const { t } = useTranslation()
  const config = useSettingsStore((s) => s.settings.backup)
  const state = useSettingsStore((s) => s.settings.backupState)
  const update = useSettingsStore((s) => s.update)
  const busy = useJobsStore((s) => s.current !== null)
  const [picking, setPicking] = useState(false)
  const [candidate, setCandidate] = useState<RestoreCandidate | null>(null)
  const [restoring, setRestoring] = useState(false)
  const pickFolder = async (): Promise<void> => {
    setPicking(true)
    try {
      const settings = await invoke('backup.pickFolder')
      if (settings) useSettingsStore.getState().apply(settings)
    } catch (error) {
      toastError(error)
    } finally {
      setPicking(false)
    }
  }
  const backup = async (): Promise<void> => {
    try {
      const result = await runJob('backup', (jobId) =>
        invoke('backup.run', { jobId, includeProfiles: config.includeProfiles }),
      )
      toast.success(t('backupSettings.created'), { description: result.fileName })
    } catch (error) {
      toastError(error)
    }
  }
  const pickRestore = async (): Promise<void> => {
    setPicking(true)
    try {
      setCandidate(await invoke('backup.pickRestore'))
    } catch (error) {
      toastError(error)
    } finally {
      setPicking(false)
    }
  }
  const restore = async (): Promise<void> => {
    if (!candidate) return
    setRestoring(true)
    try {
      await runJob('restore', () => invoke('backup.restore', { token: candidate.token }))
      toast.success(t('backupSettings.restarting'))
    } catch (error) {
      toastError(error)
      setRestoring(false)
      setCandidate(null)
    }
  }
  const disabled = busy || picking || restoring
  return (
    <>
      <Notice>{t('backupSettings.scope')}</Notice>
      <div className="grid grid-cols-2 gap-4">
        <Field label={t('backupSettings.schedule')} htmlFor="backup-interval">
          <Select
            value={config.interval}
            disabled={disabled}
            onValueChange={(value) =>
              void update({ backup: { ...config, interval: value as BackupInterval } })
            }
          >
            <SelectTrigger id="backup-interval" data-testid="backup-interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BACKUP_INTERVALS.map((value) => (
                <SelectItem key={value} value={value}>
                  {t(`backupSettings.intervals.${value}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t('backupSettings.keep')} htmlFor="backup-keep">
          <Input
            id="backup-keep"
            key={config.keep}
            type="number"
            min={1}
            max={LIMITS.backupKeepMax}
            defaultValue={config.keep}
            disabled={disabled}
            onBlur={(event) => {
              const keep = Number(event.target.value)
              if (Number.isInteger(keep) && keep >= 1 && keep <= LIMITS.backupKeepMax)
                void update({ backup: { ...config, keep } })
              else {
                event.target.value = String(config.keep)
                toast.error(t('validation.outOfRange'))
              }
            }}
          />
        </Field>
      </div>
      <Field label={t('backupSettings.folder')} htmlFor="backup-folder">
        <Input id="backup-folder" readOnly value={config.folder || t('backupSettings.defaultFolder')} />
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => void pickFolder()}
            data-testid="backup-folder-choose"
          >
            {t('storageSettings.choose')}
          </Button>
          <Button
            variant="ghost"
            disabled={disabled}
            onClick={() => void invoke('backup.openFolder').catch(toastError)}
          >
            {t('backupSettings.openFolder')}
          </Button>
        </div>
      </Field>
      <label className="flex items-start gap-3 text-sm">
        <Switch
          checked={config.includeProfiles}
          disabled={disabled}
          data-testid="backup-include-profiles"
          onCheckedChange={(includeProfiles) => void update({ backup: { ...config, includeProfiles } })}
        />
        <span>
          {t('backupSettings.includeProfiles')}
          <span className="mt-1 block text-xs text-muted-foreground">{t('backupSettings.skipHint')}</span>
        </span>
      </label>
      <div className="flex gap-2">
        <Button disabled={disabled} onClick={() => void backup()} data-testid="backup-run">
          {t('backupSettings.run')}
        </Button>
        <Button
          variant="outline"
          disabled={disabled}
          onClick={() => void pickRestore()}
          data-testid="backup-restore-pick"
        >
          {t('backupSettings.restore')}
        </Button>
      </div>
      {!restoring && <JobProgress />}
      <div className="text-sm" data-testid="backup-state">
        <p>
          {state.lastAt
            ? t('backupSettings.last', { date: formatDateTime(state.lastAt) })
            : t('backupSettings.never')}
        </p>
        {state.lastFile && <p className="break-all text-xs text-muted-foreground">{state.lastFile}</p>}
        {state.lastError && <p className="text-destructive">{state.lastError}</p>}
        {state.skipped.length > 0 && (
          <p className="text-warning">{t('backupSettings.skipped', { names: state.skipped.join(', ') })}</p>
        )}
      </div>
      <Dialog
        open={candidate !== null}
        onOpenChange={(value) => {
          if (!value && !restoring) setCandidate(null)
        }}
      >
        <DialogContent data-testid="backup-restore-dialog">
          <DialogHeader>
            <DialogTitle>{t('backupSettings.restore')}</DialogTitle>
            <DialogDescription>{t('backupSettings.restoreHint')}</DialogDescription>
          </DialogHeader>
          {candidate && (
            <>
              <p className="text-sm break-all">
                {candidate.fileName} · {formatDateTime(candidate.createdAt)}
              </p>
              <p className="text-sm">
                {t(
                  candidate.includesProfiles
                    ? 'backupSettings.restoreProfiles'
                    : 'backupSettings.restoreConfig',
                  { count: candidate.profiles },
                )}
              </p>
              {candidate.otherMachine && <Notice tone="warning">{t('backupSettings.otherMachine')}</Notice>}
            </>
          )}
          {restoring && <p role="status">{t('backupSettings.restarting')}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={restoring} onClick={() => setCandidate(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={restoring || busy}
              onClick={() => void restore()}
              data-testid="backup-restore-confirm"
            >
              {t('backupSettings.confirmRestore')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
