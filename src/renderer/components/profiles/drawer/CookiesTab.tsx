import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { parseCookies } from '@shared/cookies/formats'
import type {
  CookieFormat,
  CookieImportResult,
  CookieParseOutcome,
  CookieStatus,
} from '@shared/schemas/cookies'
import { Field, Notice } from '@renderer/components/common/Field'
import { Button } from '@renderer/components/ui/button'
import { Textarea } from '@renderer/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { tr } from '@renderer/i18n'
import { invoke, toastError } from '@renderer/lib/ipc'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useUiStore } from '@renderer/stores/ui.store'

export function CookiesTab({ profileId }: { profileId: string | null }) {
  const { t } = useTranslation()
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<CookieParseOutcome | null>(null)
  const [status, setStatus] = useState<CookieStatus | null>(null)
  const [result, setResult] = useState<CookieImportResult | null>(null)
  const [format, setFormat] = useState<CookieFormat>('json')
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const runtime = useProfilesStore((s) => (profileId ? s.statuses[profileId] : undefined))
  useIpcEvent('cookies.applied', (event) => {
    if (event.profileId === profileId) setRefresh((value) => value + 1)
  })
  useEffect(() => {
    if (!profileId) return
    let alive = true
    void invoke('cookies.status', { id: profileId })
      .then((value) => {
        if (alive) setStatus(value)
      })
      .catch(toastError)
    return () => {
      alive = false
    }
  }, [profileId, runtime, refresh])
  if (!profileId) return <Notice>{t('cookiesEditor.saveFirst')}</Notice>
  const readFile = async (): Promise<void> => {
    setBusy(true)
    try {
      const file = await invoke('cookies.pickFile')
      if (file) {
        setSource(file.text)
        setPreview(null)
        setResult(null)
      }
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }
  const importCookies = async (): Promise<void> => {
    if (!preview?.ok || !preview.cookies.length) return
    setBusy(true)
    try {
      const outcome = await invoke('cookies.import', { id: profileId, cookies: preview.cookies })
      setResult(outcome)
      setSource('')
      setPreview(null)
      setRefresh((value) => value + 1)
      toast.success(
        t(outcome.applied === 'now' ? 'cookiesEditor.imported' : 'cookiesEditor.queued', {
          count: outcome.imported,
        }),
      )
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }
  const exportCookies = async (target: 'file' | 'clipboard'): Promise<void> => {
    setBusy(true)
    try {
      const outcome = await invoke('cookies.export', { id: profileId, format, target })
      if (target === 'clipboard' && outcome.text !== null) await navigator.clipboard.writeText(outcome.text)
      if (target === 'clipboard' || outcome.file)
        toast.success(t('cookiesEditor.exported', { count: outcome.count }))
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }
  const clear = async (): Promise<void> => {
    if (
      !(await useUiStore.getState().requestConfirm({
        title: t('cookiesEditor.clear'),
        description: t('cookiesEditor.clearHint'),
        destructive: true,
      }))
    )
      return
    setBusy(true)
    try {
      setStatus(await invoke('cookies.clearPending', { id: profileId }))
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="grid gap-5" data-testid="cookies-editor">
      <Notice>{t('cookiesEditor.description')}</Notice>
      <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
        <p className="text-sm" data-testid="cookies-pending">
          {t('cookiesEditor.pending', { count: status?.pending ?? 0 })}
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy || !status?.pending}
          onClick={() => void clear()}
        >
          {t('cookiesEditor.clear')}
        </Button>
      </div>
      <Field label={t('cookiesEditor.input')} htmlFor="cookies-source" hint={t('cookiesEditor.formats')}>
        <Textarea
          id="cookies-source"
          data-testid="cookies-source"
          rows={7}
          value={source}
          disabled={busy}
          spellCheck={false}
          onChange={(event) => {
            setSource(event.target.value)
            setPreview(null)
            setResult(null)
          }}
        />
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            data-testid="cookies-file"
            onClick={() => void readFile()}
          >
            {t('cookiesEditor.choose')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !source.trim()}
            data-testid="cookies-preview"
            onClick={() => setPreview(parseCookies(source))}
          >
            {t('cookiesEditor.preview')}
          </Button>
        </div>
      </Field>
      {preview &&
        (!preview.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {tr(`cookiesEditor.parseErrors.${preview.error}`)}
          </p>
        ) : (
          <div className="grid gap-3" data-testid="cookies-summary">
            <p className="text-sm">
              {t('cookiesEditor.summary', {
                valid: preview.cookies.length,
                rejected: preview.rejected.length,
                expired: preview.expired,
                duplicates: preview.duplicates,
              })}
            </p>
            {preview.rejected.length > 0 && (
              <ul className="max-h-40 overflow-y-auto text-xs text-destructive">
                {preview.rejected.slice(0, 100).map((item, index) => (
                  <li key={index}>
                    {item.position}. {item.domain} · {item.name} —{' '}
                    {tr(`cookiesEditor.reasons.${item.reason}`)}
                  </li>
                ))}
              </ul>
            )}
            <Button
              type="button"
              disabled={busy || !preview.cookies.length}
              data-testid="cookies-import"
              onClick={() => void importCookies()}
            >
              {t('cookiesEditor.apply')}
            </Button>
          </div>
        ))}
      {result && (
        <div role="status" className="text-sm" data-testid="cookies-result">
          <p>
            {t(result.applied === 'now' ? 'cookiesEditor.imported' : 'cookiesEditor.queued', {
              count: result.imported,
            })}
          </p>
          {result.failed.map((item, index) => (
            <p className="text-destructive" key={index}>
              {item.domain} · {item.name}: {tr(`cookiesEditor.reasons.${item.reason}`, item.reason)}
            </p>
          ))}
        </div>
      )}
      <div className="grid gap-3 border-t pt-5">
        <Field label={t('cookiesEditor.export')} htmlFor="cookies-format">
          <Select value={format} onValueChange={(value) => setFormat(value as CookieFormat)}>
            <SelectTrigger id="cookies-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="json">JSON (EditThisCookie)</SelectItem>
              <SelectItem value="netscape">Netscape (cookies.txt)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <p className="text-xs text-muted-foreground">
          {t(format === 'netscape' ? 'cookiesEditor.netscapeHint' : 'cookiesEditor.exportHint')}
        </p>
        <div className="flex gap-2">
          <Button
            type="button"
            disabled={busy}
            variant="outline"
            data-testid="cookies-export"
            onClick={() => void exportCookies('file')}
          >
            {t('common.save')}
          </Button>
          <Button
            type="button"
            disabled={busy}
            variant="outline"
            data-testid="cookies-copy"
            onClick={() => void exportCookies('clipboard')}
          >
            {t('cookiesEditor.copy')}
          </Button>
        </div>
      </div>
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      )}
    </div>
  )
}
