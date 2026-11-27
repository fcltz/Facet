import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LIMITS } from '@shared/constants'
import { isRuntimeActive } from '@shared/schemas/profile'
import type { ExportOptions } from '@shared/schemas/transfer'
import { Field, Notice } from '@renderer/components/common/Field'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { invoke, toastError } from '@renderer/lib/ipc'
import { runJob, useJobsStore } from '@renderer/stores/jobs.store'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { JobProgress } from './JobProgress'

function ExportForm({ ids, close }: { ids: string[]; close: () => void }) {
  const { t } = useTranslation()
  const [options, setOptions] = useState<Omit<ExportOptions, 'password'>>({
    browserData: true,
    cookies: true,
    extensions: true,
    proxy: false,
    proxySecrets: false,
  })
  const [password, setPassword] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const statuses = useProfilesStore((s) => s.statuses)
  const busy = useJobsStore((s) => s.current !== null)
  const running = ids.filter((id) => isRuntimeActive(statuses[id] ?? 'stopped')).length
  const passwordValid = password.length === 0 || password.length >= LIMITS.transferPasswordMin
  const submit = async (): Promise<void> => {
    if (running && !confirmed) return
    try {
      const result = await runJob('export', (jobId) =>
        invoke('transfer.export', { jobId, ids, options: { ...options, password: password || null } }),
      )
      if (result.file) {
        toast.success(t('transfer.exported', { count: result.profiles }), { description: result.file })
        close()
      }
    } catch (error) {
      toastError(error)
    } finally {
      setPassword('')
      setOptions((value) => ({ ...value, proxySecrets: false }))
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('transfer.exportTitle')}</DialogTitle>
        <DialogDescription>{t('transfer.exportDescription', { count: ids.length })}</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        {(['browserData', 'cookies', 'extensions', 'proxy', 'proxySecrets'] as const).map((key) => (
          <label className="flex items-center gap-3 text-sm" key={key}>
            <Checkbox
              data-testid={`export-${key}`}
              checked={options[key]}
              disabled={
                busy ||
                (key === 'proxySecrets' && (!options.proxy || password.length < LIMITS.transferPasswordMin))
              }
              onCheckedChange={(checked) =>
                setOptions((value) => ({
                  ...value,
                  [key]: checked === true,
                  ...(key === 'proxy' && !checked ? { proxySecrets: false } : {}),
                }))
              }
            />
            {t(`transfer.options.${key}`)}
          </label>
        ))}
        <Field
          label={t('transfer.password')}
          htmlFor="export-password"
          hint={t('transfer.passwordHint', { min: LIMITS.transferPasswordMin })}
        >
          <Input
            id="export-password"
            type="password"
            autoComplete="new-password"
            value={password}
            maxLength={LIMITS.transferPasswordMax}
            disabled={busy}
            data-testid="export-password"
            onChange={(event) => {
              setPassword(event.target.value)
              if (event.target.value.length < LIMITS.transferPasswordMin)
                setOptions((value) => ({ ...value, proxySecrets: false }))
            }}
          />
        </Field>
        {!password && <Notice tone="warning">{t('transfer.unprotected')}</Notice>}
        <p className="text-xs text-muted-foreground">{t('transfer.portableHint')}</p>
        {running > 0 && (
          <label className="flex items-start gap-3 rounded-lg border border-warning/30 p-3 text-sm">
            <Checkbox
              data-testid="export-confirm-stop"
              checked={confirmed}
              disabled={busy}
              onCheckedChange={(value) => setConfirmed(value === true)}
            />
            {t('transfer.stopConfirmation', { count: running })}
          </label>
        )}
        <JobProgress />
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={close}>
          {t('common.cancel')}
        </Button>
        <Button
          disabled={busy || !ids.length || !passwordValid || (running > 0 && !confirmed)}
          onClick={() => void submit()}
          data-testid="export-submit"
        >
          {t('bulk.export')}
        </Button>
      </DialogFooter>
    </>
  )
}

export function ExportProfilesDialog() {
  const { open, ids } = useUiStore((s) => s.exportProfiles)
  const close = useUiStore((s) => s.closeExportProfiles)
  const busy = useJobsStore((s) => s.current !== null)
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value && !busy) close()
      }}
    >
      <DialogContent className="sm:max-w-lg" data-testid="export-profiles-dialog">
        {open && <ExportForm ids={ids} close={close} />}
      </DialogContent>
    </Dialog>
  )
}
