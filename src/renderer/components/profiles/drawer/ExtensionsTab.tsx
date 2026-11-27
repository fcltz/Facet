import { CircleAlert, CircleCheck, Clock, RotateCcw, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  hasCriticalWarning,
  type ExtensionSummary,
  type ProfileExtensionState,
} from '@shared/schemas/extension'
import type { Profile } from '@shared/schemas/profile'
import { isBuiltinExtension } from '@shared/facet-extension'
import { EmptyState } from '@renderer/components/common/EmptyState'
import { Notice } from '@renderer/components/common/Field'
import {
  ExtensionIcon,
  ManifestBadge,
  PermissionBadges,
} from '@renderer/components/extensions/ExtensionBadges'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Switch } from '@renderer/components/ui/switch'
import { formatRelative } from '@renderer/lib/format'
import { invoke, toastError } from '@renderer/lib/ipc'
import { criticalPermissions, useExtensionsStore } from '@renderer/stores/extensions.store'
import { useUiStore } from '@renderer/stores/ui.store'
import type { ProfileForm } from './ProfileDrawer'

/** Situação da autoconfiguração da extensão neste perfil. */
function ConfigStatus({
  extension,
  state,
  onReapply,
}: {
  extension: ExtensionSummary
  state: ProfileExtensionState | undefined
  onReapply: () => void
}) {
  const { t } = useTranslation()
  if (!extension.config) return null
  if (extension.config.mode === 'always') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <RotateCcw className="size-3.5" />
        {t('extensionsTab.configAlways')}
      </p>
    )
  }
  if (state?.configError) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="flex items-center gap-1.5 text-destructive" data-testid="extension-config-failed">
          <CircleAlert className="size-3.5" />
          {t('extensionsTab.configFailed', { error: state.configError })}
        </span>
      </div>
    )
  }
  if (!state || state.configRevision === null || state.configAppliedAt === null) {
    return (
      <p
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="extension-config-pending"
      >
        <Clock className="size-3.5" />
        {t('extensionsTab.configPending')}
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="flex items-center gap-1.5 text-success" data-testid="extension-config-applied">
        <CircleCheck className="size-3.5" />
        {t('extensionsTab.configApplied', { when: formatRelative(state.configAppliedAt) })}
      </span>
      <Button type="button" variant="link" size="xs" className="h-auto p-0 text-xs" onClick={onReapply}>
        {t('extensionsTab.reapply')}
      </Button>
    </div>
  )
}

export function ExtensionsTab({ form, profile }: { form: ProfileForm; profile: Profile | null }) {
  const { t } = useTranslation()
  const loaded = useExtensionsStore((s) => s.loaded)
  const list = useExtensionsStore((s) => s.list)
  const lastConfigResult = useExtensionsStore((s) => s.lastConfigResult)
  const setPage = useUiStore((s) => s.setPage)
  const closeDrawer = useUiStore((s) => s.closeDrawer)
  const requestConfirm = useUiStore((s) => s.requestConfirm)
  const selectedIds = useWatch({ control: form.control, name: 'extensionIds' })
  const proxyId = useWatch({ control: form.control, name: 'proxyId' })
  const [states, setStates] = useState<Record<string, ProfileExtensionState>>({})
  const profileId = profile?.id ?? null
  const resultForProfile = lastConfigResult?.profileId === profileId ? lastConfigResult : null

  // Perfil novo aberto antes de a biblioteca carregar: entra com as extensões padrão.
  useEffect(() => {
    if (profileId || !loaded || form.getValues('extensionIds') !== undefined) return
    form.setValue(
      'extensionIds',
      list.filter((extension) => extension.isDefault).map((extension) => extension.id),
    )
  }, [profileId, loaded, list, form])

  // Estado por perfil (1ª carga, configuração aplicada); recarrega a cada resultado novo.
  useEffect(() => {
    if (!profileId) return
    let alive = true
    invoke('extensions.profileState', { profileId })
      .then((items) => {
        if (alive) setStates(Object.fromEntries(items.map((item) => [item.extensionId, item])))
      })
      .catch((error: unknown) => {
        if (alive) toastError(error)
      })
    return () => {
      alive = false
    }
  }, [profileId, resultForProfile])

  const selected = useMemo(() => new Set(selectedIds ?? []), [selectedIds])
  const riskySelected = list.some((extension) => selected.has(extension.id) && hasCriticalWarning(extension))

  const toggle = async (extension: ExtensionSummary, checked: boolean): Promise<void> => {
    if (checked && proxyId && hasCriticalWarning(extension)) {
      const confirmed = await requestConfirm({
        title: t('extensionsTab.riskyTitle'),
        description: t('extensionsTab.riskyDescription', {
          name: extension.name,
          permissions: criticalPermissions(extension),
        }),
        confirmLabel: t('extensionsTab.enableAnyway'),
        destructive: true,
      })
      if (!confirmed) return
    }
    const known = new Set(list.map((item) => item.id))
    const current = (form.getValues('extensionIds') ?? []).filter((id) => known.has(id))
    const next = checked
      ? [...new Set([...current, extension.id])]
      : current.filter((id) => id !== extension.id)
    form.setValue('extensionIds', next, { shouldDirty: true })
  }

  const reapply = async (extensionId: string): Promise<void> => {
    if (!profileId) return
    try {
      const items = await invoke('extensions.reapplyConfig', { profileId, extensionIds: [extensionId] })
      setStates(Object.fromEntries(items.map((item) => [item.extensionId, item])))
      toast.success(t('extensionsTab.reapplied'))
    } catch (error) {
      toastError(error)
    }
  }

  if (!loaded) {
    return (
      <div className="grid gap-3" aria-busy="true" aria-label={t('extensionsTab.loading')}>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  if (list.length === 0) {
    return (
      <EmptyState
        variant="extensions"
        title={t('extensionsTab.empty')}
        description={t('extensionsTab.emptyHint')}
        className="h-auto py-10"
        action={
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              closeDrawer()
              setPage('extensions')
            }}
          >
            {t('extensionsTab.openLibrary')}
          </Button>
        }
      />
    )
  }

  return (
    <div className="grid gap-4" data-testid="extensions-tab">
      <div>
        <h3 className="text-sm font-semibold">{t('extensionsTab.title')}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('extensionsTab.description')}{' '}
          {profile ? t('extensionsTab.restartHint') : t('extensionsTab.newProfileHint')}
        </p>
      </div>
      {proxyId && riskySelected && (
        <Notice tone="warning" icon={<ShieldAlert className="size-4" />}>
          {t('extensionsTab.riskyNotice')}
        </Notice>
      )}
      <ul className="grid gap-2">
        {list.map((extension) => {
          const checked = selected.has(extension.id)
          return (
            <li
              key={extension.id}
              className="flex items-start gap-3 rounded-xl border bg-card p-3 shadow-soft"
              data-testid="profile-extension"
              data-extension-id={extension.id}
            >
              <ExtensionIcon icon={extension.icon} />
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-medium">{extension.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{extension.version}</span>
                  <ManifestBadge manifestVersion={extension.manifestVersion} />
                  {extension.isDefault && (
                    <Badge variant="secondary" className="px-1.5 text-[10px]">
                      {t('extensionsTab.defaultBadge')}
                    </Badge>
                  )}
                </div>
                {isBuiltinExtension(extension) ? (
                  <p className="text-xs text-muted-foreground" data-testid="profile-extension-builtin">
                    {t('extensionsPage.builtinDescription')}
                  </p>
                ) : (
                  <PermissionBadges extension={extension} />
                )}
                {checked && profile && (
                  <ConfigStatus
                    extension={extension}
                    state={states[extension.id]}
                    onReapply={() => void reapply(extension.id)}
                  />
                )}
              </div>
              <Switch
                checked={checked}
                onCheckedChange={(value) => void toggle(extension, value)}
                aria-label={extension.name}
                data-testid="profile-extension-toggle"
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
