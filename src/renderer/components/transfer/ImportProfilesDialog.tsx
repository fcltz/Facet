import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AppError } from '@shared/ipc/result'
import type { TransferImportResult, TransferPreview } from '@shared/schemas/transfer'
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
import { describeError, invoke, toastError } from '@renderer/lib/ipc'
import { runJob } from '@renderer/stores/jobs.store'
import { useUiStore } from '@renderer/stores/ui.store'
import { JobProgress } from './JobProgress'

function ImportForm({
  close,
  busy,
  setBusy,
}: {
  close: () => void
  busy: boolean
  setBusy: (busy: boolean) => void
}) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState<TransferPreview | null>(null)
  const [keys, setKeys] = useState<string[]>([])
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<TransferImportResult | null>(null)
  const token = useRef<string | null>(null)
  useEffect(
    () => () => {
      if (token.current) void invoke('transfer.discard', { token: token.current }).catch(toastError)
    },
    [],
  )
  const accept = (value: TransferPreview | null): void => {
    token.current = value?.token ?? null
    setPreview(value)
    setKeys(value?.profiles.map((profile) => profile.key) ?? [])
    setResult(null)
  }
  const pick = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await invoke('transfer.pickImport')
      if (next) {
        if (token.current) await invoke('transfer.discard', { token: token.current })
        accept(next)
      }
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }
  const unlock = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      accept(await invoke('transfer.unlock', { token: preview.token, password }))
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setPassword('')
      setBusy(false)
    }
  }
  const submit = async (): Promise<void> => {
    if (!preview) return
    setBusy(true)
    setError(null)
    try {
      const outcome = await runJob('import', (jobId) =>
        invoke('transfer.import', { jobId, token: preview.token, keys }),
      )
      setResult(outcome)
      toast.success(t('transfer.imported', { count: outcome.createdIds.length }))
    } catch (failure) {
      setError(describeError(failure))
      // Uma importação cancelada pode já ter concluído alguns perfis; a lista é atualizada por IPC.
      if (failure instanceof AppError && failure.code === 'CANCELLED') setPreview(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('transfer.importTitle')}</DialogTitle>
        <DialogDescription>{t('transfer.importDescription')}</DialogDescription>
      </DialogHeader>
      <Button variant="outline" disabled={busy} onClick={() => void pick()} data-testid="import-package-pick">
        {t('transfer.choosePackage')}
      </Button>
      {preview && (
        <div className="grid gap-3">
          <p className="text-sm font-medium break-all">{preview.fileName}</p>
          {preview.locked ? (
            <Field label={t('transfer.unlockPassword')} htmlFor="import-password">
              <div className="flex gap-2">
                <Input
                  id="import-password"
                  data-testid="import-password"
                  type="password"
                  autoComplete="off"
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void unlock()
                  }}
                />
                <Button
                  disabled={busy || !password}
                  onClick={() => void unlock()}
                  data-testid="import-unlock"
                >
                  {t('transfer.unlock')}
                </Button>
              </div>
            </Field>
          ) : (
            <>
              {preview.engineNewer && <Notice tone="warning">{t('transfer.newerEngine')}</Notice>}
              <div
                className="max-h-64 overflow-y-auto rounded-lg border"
                data-testid="import-package-preview"
              >
                {preview.profiles.map((profile) => (
                  <label key={profile.key} className="flex items-start gap-3 border-b p-3 last:border-b-0">
                    <Checkbox
                      checked={keys.includes(profile.key)}
                      disabled={busy || result !== null}
                      onCheckedChange={(value) =>
                        setKeys((current) =>
                          value ? [...current, profile.key] : current.filter((key) => key !== profile.key),
                        )
                      }
                    />
                    <span className="min-w-0 text-sm">
                      <span className="font-medium">{profile.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {t(`os.${profile.os}`)} · {t('transfer.cookieCount', { count: profile.cookies })} ·{' '}
                        {profile.data ? t('transfer.withData') : t('transfer.configOnly')}
                      </span>
                      {profile.extensionsMissing.length > 0 && (
                        <span className="block text-xs text-warning">
                          {t('transfer.missingExtensions', { count: profile.extensionsMissing.length })}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              {preview.extensions.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t('transfer.extensionsSummary', {
                    added: preview.extensions.filter((extension) => !extension.inLibrary).length,
                    reused: preview.extensions.filter((extension) => extension.inLibrary).length,
                  })}
                </p>
              )}
            </>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-testid="import-package-error">
          {error}
        </p>
      )}
      {result && (
        <div role="status" data-testid="import-package-result" className="text-sm">
          <p>{t('transfer.imported', { count: result.createdIds.length })}</p>
          {result.failed.map((failure, index) => (
            <p key={index} className="text-destructive">
              {failure.name}: {describeError(AppError.fromPayload(failure.error))}
            </p>
          ))}
        </div>
      )}
      <JobProgress />
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={close}>
          {t('common.close')}
        </Button>
        <Button
          disabled={busy || !preview || preview.locked || !keys.length || result !== null}
          onClick={() => void submit()}
          data-testid="import-package-submit"
        >
          {t('transfer.importAction')}
        </Button>
      </DialogFooter>
    </>
  )
}

export function ImportProfilesDialog() {
  const open = useUiStore((s) => s.importProfilesOpen)
  const setOpen = useUiStore((s) => s.setImportProfilesOpen)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) setOpen(value)
      }}
    >
      <DialogContent className="sm:max-w-xl" data-testid="import-profiles-dialog">
        {open && <ImportForm busy={busy} setBusy={setBusy} close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}
