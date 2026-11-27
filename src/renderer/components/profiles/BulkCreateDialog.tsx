import { zodResolver } from '@hookform/resolvers/zod'
import { LoaderCircle } from 'lucide-react'
import { useMemo } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { LIMITS } from '@shared/constants'
import { bulkCreateSchema, launchOptionsSchema, sequentialNames } from '@shared/schemas/profile'
import { BrowserSelect } from '@renderer/components/common/BrowserBadge'
import { Field } from '@renderer/components/common/Field'
import { hostOs, OsSegmented } from '@renderer/components/common/OsBadge'
import { GroupSelect, ProxySelect, TagPicker } from '@renderer/components/common/pickers'
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
import { toastError } from '@renderer/lib/ipc'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useSettingsStore } from '@renderer/stores/settings.store'
import { useUiStore } from '@renderer/stores/ui.store'

const startupUrlSchema = launchOptionsSchema.shape.startupUrls.element

/** O formulário tem um campo de página inicial; o IPC recebe a lista `startupUrls`. */
const formSchema = bulkCreateSchema.omit({ startupUrls: true }).extend({
  startupUrl: z
    .string()
    .trim()
    .max(2048, 'tooLong')
    .refine((value) => value === '' || startupUrlSchema.safeParse(value).success, 'invalidUrl'),
})
type FormInput = z.input<typeof formSchema>
type FormOutput = z.output<typeof formSchema>

function BulkCreateForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const bulkCreate = useProfilesStore((s) => s.bulkCreate)
  const byId = useProfilesStore((s) => s.byId)
  const startPage = useSettingsStore((s) => s.settings.startPage)
  const defaultBrowser = useSettingsStore((s) => s.settings.defaultBrowser)

  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      count: 10,
      namePrefix: t('bulkCreate.prefixPlaceholder'),
      browser: defaultBrowser,
      os: hostOs(),
      groupId: null,
      proxyId: null,
      tagIds: [],
      startupUrl: '',
    },
  })
  const { errors, isSubmitting } = form.formState
  const count = useWatch({ control: form.control, name: 'count' })
  const prefix = useWatch({ control: form.control, name: 'namePrefix' })

  const preview = useMemo(() => {
    const n = Number(count)
    const trimmed = String(prefix ?? '').trim()
    if (!trimmed || !Number.isInteger(n) || n < 1 || n > LIMITS.bulkCreateMax) return null
    const existing = Object.values(byId)
      .filter((p) => p.deletedAt === null)
      .map((p) => p.name)
    const names = sequentialNames(trimmed, n, existing)
    return { first: names[0] ?? '', last: names[names.length - 1] ?? '' }
  }, [count, prefix, byId])

  const onSubmit = form.handleSubmit(async ({ startupUrl, ...values }) => {
    try {
      await bulkCreate({ ...values, startupUrls: startupUrl ? [startupUrl] : [] })
      onDone()
    } catch (error) {
      toastError(error)
    }
  })

  const total = Number(count) || 0

  return (
    <form onSubmit={onSubmit} className="grid gap-5" noValidate>
      <DialogHeader>
        <DialogTitle>{t('bulkCreate.title')}</DialogTitle>
        <DialogDescription>{t('bulkCreate.description')}</DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-[minmax(0,120px)_minmax(0,1fr)] gap-4">
        <Field label={t('bulkCreate.count')} htmlFor="bulk-count" error={errors.count?.message}>
          <Input
            id="bulk-count"
            type="number"
            inputMode="numeric"
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            min={1}
            max={LIMITS.bulkCreateMax}
            {...form.register('count', { valueAsNumber: true })}
            data-testid="bulk-count-input"
          />
        </Field>
        <Field
          label={t('bulkCreate.prefix')}
          htmlFor="bulk-prefix"
          error={errors.namePrefix?.message}
          hint={preview ? t('bulkCreate.preview', preview) : undefined}
        >
          <Input
            id="bulk-prefix"
            {...form.register('namePrefix')}
            placeholder={t('bulkCreate.prefixPlaceholder')}
          />
        </Field>
      </div>

      <Field label={t('general.browser')} htmlFor="bulk-browser">
        <Controller
          control={form.control}
          name="browser"
          render={({ field }) => (
            <BrowserSelect
              id="bulk-browser"
              testId="bulk-browser"
              value={field.value ?? defaultBrowser}
              onChange={field.onChange}
            />
          )}
        />
      </Field>

      <Field label={t('bulkCreate.os')}>
        <Controller
          control={form.control}
          name="os"
          render={({ field }) => <OsSegmented value={field.value} onChange={field.onChange} />}
        />
      </Field>

      <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('bulkCreate.group')} htmlFor="bulk-group" className="min-w-0">
          <Controller
            control={form.control}
            name="groupId"
            render={({ field }) => (
              <GroupSelect id="bulk-group" value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
        <Field label={t('bulkCreate.proxy')} htmlFor="bulk-proxy" className="min-w-0">
          <Controller
            control={form.control}
            name="proxyId"
            render={({ field }) => (
              <ProxySelect id="bulk-proxy" value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
      </div>

      <Field label={t('bulkCreate.tags')} htmlFor="bulk-tags" error={errors.tagIds?.message}>
        <Controller
          control={form.control}
          name="tagIds"
          render={({ field }) => <TagPicker id="bulk-tags" value={field.value} onChange={field.onChange} />}
        />
      </Field>

      <Field
        label={t('bulkCreate.startPage')}
        htmlFor="bulk-start-page"
        error={errors.startupUrl?.message}
        hint={
          startPage ? t('bulkCreate.startPageHint', { url: startPage }) : t('bulkCreate.startPageHintBlank')
        }
      >
        <Input
          id="bulk-start-page"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={startPage || 'https://'}
          aria-invalid={errors.startupUrl ? true : undefined}
          {...form.register('startupUrl')}
          data-testid="bulk-start-page"
        />
      </Field>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={isSubmitting} data-testid="bulk-create-submit">
          {isSubmitting && <LoaderCircle className="animate-spin" />}
          {t('bulkCreate.submit', { count: total })}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function BulkCreateDialog() {
  const open = useUiStore((s) => s.bulkCreateOpen)
  const setOpen = useUiStore((s) => s.setBulkCreateOpen)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
        data-testid="bulk-create-dialog"
      >
        {open && <BulkCreateForm onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}
