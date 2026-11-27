import { RefreshCw, ShieldCheck, Smartphone } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Controller, useWatch } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import { BROWSER_NAMES } from '@shared/constants'
import { MOBILE_DEVICES, type MobileDevice } from '@shared/data/mobile-devices'
import { isMobileOs, type DesktopOs } from '@shared/schemas/common'
import {
  createDefaultFingerprint,
  fingerprintDevice,
  SCREEN_PRESETS,
  sameScreen,
  screenKey,
  type FingerprintConfig,
  type FingerprintSessionState,
} from '@shared/schemas/fingerprint'
import type { Profile } from '@shared/schemas/profile'
import { languagesForCountry } from '@shared/data/country-locales'
import { Field, Notice } from '@renderer/components/common/Field'
import { hostOs } from '@renderer/components/common/OsBadge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { useIpcEvent } from '@renderer/hooks/use-ipc-event'
import { invoke, toastError } from '@renderer/lib/ipc'
import { tr } from '@renderer/i18n'
import { useCatalogStore } from '@renderer/stores/catalog.store'
import { useProfilesStore } from '@renderer/stores/profiles.store'
import { useBrowser, useSettingsStore } from '@renderer/stores/settings.store'
import { generateDraftFingerprint } from './fingerprint-draft'
import type { ProfileForm } from './ProfileDrawer'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card shadow-soft">
      <h3 className="border-b px-4 py-3 text-sm font-semibold">{title}</h3>
      <div className="grid gap-4 p-4">{children}</div>
    </section>
  )
}

function Choice({
  value,
  onChange,
  options,
  label,
  id,
  disabled,
  disabledValues = [],
}: {
  value: string
  onChange: (value: string) => void
  options: readonly (readonly [string, string])[]
  label: string
  id: string
  disabled?: boolean
  /** Opções visíveis mas indisponíveis (ex.: Nativo num celular). */
  disabledValues?: readonly string[]
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} aria-label={label} data-testid={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([key, text]) => (
          <SelectItem
            key={key}
            value={key}
            disabled={disabledValues.includes(key)}
            data-testid={`${id}-${key}`}
          >
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** "Samsung Galaxy S24 · 384 × 832 · 2,8125×" */
function deviceLabel(device: MobileDevice, language: string): string {
  const ratio = new Intl.NumberFormat(language, { maximumFractionDigits: 4 }).format(device.screen.pixelRatio)
  return `${device.name} · ${device.screen.width} × ${device.screen.height} · ${ratio}×`
}

function FingerprintSession({ profile, config }: { profile: Profile | null; config: FingerprintConfig }) {
  const { t } = useTranslation()
  const [session, setSession] = useState<FingerprintSessionState | null>(null)
  const [refresh, setRefresh] = useState(0)
  const status = useProfilesStore((s) => (profile ? s.statuses[profile.id] : undefined))
  useIpcEvent('fingerprint.changed', (event) => {
    if (event.profileId === profile?.id) setRefresh((value) => value + 1)
  })
  useEffect(() => {
    if (!profile) return
    let alive = true
    void invoke('fingerprint.session', { id: profile.id })
      .then((value) => {
        if (alive) setSession(value)
      })
      .catch((error) => {
        if (alive) toastError(error)
      })
    return () => {
      alive = false
    }
  }, [profile, refresh, status])
  const applied = session?.snapshot?.effective
  const observed = session?.observations.find((value) => value.targetType === 'page')
  const native = t('fingerprintEditor.braveControlled')
  const resolution = (fp: FingerprintConfig | undefined): string =>
    fp ? (fp.mode === 'native' ? native : `${fp.screen.width} × ${fp.screen.height}`) : '—'
  const rows: [string, string, string, string][] = [
    [
      t('fingerprintEditor.mode'),
      t(`fingerprintEditor.${config.mode}`),
      applied ? t(`fingerprintEditor.${applied.mode}`) : '—',
      '—',
    ],
    [
      'User-Agent',
      config.mode === 'native' ? native : config.userAgent,
      applied ? (applied.mode === 'native' ? native : applied.userAgent) : '—',
      observed?.userAgent ?? '—',
    ],
    [
      t('fingerprint.fields.platform'),
      config.mode === 'native' ? native : config.navigator.platform,
      applied ? (applied.mode === 'native' ? native : applied.navigator.platform) : '—',
      observed?.platform ?? '—',
    ],
    [
      t('fingerprint.fields.timezone'),
      config.timezone.mode === 'auto' ? t('fingerprintEditor.auto') : config.timezone.id,
      applied?.timezone.id ?? '—',
      observed?.timezone ?? '—',
    ],
    [
      t('fingerprint.fields.languages'),
      config.languages.mode === 'auto' ? t('fingerprintEditor.auto') : config.languages.list.join(', '),
      applied?.languages.list.join(', ') ?? '—',
      observed?.languages.join(', ') ?? '—',
    ],
    [
      t('fingerprint.fields.cores'),
      config.mode === 'native' ? native : String(config.navigator.hardwareConcurrency),
      applied ? (applied.mode === 'native' ? native : String(applied.navigator.hardwareConcurrency)) : '—',
      observed ? String(observed.hardwareConcurrency) : '—',
    ],
    [
      t('fingerprint.fields.memory'),
      config.mode === 'native' || config.navigator.deviceMemory === null
        ? native
        : `${config.navigator.deviceMemory} GB`,
      applied
        ? applied.mode === 'native' || applied.navigator.deviceMemory === null
          ? native
          : `${applied.navigator.deviceMemory} GB`
        : '—',
      observed?.deviceMemory == null ? '—' : `${observed.deviceMemory} GB`,
    ],
    [
      t('fingerprint.fields.resolution'),
      resolution(config),
      resolution(applied),
      observed?.screen ? `${observed.screen.width} × ${observed.screen.height}` : '—',
    ],
    [
      t('fingerprint.fields.touch'),
      config.mode === 'native' ? native : String(config.navigator.maxTouchPoints),
      applied ? (applied.mode === 'native' ? native : String(applied.navigator.maxTouchPoints)) : '—',
      observed?.maxTouchPoints == null ? '—' : String(observed.maxTouchPoints),
    ],
  ]
  return (
    <Section title={t('fingerprintEditor.comparison')}>
      {session?.pendingRestart && <Notice tone="warning">{t('fingerprintEditor.pendingRestart')}</Notice>}
      <p className="text-xs text-muted-foreground">{t('fingerprintEditor.comparisonHint')}</p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full table-fixed text-left text-xs" data-testid="fingerprint-comparison">
          <thead className="bg-muted/50">
            <tr>
              {(['field', 'configured', 'session', 'observed'] as const).map((key) => (
                <th key={key} className="p-2 font-medium">
                  {t(`fingerprintEditor.${key}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, ...values]) => (
              <tr className="border-t align-top" key={label}>
                <th className="p-2 font-medium">{label}</th>
                {values.map((value, index) => (
                  <td key={index} className="p-2 break-words">
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {session?.active && (
        <Button type="button" variant="outline" size="sm" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw />
          {t('fingerprintEditor.refresh')}
        </Button>
      )}
      {session?.observations
        .filter((value) => value.targetType !== 'page')
        .map((value, index) => (
          <p key={index} className="text-xs text-muted-foreground break-all">
            {value.targetType}: {value.platform} · {value.timezone} · {value.hardwareConcurrency} CPU ·{' '}
            {value.userAgent}
          </p>
        ))}
      {session?.warnings.map((code) => (
        <p key={code} className="text-xs leading-relaxed text-muted-foreground">
          {tr(`fingerprintEditor.warnings.${code}`)}
        </p>
      ))}
    </Section>
  )
}

export function FingerprintTab({ form, profile }: { form: ProfileForm; profile: Profile | null }) {
  const { t, i18n } = useTranslation()
  const config = useWatch({ control: form.control, name: 'fingerprint' })
  const proxyId = useWatch({ control: form.control, name: 'proxyId' })
  const proxy = useCatalogStore((s) => (proxyId ? s.proxiesById[proxyId] : undefined))
  const defaultBrowser = useSettingsStore((s) => s.settings.defaultBrowser)
  const browserKind = useWatch({ control: form.control, name: 'browser' }) ?? defaultBrowser
  const browser = useBrowser(browserKind)
  const app = useSettingsStore((s) => s.appInfo)
  const [generating, setGenerating] = useState(false)
  if (!config) return null
  const patch = (next: FingerprintConfig): void => {
    form.setValue('fingerprint', next, { shouldDirty: true, shouldValidate: true })
  }
  const emulated = config.mode === 'emulated'
  const capabilities = browser?.fingerprintCapabilities
  const mobile = isMobileOs(config.os)
  const device = fingerprintDevice(config)
  // Farbling do Brave ou flags do Ungoogled Chromium; Chrome e Opera não têm ruído nativo.
  const nativeNoise = capabilities?.nativeNoise ?? (browserKind === 'brave' || browserKind === 'ungoogled')
  const chooseDevice = (id: string): void => {
    const base = createDefaultFingerprint({
      os: config.os,
      engineMajor: capabilities?.engineMajor ?? config.engineMajor,
      timezone: config.timezone.id,
      device: id,
      browser: capabilities,
    })
    patch({
      ...config,
      device: base.device,
      userAgent: base.userAgent,
      uaData: base.uaData,
      navigator: base.navigator,
      screen: base.screen,
    })
  }
  const modes = [
    ['auto', t('fingerprintEditor.auto')],
    ['manual', t('fingerprint.modes.manual')],
  ] as const
  const autoTimezone = proxyId ? proxy?.timezone : app?.hostTimezone
  const autoLanguages = proxyId ? (proxy?.countryCode ? languagesForCountry(proxy.countryCode) : null) : null
  // Tela e hardware sorteados entre as combinações que nenhum perfil usa nem usou.
  const generate = async (fresh: boolean): Promise<void> => {
    setGenerating(true)
    try {
      await generateDraftFingerprint(form, { fresh })
    } catch (error) {
      toastError(error)
    } finally {
      setGenerating(false)
    }
  }
  return (
    <div className="grid gap-5" data-testid="fingerprint-tab">
      <Notice icon={<ShieldCheck className="size-4" />} title={t('fingerprint.noticeTitle')}>
        {t('fingerprint.noticeBody')}
      </Notice>
      <Field
        label={t('fingerprintEditor.mode')}
        htmlFor="fingerprint-mode"
        hint={t(emulated ? 'fingerprintEditor.emulatedHint' : 'fingerprintEditor.nativeHint')}
      >
        <Choice
          id="fingerprint-mode"
          label={t('fingerprintEditor.mode')}
          value={config.mode}
          options={(['native', 'emulated'] as const).map((value) => [value, t(`fingerprintEditor.${value}`)])}
          // Celular é sempre emulado: o Facet roda num computador.
          disabledValues={mobile ? ['native'] : []}
          onChange={(value) => {
            const os = value === 'native' ? hostOs() : config.os
            const base = createDefaultFingerprint({
              os,
              engineMajor: capabilities?.engineMajor ?? config.engineMajor,
              timezone: config.timezone.id,
              browser: capabilities,
            })
            const { device: _device, ...rest } = config
            patch({
              ...rest,
              os,
              mode: value as FingerprintConfig['mode'],
              userAgent:
                value === 'native' ? (capabilities?.nativeUserAgent ?? base.userAgent) : base.userAgent,
              uaData: base.uaData,
              navigator: { ...config.navigator, platform: base.navigator.platform },
            })
            form.setValue('os', os, { shouldDirty: true })
            if (value === 'emulated') void generate(true)
          }}
        />
      </Field>
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">{t('fingerprintEditor.draftHint')}</p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!emulated || generating}
          onClick={() => void generate(false)}
          data-testid="fingerprint-generate"
        >
          <RefreshCw className={generating ? 'animate-spin' : undefined} />
          {t('fingerprint.regenerate')}
        </Button>
      </div>
      {emulated && mobile && device && (
        <Section title={t('fingerprint.sections.device')}>
          <Field
            label={t('fingerprint.fields.device')}
            htmlFor="fp-device"
            hint={t('fingerprintEditor.deviceHint')}
          >
            <Choice
              id="fp-device"
              label={t('fingerprint.fields.device')}
              value={device.id}
              options={MOBILE_DEVICES[device.os].map(
                (item) => [item.id, deviceLabel(item, i18n.language)] as const,
              )}
              onChange={chooseDevice}
            />
          </Field>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs" data-testid="fp-device-summary">
            <dt className="text-muted-foreground">{t('fingerprint.fields.cores')}</dt>
            <dd>{device.cores}</dd>
            <dt className="text-muted-foreground">{t('fingerprint.fields.memory')}</dt>
            <dd>{device.memory === null ? t('fingerprintEditor.noDeviceMemory') : `${device.memory} GB`}</dd>
            <dt className="text-muted-foreground">{t('fingerprint.fields.touch')}</dt>
            <dd>{config.navigator.maxTouchPoints}</dd>
            <dt className="text-muted-foreground">{t('fingerprint.fields.gpu')}</dt>
            <dd className="break-words">
              {device.gpu.vendor} · {device.gpu.renderer}
            </dd>
          </dl>
          {config.os === 'ios' && (
            <Notice tone="warning" icon={<Smartphone className="size-4" />}>
              {t('fingerprintEditor.iosNotice')}
            </Notice>
          )}
          <p className="text-xs break-all text-muted-foreground">
            {config.userAgent}
            <br />
            {config.os === 'ios'
              ? t('fingerprintEditor.noClientHints')
              : `${config.uaData.brands.map((brand) => `${brand.brand}/${brand.version}`).join(' · ')} · ${config.uaData.platform} ${config.uaData.platformVersion} · ${config.uaData.model}`}
          </p>
        </Section>
      )}
      {emulated && !mobile && (
        <Section title={t('fingerprint.sections.hardware')}>
          <div className="grid grid-cols-2 gap-4">
            <Field
              label={t('fingerprint.fields.cores')}
              htmlFor="fp-cores"
              error={form.formState.errors.fingerprint?.navigator?.hardwareConcurrency?.message}
            >
              <Input
                id="fp-cores"
                type="number"
                min={1}
                max={128}
                {...form.register('fingerprint.navigator.hardwareConcurrency', { valueAsNumber: true })}
              />
            </Field>
            <Field label={t('fingerprint.fields.memory')} htmlFor="fp-memory">
              <Choice
                id="fp-memory"
                label={t('fingerprint.fields.memory')}
                value={
                  config.navigator.deviceMemory === null ? 'native' : String(config.navigator.deviceMemory)
                }
                options={['native', '2', '4', '8'].map((value) => [
                  value,
                  value === 'native' ? t('fingerprintEditor.braveControlled') : `${value} GB`,
                ])}
                onChange={(value) =>
                  patch({
                    ...config,
                    navigator: {
                      ...config.navigator,
                      deviceMemory: value === 'native' ? null : Number(value),
                    },
                  })
                }
              />
            </Field>
          </div>
          <Field
            label={t('fingerprint.fields.resolution')}
            htmlFor="fp-resolution"
            error={form.formState.errors.fingerprint?.screen?.message}
            hint={t('fingerprintEditor.screenHint')}
          >
            <Choice
              id="fp-resolution"
              label={t('fingerprint.fields.resolution')}
              value={screenKey(config.screen)}
              options={[
                [
                  screenKey(config.screen),
                  `${config.screen.width} × ${config.screen.height} · ${config.screen.pixelRatio}×`,
                ],
                ...SCREEN_PRESETS[config.os as DesktopOs]
                  .filter((value) => !sameScreen(value, config.screen))
                  .map(
                    (value) =>
                      [screenKey(value), `${value.width} × ${value.height} · ${value.pixelRatio}×`] as const,
                  ),
              ]}
              onChange={(value) => {
                const screen = SCREEN_PRESETS[config.os as DesktopOs].find(
                  (screen) => screenKey(screen) === value,
                )
                if (screen) patch({ ...config, screen: { ...screen } })
              }}
            />
          </Field>
          <p className="text-xs break-all text-muted-foreground">
            {config.userAgent}
            <br />
            {config.uaData.brands.map((brand) => `${brand.brand}/${brand.version}`).join(' · ')} ·{' '}
            {config.uaData.platform} {config.uaData.platformVersion}
          </p>
        </Section>
      )}
      <Section title={t('fingerprint.sections.locale')}>
        <Field
          label={t('fingerprint.fields.timezone')}
          htmlFor="fp-timezone-mode"
          error={form.formState.errors.fingerprint?.timezone?.id?.message}
        >
          <Choice
            id="fp-timezone-mode"
            label={t('fingerprint.fields.timezone')}
            value={config.timezone.mode}
            options={modes}
            onChange={(value) =>
              patch({ ...config, timezone: { ...config.timezone, mode: value as 'auto' | 'manual' } })
            }
          />
          {config.timezone.mode === 'manual' ? (
            <Input
              aria-label={t('fingerprintEditor.timezoneValue')}
              data-testid="fp-timezone"
              placeholder="America/Sao_Paulo"
              {...form.register('fingerprint.timezone.id')}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {autoTimezone ?? t('fingerprintEditor.geoRequired')}
            </p>
          )}
        </Field>
        <Field
          label={t('fingerprint.fields.languages')}
          htmlFor="fp-languages-mode"
          error={form.formState.errors.fingerprint?.languages?.list?.[0]?.message}
          hint={t('fingerprintEditor.languagesHint')}
        >
          <Choice
            id="fp-languages-mode"
            label={t('fingerprint.fields.languages')}
            value={config.languages.mode}
            options={modes}
            onChange={(value) =>
              patch({ ...config, languages: { ...config.languages, mode: value as 'auto' | 'manual' } })
            }
          />
          {config.languages.mode === 'manual' ? (
            <Controller
              control={form.control}
              name="fingerprint.languages.list"
              render={({ field }) => (
                <Input
                  aria-label={t('fingerprintEditor.languagesValue')}
                  data-testid="fp-languages"
                  value={field.value?.join(', ') ?? ''}
                  onChange={(event) =>
                    field.onChange(event.target.value.split(',').map((value) => value.trim()))
                  }
                  onBlur={field.onBlur}
                />
              )}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {autoLanguages?.join(', ') ??
                t(proxyId ? 'fingerprintEditor.geoRequired' : 'fingerprintEditor.hostLanguages')}
            </p>
          )}
        </Field>
        <Field
          label={t('fingerprint.fields.geolocation')}
          htmlFor="fp-geolocation-mode"
          error={form.formState.errors.fingerprint?.geolocation?.message}
          hint={t('fingerprintEditor.geoHint')}
        >
          <Choice
            id="fp-geolocation-mode"
            label={t('fingerprint.fields.geolocation')}
            value={config.geolocation.mode}
            options={(['auto', 'manual', 'block', 'prompt'] as const).map((value) => [
              value,
              t(`fingerprint.modes.${value}`),
            ])}
            onChange={(value) =>
              patch({
                ...config,
                geolocation: {
                  ...config.geolocation,
                  mode: value as FingerprintConfig['geolocation']['mode'],
                },
              })
            }
          />
        </Field>
        {config.geolocation.mode === 'manual' && (
          <div className="grid grid-cols-3 gap-3">
            {(['latitude', 'longitude', 'accuracy'] as const).map((key) => (
              <Field
                key={key}
                label={t(`fingerprintEditor.${key}`)}
                htmlFor={`fp-${key}`}
                error={form.formState.errors.fingerprint?.geolocation?.[key]?.message}
              >
                <Input
                  id={`fp-${key}`}
                  type="number"
                  step="any"
                  {...form.register(`fingerprint.geolocation.${key}`, {
                    setValueAs: (value) => (value === '' ? null : Number(value)),
                  })}
                />
              </Field>
            ))}
          </div>
        )}
        {config.geolocation.mode === 'auto' && (
          <p className="text-xs text-muted-foreground">
            {proxy?.latitude != null && proxy.longitude != null
              ? `${proxy.latitude}, ${proxy.longitude}`
              : t('fingerprintEditor.geoBlocked')}
          </p>
        )}
      </Section>
      <Section title={t('fingerprint.sections.webrtc')}>
        <Choice
          id="fp-webrtc"
          label="WebRTC"
          value={config.webrtc.mode}
          options={(['proxy_only', 'disabled', 'real'] as const).map((value) => [
            value,
            t(`fingerprint.webrtc.${value}`),
          ])}
          onChange={(value) =>
            patch({ ...config, webrtc: { mode: value as FingerprintConfig['webrtc']['mode'] } })
          }
        />
        <p className="text-xs text-muted-foreground">{t('fingerprintEditor.webrtcHint')}</p>
      </Section>
      <Section title={t('fingerprint.sections.noise')}>
        <Choice
          id="fp-farbling"
          label={t('fingerprint.sections.noise')}
          value={nativeNoise ? config.noise.canvas : 'off'}
          disabled={!nativeNoise}
          options={(['brave', 'off'] as const).map((value) => [value, t(`fingerprint.noise.${value}`)])}
          onChange={(value) => {
            const mode = value as 'brave' | 'off'
            patch({ ...config, noise: { canvas: mode, webgl: mode, audio: mode } })
          }}
        />
        <p className="text-xs text-muted-foreground" data-testid="fp-noise-hint">
          {nativeNoise
            ? t(
                browserKind === 'brave'
                  ? 'fingerprintEditor.farblingHint'
                  : 'fingerprintEditor.ungoogledNoiseHint',
              )
            : t('fingerprintEditor.noNativeNoise', { browser: BROWSER_NAMES[browserKind] })}
        </p>
      </Section>
      <FingerprintSession profile={profile} config={config} />
    </div>
  )
}
