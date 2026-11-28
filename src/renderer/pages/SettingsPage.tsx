import { Check, Keyboard, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LANGUAGES, THEMES } from '@shared/constants'
import { BackupSettings } from '@renderer/components/settings/BackupSettings'
import { ProfilesFolderSettings } from '@renderer/components/settings/ProfilesFolderSettings'
import type { Language, Theme } from '@shared/schemas/settings'
import { StageBadge } from '@renderer/components/common/EmptyState'
import { Field } from '@renderer/components/common/Field'
import { PageHeader } from '@renderer/components/layout/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { BrowserSettings } from '@renderer/components/common/BrowserSettings'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings.store'
import { useUiStore } from '@renderer/stores/ui.store'

const THEME_ICONS: Record<Theme, LucideIcon> = { light: Sun, dark: Moon, system: Monitor }

function Section({ title, stage, children }: { title: string; stage?: number; children: ReactNode }) {
  return (
    <section className="rounded-xl border bg-card shadow-soft">
      <header className="flex items-center gap-2 border-b px-5 py-3.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {stage !== undefined && <StageBadge stage={stage} />}
      </header>
      <div className="grid gap-5 p-5">{children}</div>
    </section>
  )
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 font-mono text-[13px] break-all">{value}</span>
    </div>
  )
}

export function SettingsPage() {
  const { t } = useTranslation()
  const settings = useSettingsStore((s) => s.settings)
  const appInfo = useSettingsStore((s) => s.appInfo)
  const update = useSettingsStore((s) => s.update)
  const setShortcutsOpen = useUiStore((s) => s.setShortcutsOpen)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title={t('settings.title')} description={t('settings.subtitle')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <div className="mx-auto grid max-w-3xl gap-5">
          <Section title={t('settings.appearance')}>
            <Field label={t('settings.theme')}>
              <div role="radiogroup" className="grid grid-cols-3 gap-3">
                {THEMES.map((theme) => {
                  const Icon = THEME_ICONS[theme]
                  const selected = settings.theme === theme
                  return (
                    <button
                      key={theme}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => void update({ theme })}
                      data-testid={`theme-${theme}`}
                      className={cn(
                        'relative flex flex-col items-center gap-2 rounded-xl border p-4 text-sm font-medium transition',
                        selected
                          ? 'border-primary bg-primary/5 text-primary ring-2 ring-primary/20'
                          : 'hover:bg-accent',
                      )}
                    >
                      {selected && <Check className="absolute top-2 right-2 size-4" />}
                      <Icon className="size-5" />
                      {t(`settings.themes.${theme}`)}
                    </button>
                  )
                })}
              </div>
            </Field>
            <Field label={t('settings.language')} htmlFor="settings-language">
              <Select
                value={settings.language}
                onValueChange={(language) => void update({ language: language as Language })}
              >
                <SelectTrigger id="settings-language" className="w-64" data-testid="settings-language">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGES.map((language) => (
                    <SelectItem key={language} value={language}>
                      {t(`settings.languages.${language}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </Section>

          <Section title={t('settings.browser')}>
            <BrowserSettings />
          </Section>

          <Section title={t('settings.profilesFolder')}>
            <ProfilesFolderSettings />
          </Section>
          <Section title={t('settings.backup')}>
            <BackupSettings />
          </Section>

          <Section title={t('settings.shortcuts')}>
            <div>
              <Button variant="outline" onClick={() => setShortcutsOpen(true)}>
                <Keyboard />
                {t('settings.viewShortcuts')}
              </Button>
            </div>
          </Section>

          <Section title={t('settings.about')}>
            {appInfo && (
              <div className="grid gap-2.5">
                <InfoRow label={t('settings.version')} value={`${appInfo.name} ${appInfo.version}`} />
                <InfoRow label={t('settings.stage')} value={appInfo.stage} />
                <InfoRow label={t('settings.electron')} value={appInfo.versions.electron} />
                <InfoRow label={t('settings.chromium')} value={appInfo.versions.chrome} />
                <InfoRow label={t('settings.node')} value={appInfo.versions.node} />
                <InfoRow label={t('settings.dataFolder')} value={appInfo.userDataDir} />
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
