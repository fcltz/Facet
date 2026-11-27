import { LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { BROWSER_KINDS } from '@shared/constants'
import type { BrowserInfo } from '@shared/schemas/browser'
import { appSettingsSchema, DEFAULT_SETTINGS } from '@shared/schemas/settings'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { BrowserBadge, BrowserSelect, browserVersion } from './BrowserBadge'
import { Field } from './Field'
import { useSettingsStore } from '@renderer/stores/settings.store'
import { invoke, toastError } from '@renderer/lib/ipc'

/** Página que os perfis abrem quando não têm URLs iniciais nem abas a restaurar. */
function StartPageField() {
  const { t } = useTranslation()
  const current = useSettingsStore((s) => s.settings.startPage)
  const apply = useSettingsStore((s) => s.apply)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const parsed = appSettingsSchema.shape.startPage.safeParse(draft ?? current)
  const error = draft !== null && !parsed.success ? parsed.error.issues[0]?.message : undefined
  const changed = parsed.success && parsed.data !== current
  const save = async (value: string): Promise<void> => {
    setSaving(true)
    try {
      apply(await invoke('settings.update', { startPage: value }))
      setDraft(null)
      toast.success(t('settings.startPageSaved'))
    } catch (failure) {
      toastError(failure)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Field
      label={t('settings.startPage')}
      htmlFor="settings-start-page"
      hint={t('settings.startPageHint')}
      error={error}
    >
      <form
        className="flex max-w-xl flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (parsed.success && changed) void save(parsed.data)
        }}
      >
        <Input
          id="settings-start-page"
          data-testid="settings-start-page"
          className="min-w-64 flex-1"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="about:blank"
          value={draft ?? current}
          onChange={(event) => setDraft(event.target.value)}
          aria-invalid={error ? true : undefined}
          disabled={saving}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={saving || !changed}
          data-testid="settings-start-page-save"
        >
          {saving && <LoaderCircle className="animate-spin" />}
          {t('common.save')}
        </Button>
        {current !== DEFAULT_SETTINGS.startPage && (
          <Button
            type="button"
            variant="ghost"
            disabled={saving}
            onClick={() => void save(DEFAULT_SETTINGS.startPage)}
          >
            {t('settings.startPageDefault')}
          </Button>
        )}
      </form>
    </Field>
  )
}

/** Um navegador: estado, versão, de onde veio o executável e as ações de procurar e escolher. */
function BrowserRow({ info }: { info: BrowserInfo }) {
  const { t } = useTranslation()
  const setBrowser = useSettingsStore((s) => s.setBrowser)
  const [busy, setBusy] = useState<'detect' | 'select' | null>(null)
  const act = async (mode: 'detect' | 'select'): Promise<void> => {
    setBusy(mode)
    try {
      const result =
        mode === 'detect'
          ? await invoke('browser.detect', { kind: info.kind })
          : await invoke('browser.selectExecutable', { kind: info.kind })
      if (result) {
        setBrowser(result)
        if (!result.available) toast.error(result.error ?? t('browsers.notInstalled'))
      }
    } catch (error) {
      toastError(error)
    } finally {
      setBusy(null)
    }
  }
  const version = browserVersion(info)
  return (
    <li
      className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center"
      data-testid={`browser-${info.kind}`}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <BrowserBadge kind={info.kind} className="font-medium" />
          <span
            className={
              info.available && !info.checking ? 'text-xs text-success' : 'text-xs text-muted-foreground'
            }
            data-testid={`browser-${info.kind}-status`}
          >
            {info.checking
              ? t('browsers.checking')
              : info.available
                ? [version, info.source ? t(`browsers.source.${info.source}`) : null]
                    .filter(Boolean)
                    .join(' · ')
                : t('browsers.notInstalled')}
          </span>
        </div>
        {info.executablePath && (
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={info.executablePath}>
            {info.executablePath}
          </p>
        )}
        {!info.available && !info.checking && info.error && (
          <p className="mt-0.5 text-xs break-words text-muted-foreground">{info.error}</p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => void act('detect')}
          data-testid={`browser-${info.kind}-detect`}
        >
          {busy === 'detect' && <LoaderCircle className="animate-spin" />}
          {t(info.kind === 'ungoogled' ? 'browsers.useBundled' : 'browser.detect')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void act('select')}>
          {busy === 'select' && <LoaderCircle className="animate-spin" />}
          {t('browser.select')}
        </Button>
      </div>
    </li>
  )
}

export function BrowserSettings() {
  const { t } = useTranslation()
  const browsers = useSettingsStore((s) => s.browsers)
  const defaultBrowser = useSettingsStore((s) => s.settings.defaultBrowser)
  const update = useSettingsStore((s) => s.update)
  return (
    <div className="grid gap-4">
      <Field
        label={t('browsers.defaultLabel')}
        htmlFor="settings-default-browser"
        hint={t('browsers.defaultHint')}
      >
        <BrowserSelect
          id="settings-default-browser"
          testId="settings-default-browser"
          className="max-w-sm"
          value={defaultBrowser}
          onChange={(kind) => void update({ defaultBrowser: kind })}
        />
      </Field>
      <div className="grid gap-2">
        <p className="text-sm font-medium">{t('browsers.installed')}</p>
        <ul className="divide-y rounded-lg border" data-testid="browser-list">
          {BROWSER_KINDS.map((kind) => {
            const info = browsers.find((browser) => browser.kind === kind)
            return info ? <BrowserRow key={kind} info={info} /> : null
          })}
        </ul>
        <p className="text-xs text-muted-foreground">{t('browsers.listHint')}</p>
      </div>
      <StartPageField />
    </div>
  )
}
