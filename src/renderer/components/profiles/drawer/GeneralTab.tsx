import { TriangleAlert } from 'lucide-react'
import { Controller, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { BrowserKind } from '@shared/constants'
import type { OsName } from '@shared/schemas/common'
import { createDefaultFingerprint } from '@shared/schemas/fingerprint'
import type { Profile } from '@shared/schemas/profile'
import { BrowserSelect } from '@renderer/components/common/BrowserBadge'
import { ColorPicker } from '@renderer/components/common/ColorPicker'
import { Field, Notice } from '@renderer/components/common/Field'
import { OsSegmented } from '@renderer/components/common/OsBadge'
import { GroupSelect, TagPicker } from '@renderer/components/common/pickers'
import { Input } from '@renderer/components/ui/input'
import { Textarea } from '@renderer/components/ui/textarea'
import { toastError } from '@renderer/lib/ipc'
import { useSettingsStore } from '@renderer/stores/settings.store'
import { formCapabilities, generateDraftFingerprint, rebrandDraft } from './fingerprint-draft'
import type { ProfileForm } from './ProfileDrawer'

export function GeneralTab({ form, profile }: { form: ProfileForm; profile: Profile | null }) {
  const { t } = useTranslation()
  const {
    register,
    control,
    formState: { errors },
  } = form
  const defaultBrowser = useSettingsStore((s) => s.settings.defaultBrowser)
  const os = useWatch({ control, name: 'os' })
  const browser = useWatch({ control, name: 'browser' }) ?? defaultBrowser
  const originalOs: OsName | null = profile?.os ?? null
  const osChanged = originalOs !== null && os !== originalOs
  // Trocar o navegador de um perfil já aberto: os dados dele foram gravados pelo navegador antigo.
  const browserChanged = profile !== null && profile.openCount > 0 && browser !== profile.browser

  return (
    <div className="grid gap-6">
      <Field label={t('general.name')} htmlFor="profile-name" error={errors.name?.message}>
        <Input
          id="profile-name"
          autoFocus
          autoComplete="off"
          placeholder={t('general.namePlaceholder')}
          aria-invalid={errors.name ? true : undefined}
          {...register('name')}
          data-testid="profile-name-input"
        />
      </Field>

      <Field
        label={t('general.browser')}
        htmlFor="profile-browser"
        hint={browserChanged ? undefined : t('general.browserHint')}
      >
        <Controller
          control={control}
          name="browser"
          render={({ field }) => (
            <BrowserSelect
              id="profile-browser"
              testId="profile-browser"
              value={field.value ?? defaultBrowser}
              onChange={(kind: BrowserKind) => {
                field.onChange(kind)
                // Marcas das Client Hints e User-Agent do navegador novo, com o mesmo hardware.
                const current = form.getValues('fingerprint')
                if (current)
                  form.setValue('fingerprint', rebrandDraft(current, formCapabilities(form)), {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
              }}
            />
          )}
        />
        {browserChanged && (
          <Notice tone="warning" icon={<TriangleAlert className="size-4" />}>
            {t('general.browserChangeWarning')}
          </Notice>
        )}
      </Field>

      <Field label={t('general.os')} hint={osChanged ? undefined : t('general.osHint')}>
        <Controller
          control={control}
          name="os"
          render={({ field }) => (
            <OsSegmented
              value={field.value}
              onChange={(os) => {
                field.onChange(os)
                const current = form.getValues('fingerprint')
                if (current) {
                  const capabilities = formCapabilities(form)
                  const base = createDefaultFingerprint({
                    os,
                    engineMajor: capabilities?.engineMajor ?? current.engineMajor,
                    timezone: current.timezone.id,
                    browser: capabilities,
                  })
                  const { device: _device, ...rest } = current
                  form.setValue(
                    'fingerprint',
                    {
                      ...rest,
                      ...(base.device ? { device: base.device } : {}),
                      mode: 'emulated',
                      os,
                      userAgent: base.userAgent,
                      uaData: base.uaData,
                      screen: base.screen,
                      navigator: base.device
                        ? base.navigator
                        : { ...current.navigator, platform: base.navigator.platform, maxTouchPoints: 0 },
                    },
                    { shouldDirty: true, shouldValidate: true },
                  )
                  // Em seguida, tela e hardware (ou aparelho) sorteados, sem repetir outro perfil.
                  generateDraftFingerprint(form, { fresh: true }).catch((error: unknown) => toastError(error))
                }
              }}
            />
          )}
        />
        {osChanged && (
          <Notice tone="warning" icon={<TriangleAlert className="size-4" />}>
            {t('general.osChangeWarning')}
          </Notice>
        )}
      </Field>

      <Field label={t('general.group')} htmlFor="profile-group">
        <Controller
          control={control}
          name="groupId"
          render={({ field }) => (
            <GroupSelect id="profile-group" value={field.value} onChange={field.onChange} />
          )}
        />
      </Field>

      <Field label={t('general.tags')} htmlFor="profile-tags" error={errors.tagIds?.message}>
        <Controller
          control={control}
          name="tagIds"
          render={({ field }) => (
            <TagPicker id="profile-tags" value={field.value} onChange={field.onChange} />
          )}
        />
      </Field>

      <Field label={t('general.color')}>
        <Controller
          control={control}
          name="color"
          render={({ field }) => <ColorPicker value={field.value} onChange={field.onChange} allowNone />}
        />
      </Field>

      <Field label={t('general.notes')} htmlFor="profile-notes" optional error={errors.notes?.message}>
        <Textarea
          id="profile-notes"
          rows={4}
          placeholder={t('general.notesPlaceholder')}
          className="resize-y"
          {...register('notes')}
        />
      </Field>
    </div>
  )
}
