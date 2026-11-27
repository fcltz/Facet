import { Copy, Link2, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { Controller, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LIMITS } from '@shared/constants'
import { launchOptionsSchema } from '@shared/schemas/profile'
import { Field, validationMessage } from '@renderer/components/common/Field'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Textarea } from '@renderer/components/ui/textarea'
import { toastError } from '@renderer/lib/ipc'
import type { ProfileForm } from './ProfileDrawer'
import { useSettingsStore } from '@renderer/stores/settings.store'

const urlSchema = launchOptionsSchema.shape.startupUrls.element
const DEFAULT_WINDOW = { width: 1280, height: 800 }

function StartupUrls({ form }: { form: ProfileForm }) {
  const { t } = useTranslation()
  const urls = useWatch({ control: form.control, name: 'launchOptions.startupUrls' })
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | undefined>()
  const fieldErrors = form.formState.errors.launchOptions?.startupUrls
  const listError =
    fieldErrors?.message ?? (Array.isArray(fieldErrors) ? fieldErrors.find(Boolean)?.message : undefined)

  const add = (): void => {
    const value = draft.trim()
    if (!value) return
    const parsed = urlSchema.safeParse(value)
    if (!parsed.success) {
      setDraftError(parsed.error.issues[0]?.message ?? 'invalidUrl')
      return
    }
    if (urls.length >= LIMITS.startupUrlsMax) {
      setDraftError('tooMany')
      return
    }
    form.setValue('launchOptions.startupUrls', [...urls, parsed.data], {
      shouldDirty: true,
      shouldValidate: true,
    })
    setDraft('')
    setDraftError(undefined)
  }

  const remove = (index: number): void =>
    form.setValue(
      'launchOptions.startupUrls',
      urls.filter((_, i) => i !== index),
      { shouldDirty: true, shouldValidate: true },
    )

  return (
    <Field
      label={t('advanced.startupUrls')}
      htmlFor="startup-url"
      hint={t('advanced.startupUrlsHint')}
      error={draftError ?? listError}
    >
      {urls.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {urls.map((url, index) => (
            <li key={`${url}-${index}`} className="flex items-center gap-2 px-3 py-2 text-sm">
              <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{url}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => remove(index)}
                aria-label={t('advanced.removeUrl', { url })}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id="startup-url"
          value={draft}
          placeholder={t('advanced.urlPlaceholder')}
          onChange={(event) => {
            setDraft(event.target.value)
            setDraftError(undefined)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              add()
            }
          }}
          spellCheck={false}
        />
        <Button type="button" variant="outline" onClick={add}>
          <Plus />
          {t('advanced.addUrl')}
        </Button>
      </div>
    </Field>
  )
}

function WindowSize({ form }: { form: ProfileForm }) {
  const { t } = useTranslation()
  const size = useWatch({ control: form.control, name: 'launchOptions.window' })
  const errors = form.formState.errors.launchOptions?.window
  return (
    <Field
      label={t('advanced.windowSize')}
      hint={t('advanced.windowHint')}
      error={errors?.width?.message ?? errors?.height?.message}
    >
      <label className="flex items-center gap-3 text-sm">
        <Switch
          checked={size !== null}
          onCheckedChange={(checked) =>
            form.setValue('launchOptions.window', checked ? { ...DEFAULT_WINDOW } : null, {
              shouldDirty: true,
              shouldValidate: true,
            })
          }
        />
        {t('advanced.customWindow')}
      </label>
      {size !== null && (
        <div className="grid max-w-xs grid-cols-2 gap-3">
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">{t('advanced.width')}</span>
            <Input
              type="number"
              min={400}
              max={7680}
              {...form.register('launchOptions.window.width', { valueAsNumber: true })}
            />
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">{t('advanced.height')}</span>
            <Input
              type="number"
              min={300}
              max={4320}
              {...form.register('launchOptions.window.height', { valueAsNumber: true })}
            />
          </div>
        </div>
      )}
    </Field>
  )
}

function ExtraArgs({ form }: { form: ProfileForm }) {
  const { t } = useTranslation()
  const initial = useWatch({ control: form.control, name: 'launchOptions.extraArgs' })
  const [text, setText] = useState(() => initial.join('\n'))
  const argErrors = form.formState.errors.launchOptions?.extraArgs
  let error: string | undefined
  if (argErrors) {
    if (Array.isArray(argErrors)) {
      const index = argErrors.findIndex(Boolean)
      const message = validationMessage(argErrors[index]?.message)
      if (message) error = t('advanced.lineError', { line: index + 1, message })
    } else {
      error = argErrors.message
    }
  }

  return (
    <Field
      label={t('advanced.extraArgs')}
      htmlFor="extra-args"
      hint={t('advanced.extraArgsHint')}
      error={error}
    >
      <Textarea
        id="extra-args"
        rows={4}
        value={text}
        spellCheck={false}
        placeholder={t('advanced.extraArgsPlaceholder')}
        className="font-mono text-[13px]"
        onChange={(event) => {
          setText(event.target.value)
          const lines = event.target.value
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
          form.setValue('launchOptions.extraArgs', lines, { shouldDirty: true, shouldValidate: true })
        }}
      />
    </Field>
  )
}

export function AdvancedTab({ form, profileId }: { form: ProfileForm; profileId: string | null }) {
  const root = useSettingsStore((s) => s.browsers[0]?.profilesDir)
  const { t } = useTranslation()

  const copyId = async (): Promise<void> => {
    if (!profileId) return
    try {
      await navigator.clipboard.writeText(profileId)
      toast.success(t('toasts.idCopied'))
    } catch (error) {
      toastError(error)
    }
  }

  return (
    <div className="grid gap-7">
      <StartupUrls form={form} />
      <WindowSize form={form} />

      <Field label={t('advanced.restoreTabs')} hint={t('advanced.restoreTabsHint')}>
        <Controller
          control={form.control}
          name="launchOptions.restoreTabs"
          render={({ field }) => (
            <label className="flex items-center gap-3 text-sm">
              <Switch checked={field.value} onCheckedChange={field.onChange} />
              {field.value ? t('common.on') : t('common.off')}
            </label>
          )}
        />
      </Field>

      <ExtraArgs form={form} />

      {profileId && (
        <div className="grid gap-4 rounded-xl border bg-muted/40 p-4">
          <Field label={t('advanced.profileId')}>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-2.5 py-1.5 font-mono text-[13px]">
                {profileId}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                onClick={() => void copyId()}
                aria-label={t('profiles.menu.copyId')}
              >
                <Copy />
              </Button>
            </div>
          </Field>
          <Field label={t('advanced.folder')} hint={t('advanced.folderPending')}>
            <code className="truncate rounded-md border bg-background px-2.5 py-1.5 font-mono text-[13px] text-muted-foreground">
              {root
                ? `${root}${window.api.platform === 'win32' ? '\\' : '/'}${profileId}`
                : `profiles/${profileId}`}
            </code>
          </Field>
        </div>
      )}
    </div>
  )
}
