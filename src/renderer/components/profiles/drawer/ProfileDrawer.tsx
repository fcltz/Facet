import { zodResolver } from '@hookform/resolvers/zod'
import { Info, LoaderCircle } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useForm, type FieldErrors, type UseFormReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import type { z } from 'zod'
import { AppError, isValidationIssueList } from '@shared/ipc/result'
import { PREVIEW_ENGINE_MAJOR } from '@shared/constants'
import { createDefaultFingerprint } from '@shared/schemas/fingerprint'
import { useSettingsStore } from '@renderer/stores/settings.store'
import {
  DEFAULT_LAUNCH_OPTIONS,
  formatSerial,
  isRuntimeActive,
  profileCreateSchema,
  type Profile,
} from '@shared/schemas/profile'
import { Notice } from '@renderer/components/common/Field'
import { hostOs } from '@renderer/components/common/OsBadge'
import { StatusLabel } from '@renderer/components/common/StatusDot'
import { Button } from '@renderer/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@renderer/components/ui/sheet'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@renderer/components/ui/tabs'
import { formatRelative } from '@renderer/lib/format'
import { invoke, toastError } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { useExtensionsStore } from '@renderer/stores/extensions.store'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { DRAWER_TABS, useUiStore, type DrawerTab } from '@renderer/stores/ui.store'
import { AdvancedTab } from './AdvancedTab'
import { CookiesTab } from './CookiesTab'
import { ExtensionsTab } from './ExtensionsTab'
import { draftFingerprintSettled, generateDraftFingerprint } from './fingerprint-draft'
import { FingerprintTab } from './FingerprintTab'
import { GeneralTab } from './GeneralTab'
import { ProxyTab } from './ProxyTab'

export type ProfileFormInput = z.input<typeof profileCreateSchema>
export type ProfileFormOutput = z.output<typeof profileCreateSchema>
export type ProfileForm = UseFormReturn<ProfileFormInput, unknown, ProfileFormOutput>

const TAB_FIELDS: Record<DrawerTab, (keyof ProfileFormInput)[]> = {
  general: ['name', 'browser', 'os', 'groupId', 'tagIds', 'color', 'notes'],
  proxy: ['proxyId'],
  fingerprint: ['fingerprint'],
  extensions: ['extensionIds'],
  cookies: [],
  advanced: ['launchOptions'],
}

function tabsWithErrors(errors: FieldErrors<ProfileFormInput>): Set<DrawerTab> {
  const tabs = new Set<DrawerTab>()
  for (const tab of DRAWER_TABS) {
    if (TAB_FIELDS[tab].some((field) => errors[field] !== undefined)) tabs.add(tab)
  }
  return tabs
}

function toFormValues(profile: Profile): ProfileFormInput {
  return {
    name: profile.name,
    browser: profile.browser,
    os: profile.os,
    groupId: profile.groupId,
    proxyId: profile.proxyId,
    tagIds: [...profile.tagIds],
    color: profile.color,
    notes: profile.notes,
    launchOptions: structuredClone(profile.launchOptions),
    extensionIds: [...profile.extensionIds],
    fingerprint: structuredClone(profile.fingerprint),
  }
}

/** Extensões padrão da biblioteca; antes de ela carregar, o servidor aplica os padrões. */
function defaultExtensionIds(): string[] | undefined {
  const { loaded, list } = useExtensionsStore.getState()
  return loaded ? list.filter((extension) => extension.isDefault).map((extension) => extension.id) : undefined
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((id) => set.has(id))
}

/**
 * Perfil novo começa em Emulação. Este rascunho só vale até chegar o gerado pelo processo
 * principal, com tela e hardware que nenhum perfil usa nem usou (ver `generateDraftFingerprint`).
 */
function newProfileDefaults(): ProfileFormInput {
  const { appInfo, browsers, settings } = useSettingsStore.getState()
  const browser = settings.defaultBrowser
  const capabilities = browsers.find((info) => info.kind === browser)?.fingerprintCapabilities
  const fingerprint = createDefaultFingerprint({
    os: hostOs(),
    engineMajor: capabilities?.engineMajor ?? PREVIEW_ENGINE_MAJOR,
    timezone: appInfo?.hostTimezone ?? 'UTC',
    mode: 'emulated',
    browser: capabilities,
  })
  return {
    name: '',
    browser,
    os: hostOs(),
    groupId: null,
    proxyId: null,
    tagIds: [],
    color: null,
    notes: '',
    launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
    extensionIds: defaultExtensionIds(),
    fingerprint,
  }
}

function DrawerSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-9 w-full" />
      <div className="grid gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  )
}

function ProfileFormView({ mode, profile }: { mode: 'create' | 'edit'; profile: Profile | null }) {
  const { t } = useTranslation()
  const tab = useUiStore((s) => s.drawer.tab)
  const setTab = useUiStore((s) => s.setDrawerTab)
  const closeDrawer = useUiStore((s) => s.closeDrawer)
  const create = useProfilesStore((s) => s.create)
  const update = useProfilesStore((s) => s.update)
  const status = useProfilesStore((s) => (profile ? (s.statuses[profile.id] ?? 'stopped') : 'stopped'))

  const defaults = useMemo(() => (profile ? toFormValues(profile) : newProfileDefaults()), [profile])
  const form: ProfileForm = useForm<ProfileFormInput, unknown, ProfileFormOutput>({
    resolver: zodResolver(profileCreateSchema),
    defaultValues: defaults,
    mode: 'onTouched',
  })
  const { errors, isSubmitting } = form.formState
  const errorTabs = tabsWithErrors(errors)

  // Perfil novo: já abre com um fingerprint aleatório de emulação, nunca usado por outro perfil.
  useEffect(() => {
    if (mode !== 'create') return
    generateDraftFingerprint(form, { fresh: true, initial: true }).catch((error: unknown) =>
      toastError(error),
    )
  }, [mode, form])

  const validateAndSave = form.handleSubmit(
    async (values) => {
      try {
        if (mode === 'create' || !profile) {
          await create(values)
          closeDrawer()
          return
        }
        const proxyChanged = values.proxyId !== profile.proxyId
        const browserChanged = (values.browser ?? profile.browser) !== profile.browser
        const extensionsChanged = !sameIds(values.extensionIds ?? profile.extensionIds, profile.extensionIds)
        const fingerprintChanged = JSON.stringify(values.fingerprint) !== JSON.stringify(profile.fingerprint)
        await update(profile.id, values)
        closeDrawer()
        const current = useProfilesStore.getState().statuses[profile.id] ?? 'stopped'
        if (
          (proxyChanged || browserChanged || extensionsChanged || fingerprintChanged) &&
          isRuntimeActive(current)
        ) {
          useUiStore
            .getState()
            .openRestartPrompt(
              [profile.id],
              browserChanged
                ? 'browser'
                : proxyChanged
                  ? 'proxy'
                  : extensionsChanged
                    ? 'extensions'
                    : 'fingerprint',
            )
        }
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === 'VALIDATION_ERROR' &&
          isValidationIssueList(error.details)
        ) {
          for (const issue of error.details) {
            form.setError(issue.path as keyof ProfileFormInput, { message: issue.message })
          }
        }
        toastError(error)
      }
    },
    (invalid) => {
      const first = DRAWER_TABS.find((tabKey) => tabsWithErrors(invalid).has(tabKey))
      if (first) setTab(first)
    },
  )
  // Um envio por vez, depois do último sorteio pedido (o inicial do perfil novo, a troca de
  // sistema ou de modo, ou o botão Gerar): nunca grava o rascunho anterior a ele.
  const submitting = useRef(false)
  const submit = async (): Promise<void> => {
    if (submitting.current) return
    submitting.current = true
    try {
      await draftFingerprintSettled(form)
      await validateAndSave()
    } finally {
      submitting.current = false
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          void submit()
        }
      }}
      className="flex h-full min-h-0 flex-col"
      noValidate
    >
      <SheetHeader className="gap-1 border-b px-6 py-5">
        <div className="flex items-center gap-3 pr-8">
          <SheetTitle className="truncate text-lg">
            {mode === 'create' ? t('drawer.createTitle') : t('drawer.editTitle')}
          </SheetTitle>
          {profile && <StatusLabel status={status} className="text-xs" />}
        </div>
        <SheetDescription>
          {profile ? (
            <>
              <span className="font-mono tabular-nums text-foreground" data-testid="drawer-serial">
                {formatSerial(profile.serial)}
              </span>{' '}
              · <span className="font-medium text-foreground">{profile.name}</span> ·{' '}
              {t('drawer.editDescription', { created: formatRelative(profile.createdAt) })}
            </>
          ) : (
            t('drawer.createDescription')
          )}
        </SheetDescription>
      </SheetHeader>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as DrawerTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="border-b px-4">
          <TabsList variant="line" className="h-11! w-full justify-start gap-1">
            {DRAWER_TABS.map((key) => (
              <TabsTrigger
                key={key}
                value={key}
                className="flex-none px-3 after:bg-primary data-[state=active]:text-primary"
                data-testid={`drawer-tab-${key}`}
              >
                {t(`drawer.tabs.${key}`)}
                {errorTabs.has(key) && (
                  <span
                    className="size-1.5 rounded-full bg-destructive"
                    title={t('drawer.tabHasErrors')}
                    aria-label={t('drawer.tabHasErrors')}
                  />
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
          {profile && isRuntimeActive(status) && (
            <Notice icon={<Info className="size-4" />} className="mb-5">
              {t('drawer.runningNotice')}
            </Notice>
          )}
          <TabsContent value="general">
            <GeneralTab form={form} profile={profile} />
          </TabsContent>
          <TabsContent value="proxy">
            <ProxyTab form={form} profile={profile} />
          </TabsContent>
          <TabsContent value="fingerprint">
            <FingerprintTab form={form} profile={profile} />
          </TabsContent>
          <TabsContent value="extensions">
            <ExtensionsTab form={form} profile={profile} />
          </TabsContent>
          <TabsContent value="cookies">
            <CookiesTab profileId={profile?.id ?? null} />
          </TabsContent>
          <TabsContent value="advanced">
            <AdvancedTab form={form} profileId={profile?.id ?? null} />
          </TabsContent>
        </div>
      </Tabs>

      <div className="flex items-center justify-end gap-2 border-t bg-card/60 px-6 py-4">
        <Button type="button" variant="outline" onClick={closeDrawer}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting}
          data-testid="drawer-submit"
          className={cn(isSubmitting && 'cursor-wait')}
        >
          {isSubmitting && <LoaderCircle className="animate-spin" />}
          {isSubmitting ? t('drawer.saving') : mode === 'create' ? t('drawer.create') : t('drawer.save')}
        </Button>
      </div>
    </form>
  )
}

function DrawerBody({ mode, profileId }: { mode: 'create' | 'edit'; profileId: string | null }) {
  const { t } = useTranslation()
  const closeDrawer = useUiStore((s) => s.closeDrawer)
  const [profile, setProfile] = useState<Profile | null>(null)

  useEffect(() => {
    if (mode !== 'edit' || !profileId) return
    let alive = true
    invoke('profiles.get', { id: profileId })
      .then((loaded) => {
        if (alive) setProfile(loaded)
      })
      .catch((error: unknown) => {
        if (!alive) return
        toastError(error, t('drawer.loadFailed'))
        closeDrawer()
      })
    return () => {
      alive = false
    }
  }, [mode, profileId, closeDrawer, t])

  if (mode === 'edit' && !profile) {
    return (
      <>
        <SheetHeader className="sr-only">
          <SheetTitle>{t('drawer.editTitle')}</SheetTitle>
          <SheetDescription>{t('common.loading')}</SheetDescription>
        </SheetHeader>
        <DrawerSkeleton />
      </>
    )
  }
  return <ProfileFormView mode={mode} profile={profile} />
}

/** Drawer lateral de criação e edição de perfil (abas Geral → Avançado). */
export function ProfileDrawer() {
  const drawer = useUiStore((s) => s.drawer)
  const closeDrawer = useUiStore((s) => s.closeDrawer)

  return (
    <Sheet open={drawer.open} onOpenChange={(open) => !open && closeDrawer()}>
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-[640px]" data-testid="profile-drawer">
        <DrawerBody
          key={`${drawer.mode}:${drawer.profileId ?? 'new'}`}
          mode={drawer.mode}
          profileId={drawer.profileId}
        />
      </SheetContent>
    </Sheet>
  )
}
