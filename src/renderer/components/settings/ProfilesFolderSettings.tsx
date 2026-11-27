import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { ProfilesRootCandidate } from '@shared/schemas/settings'
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
import { JobProgress } from '@renderer/components/transfer/JobProgress'
import { tr } from '@renderer/i18n'
import { invoke, toastError } from '@renderer/lib/ipc'
import { runJob, useJobsStore } from '@renderer/stores/jobs.store'
import { useSettingsStore } from '@renderer/stores/settings.store'

export function ProfilesFolderSettings() {
  const { t } = useTranslation()
  const root = useSettingsStore((s) => s.browsers[0]?.profilesDir ?? '')
  const custom = useSettingsStore((s) => Boolean(s.settings.profilesRoot))
  const busy = useJobsStore((s) => s.current !== null)
  const [picking, setPicking] = useState(false)
  const [candidate, setCandidate] = useState<ProfilesRootCandidate | null>(null)
  const pick = async (target: 'choose' | 'default'): Promise<void> => {
    setPicking(true)
    try {
      setCandidate(await invoke('profilesRoot.pick', { target }))
    } catch (error) {
      toastError(error)
    } finally {
      setPicking(false)
    }
  }
  const move = async (): Promise<void> => {
    if (!candidate || candidate.problem) return
    try {
      const result = await runJob('relocate', (jobId) =>
        invoke('profilesRoot.move', { jobId, token: candidate.token }),
      )
      useSettingsStore.getState().setBrowsers(await invoke('browser.getInfo'))
      setCandidate(null)
      toast.success(t('storageSettings.moved', { count: result.moved }))
    } catch (error) {
      toastError(error)
      setCandidate(null)
    }
  }
  return (
    <>
      <Field label={t('settings.profilesFolder')} htmlFor="profiles-root" hint={t('storageSettings.hint')}>
        <Input id="profiles-root" readOnly value={root} data-testid="profiles-root" />
      </Field>
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={busy || picking}
          onClick={() => void pick('choose')}
          data-testid="profiles-root-choose"
        >
          {t('storageSettings.choose')}
        </Button>
        {custom && (
          <Button variant="ghost" disabled={busy || picking} onClick={() => void pick('default')}>
            {t('storageSettings.default')}
          </Button>
        )}
      </div>
      <Dialog
        open={candidate !== null}
        onOpenChange={(value) => {
          if (!value && !busy) setCandidate(null)
        }}
      >
        <DialogContent data-testid="profiles-root-dialog">
          <DialogHeader>
            <DialogTitle>{t('storageSettings.move')}</DialogTitle>
            <DialogDescription>{t('storageSettings.moveHint')}</DialogDescription>
          </DialogHeader>
          {candidate && (
            <>
              <p className="break-all font-mono text-xs">{candidate.path}</p>
              <p className="text-sm">
                {t('storageSettings.size', {
                  count: candidate.profiles,
                  size: (candidate.bytes / 1024 ** 2).toFixed(1),
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t(candidate.sameVolume ? 'storageSettings.sameVolume' : 'storageSettings.copyVolume')}
              </p>
              {candidate.problem && (
                <Notice tone="warning">{tr(`storageSettings.problems.${candidate.problem}`)}</Notice>
              )}
            </>
          )}
          <JobProgress />
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setCandidate(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              disabled={busy || !candidate || Boolean(candidate.problem)}
              onClick={() => void move()}
              data-testid="profiles-root-move"
            >
              {t('storageSettings.move')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
