import { ClipboardPaste, Info, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Controller, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { languagesForCountry } from '@shared/data/country-locales'
import type { FingerprintConfig } from '@shared/schemas/fingerprint'
import type { Profile } from '@shared/schemas/profile'
import { proxyEndpoint, proxyTitle, type ProxySummary } from '@shared/schemas/proxy'
import { CountryFlag } from '@renderer/components/common/CountryFlag'
import { Notice } from '@renderer/components/common/Field'
import { ProxyPicker, proxyLocation, ProxyStatusPill } from '@renderer/components/common/pickers'
import { RotateIpButton } from '@renderer/components/proxies/RotateIpButton'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { tr } from '@renderer/i18n'
import { formatRelative } from '@renderer/lib/format'
import { invoke, toastError } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { useProxiesStore } from '@renderer/stores/proxies.store'
import type { ProfileForm } from './ProfileDrawer'

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium">{children}</dd>
    </div>
  )
}

function ProxyDetails({ proxy }: { proxy: ProxySummary }) {
  const { t } = useTranslation()
  const checking = useProxiesStore((s) => Boolean(s.checking[proxy.id]))
  const check = useProxiesStore((s) => s.check)
  const location = proxyLocation(proxy)
  return (
    <div className="rounded-xl border bg-card p-4 shadow-soft" data-testid="proxy-details">
      <div className="flex items-center gap-3">
        <CountryFlag code={proxy.countryCode} className="h-5 w-[30px]" />
        <div className="min-w-0 flex-1">
          <div
            className={cn('truncate text-base font-semibold tabular-nums', !proxy.name && 'font-mono')}
            data-testid="proxy-details-title"
          >
            {proxyTitle(proxy)}
          </div>
          <div className="truncate text-xs text-muted-foreground">{location || proxy.host}</div>
        </div>
        <ProxyStatusPill proxy={proxy} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-3">
        <Detail label={t('proxyTab.details.type')}>{proxy.type.toUpperCase()}</Detail>
        <Detail label={t('proxyTab.details.endpoint')}>
          <span className="font-mono">{proxyEndpoint(proxy)}</span>
        </Detail>
        {proxy.name && (
          <Detail label={t('proxyTab.details.exitIp')}>
            <span className="font-mono">{proxy.exitIp ?? t('common.none')}</span>
          </Detail>
        )}
        <Detail label={t('proxyTab.details.auth')}>
          {proxy.hasPassword || proxy.username
            ? t('proxyTab.details.withAuth')
            : t('proxyTab.details.noAuth')}
        </Detail>
        <Detail label={t('proxyTab.details.timezone')}>{proxy.timezone ?? t('common.none')}</Detail>
        <Detail label={t('proxyTab.details.latency')}>
          {proxy.latencyMs !== null ? t('profiles.latency', { ms: proxy.latencyMs }) : t('common.none')}
        </Detail>
        <Detail label={t('proxyTab.details.lastCheck')}>
          {proxy.checkedAt !== null ? formatRelative(proxy.checkedAt) : t('common.never')}
        </Detail>
        {proxy.rotating && (
          <Detail label={t('proxyTab.details.rotating')}>
            {t('proxyTab.details.rotatingValue', { host: proxy.changeIpHost ?? '?' })}
          </Detail>
        )}
        {proxy.lastError && proxy.checkStatus === 'offline' && (
          <Detail label={t('proxyTab.details.lastError')}>
            <span className="text-destructive" title={proxy.lastError}>
              {proxy.lastError}
            </span>
          </Detail>
        )}
      </dl>
      <div className="mt-4 flex flex-wrap gap-2 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={() => void check([proxy.id])}
          data-testid="proxy-tab-check"
        >
          {checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          {checking ? t('proxies.checking') : t('proxyTab.checkNow')}
        </Button>
        <RotateIpButton proxy={proxy} />
      </div>
    </div>
  )
}

/** Mostra o que muda nos campos "auto" do fingerprint com este proxy. */
function SyncPreview({ proxy, fingerprint }: { proxy: ProxySummary; fingerprint: FingerprintConfig | null }) {
  const { t } = useTranslation()
  if (!proxy.countryCode) {
    return (
      <Notice icon={<Info className="size-4" />} title={t('proxyTab.sync.title')}>
        {t('proxyTab.sync.unchecked')}
      </Notice>
    )
  }
  const auto = {
    timezone: (fingerprint?.timezone.mode ?? 'auto') === 'auto',
    languages: (fingerprint?.languages.mode ?? 'auto') === 'auto',
    geolocation: (fingerprint?.geolocation.mode ?? 'auto') === 'auto',
  }
  const languages = languagesForCountry(proxy.countryCode)
  const coordinates =
    proxy.latitude !== null && proxy.longitude !== null
      ? `${proxy.latitude.toFixed(4)}, ${proxy.longitude.toFixed(4)}`
      : null
  const rows: { key: string; label: string; value: string | null; auto: boolean }[] = [
    { key: 'timezone', label: t('proxyTab.sync.timezone'), value: proxy.timezone, auto: auto.timezone },
    {
      key: 'languages',
      label: t('proxyTab.sync.languages'),
      value: languages?.join(', ') ?? null,
      auto: auto.languages,
    },
    { key: 'geolocation', label: t('proxyTab.sync.geolocation'), value: coordinates, auto: auto.geolocation },
  ]
  return (
    <div className="rounded-xl border bg-card p-4" data-testid="proxy-sync-preview">
      <h4 className="text-sm font-semibold">{t('proxyTab.sync.title')}</h4>
      <dl className="mt-3 grid gap-2">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[140px_minmax(0,1fr)] gap-3 text-sm">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 truncate">
              {row.auto ? (
                <span className="font-mono text-[13px]">{row.value ?? t('common.none')}</span>
              ) : (
                <span className="text-muted-foreground">{t('proxyTab.sync.manual')}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{t('proxyTab.sync.note')}</p>
    </div>
  )
}

/** "Colar proxy": cadastra a linha colada (ou acha o proxy já cadastrado) e a seleciona no perfil. */
function PasteProxy({ onPicked }: { onPicked: (proxyId: string) => void }) {
  const { t } = useTranslation()
  const [line, setLine] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    const text = line.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    try {
      const preview = await invoke('proxies.parseImport', { text, defaultType: 'http' })
      const parsed = preview.lines[0]
      if (!parsed || preview.lines.length !== 1) {
        setError(t('proxyTab.paste.oneLine'))
        return
      }
      if (parsed.status === 'invalid') {
        setError(tr(`proxyImport.errors.${parsed.error ?? 'invalidFormat'}`, parsed.error ?? ''))
        return
      }
      if (parsed.status === 'duplicate') {
        const existing = useCatalogStore
          .getState()
          .proxies.find(
            (proxy) =>
              proxy.type === parsed.type &&
              proxyEndpoint(proxy).toLowerCase() === parsed.endpoint?.toLowerCase() &&
              proxy.username === parsed.username,
          )
        if (!existing) {
          setError(tr(`proxyImport.errors.${parsed.error ?? 'alreadyExists'}`, ''))
          return
        }
        onPicked(existing.id)
        setLine('')
        return
      }
      const result = await invoke('proxies.import', { text, defaultType: 'http', checkAfter: true })
      useCatalogStore.getState().applyProxies({ upserted: result.created, removedIds: [] })
      const created = result.created[0]
      if (created) {
        onPicked(created.id)
        setLine('')
      }
    } catch (failure) {
      toastError(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input
          value={line}
          onChange={(event) => {
            setLine(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
          placeholder={t('proxyTab.paste.placeholder')}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-[13px]"
          aria-label={t('proxyTab.paste.label')}
          data-testid="proxy-paste"
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || !line.trim()}
          onClick={() => void submit()}
          data-testid="proxy-paste-submit"
        >
          {busy ? <LoaderCircle className="animate-spin" /> : <ClipboardPaste />}
          {t('proxyTab.paste.action')}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t('proxyTab.paste.hint')}</p>
      )}
    </div>
  )
}

export function ProxyTab({ form, profile }: { form: ProfileForm; profile: Profile | null }) {
  const { t } = useTranslation()
  const proxyId = useWatch({ control: form.control, name: 'proxyId' })
  const proxy = useCatalogStore((s) => (proxyId ? s.proxiesById[proxyId] : undefined))

  return (
    <div className="grid gap-5">
      <div>
        <h3 className="text-sm font-semibold">{t('proxyTab.title')}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t('proxyTab.description')}</p>
      </div>

      {proxy ? (
        <>
          <ProxyDetails proxy={proxy} />
          <SyncPreview proxy={proxy} fingerprint={profile?.fingerprint ?? null} />
        </>
      ) : (
        <Notice tone="warning" icon={<TriangleAlert className="size-4" />}>
          {t('proxyTab.directWarning')}
        </Notice>
      )}

      <Controller
        control={form.control}
        name="proxyId"
        render={({ field }) => (
          <>
            <ProxyPicker value={field.value} onChange={(next) => field.onChange(next)} />
            <PasteProxy onPicked={(id) => field.onChange(id)} />
          </>
        )}
      />

      <Notice icon={<Info className="size-4" />}>{t('proxyTab.managerNotice')}</Notice>
    </div>
  )
}
