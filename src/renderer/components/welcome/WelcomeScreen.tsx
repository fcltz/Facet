import i18next from 'i18next'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  LoaderCircle,
  Moon,
  RefreshCw,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { BROWSER_KINDS, BROWSER_NAMES, LANGUAGES, type BrowserKind } from '@shared/constants'
import type { BrowserInfo } from '@shared/schemas/browser'
import type { Language } from '@shared/schemas/settings'
import { BrowserMark, browserVersion } from '@renderer/components/common/BrowserBadge'
import { FacetLogo } from '@renderer/components/layout/Sidebar'
import { Button } from '@renderer/components/ui/button'
import type { EffectiveTheme } from '@renderer/hooks/use-theme'
import { invoke, toastError } from '@renderer/lib/ipc'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings.store'

const STEPS = ['language', 'theme', 'browser'] as const
const THEME_CHOICES: { value: EffectiveTheme; icon: LucideIcon }[] = [
  { value: 'dark', icon: Moon },
  { value: 'light', icon: Sun },
]
const LANGUAGE_CODES: Record<Language, string> = { 'pt-BR': 'PT', en: 'EN', es: 'ES' }

/** Cores fixas dos dois temas (globals.css): a prévia mostra o outro tema, não o atual. */
const PREVIEW_COLORS: Record<
  EffectiveTheme,
  Record<'bg' | 'side' | 'card' | 'line' | 'text' | 'muted' | 'accent', string>
> = {
  light: {
    bg: '#F7F8FB',
    side: '#FFFFFF',
    card: '#FFFFFF',
    line: '#E6E8F0',
    text: '#0F1222',
    muted: '#DADDE8',
    accent: '#5B5BF7',
  },
  dark: {
    bg: '#0B0D14',
    side: '#0F121B',
    card: '#12151F',
    line: '#232838',
    text: '#E8EAF2',
    muted: '#2A3043',
    accent: '#6D6DF9',
  },
}

function ThemePreview({ theme }: { theme: EffectiveTheme }) {
  const c = PREVIEW_COLORS[theme]
  return (
    <div
      aria-hidden
      className="flex h-32 w-full overflow-hidden rounded-lg border"
      style={{ background: c.bg, borderColor: c.line }}
    >
      <div
        className="flex w-1/4 flex-col gap-2 border-r p-2.5"
        style={{ background: c.side, borderColor: c.line }}
      >
        <span className="size-3.5 rounded" style={{ background: c.accent }} />
        {[0, 1, 2, 3].map((row) => (
          <span
            key={row}
            className="h-1.5 rounded-full"
            style={{ background: row === 0 ? c.accent : c.muted, opacity: row === 0 ? 0.55 : 1 }}
          />
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="h-2 w-2/5 rounded-full" style={{ background: c.text, opacity: 0.75 }} />
          <span className="h-3.5 w-10 rounded" style={{ background: c.accent }} />
        </div>
        <div
          className="flex flex-1 flex-col justify-around rounded-md border px-2"
          style={{ background: c.card, borderColor: c.line }}
        >
          {['#12B76A', '#F5A524', '#12B76A'].map((dot, row) => (
            <div key={row} className="flex items-center gap-2">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot }} />
              <span className="h-1.5 flex-1 rounded-full" style={{ background: c.muted }} />
              <span className="h-1.5 w-5 rounded-full" style={{ background: c.muted }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Cartão de escolha (rádio): borda e marca de seleção no estilo das Configurações. */
function Choice({
  selected,
  disabled,
  onSelect,
  testId,
  className,
  children,
}: {
  selected: boolean
  disabled?: boolean
  onSelect: () => void
  testId: string
  className?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      data-testid={testId}
      className={cn(
        'relative rounded-xl border bg-card p-4 text-left text-sm transition outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60',
        selected ? 'border-primary ring-2 ring-primary/20' : 'enabled:hover:bg-accent',
        className,
      )}
    >
      {selected && (
        <span className="absolute top-3 right-3 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check className="size-3.5" />
        </span>
      )}
      {children}
    </button>
  )
}

function LanguageStep() {
  const { t } = useTranslation()
  const language = useSettingsStore((s) => s.settings.language)
  const update = useSettingsStore((s) => s.update)
  return (
    <div role="radiogroup" aria-label={t('welcome.languageTitle')} className="grid gap-3 sm:grid-cols-3">
      {LANGUAGES.map((option) => (
        <Choice
          key={option}
          selected={language === option}
          onSelect={() => {
            if (language !== option) void update({ language: option })
          }}
          testId={`welcome-language-${option}`}
          className="flex flex-col gap-3"
        >
          <span className="flex size-10 items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
            {LANGUAGE_CODES[option]}
          </span>
          <span className="grid gap-0.5">
            <span className="font-semibold" lang={option}>
              {t(`settings.languages.${option}`)}
            </span>
            {/* cada idioma cumprimenta no próprio idioma */}
            <span className="text-xs text-muted-foreground" lang={option}>
              {i18next.getFixedT(option)('welcome.greeting')}
            </span>
          </span>
        </Choice>
      ))}
    </div>
  )
}

function ThemeStep({ selected }: { selected: EffectiveTheme }) {
  const { t } = useTranslation()
  const update = useSettingsStore((s) => s.update)
  return (
    <div role="radiogroup" aria-label={t('welcome.themeTitle')} className="grid gap-3 sm:grid-cols-2">
      {THEME_CHOICES.map(({ value, icon: Icon }) => (
        <Choice
          key={value}
          selected={selected === value}
          onSelect={() => void update({ theme: value })}
          testId={`welcome-theme-${value}`}
          className="grid gap-3"
        >
          <ThemePreview theme={value} />
          <span className="flex items-center gap-2 font-semibold">
            <Icon className="size-4" />
            {t(`settings.themes.${value}`)}
          </span>
        </Choice>
      ))}
    </div>
  )
}

/** Navegador escolhido: o marcado (se existir aqui), o padrão atual ou o primeiro disponível. */
export function welcomeBrowser(
  picked: BrowserKind | null,
  fallback: BrowserKind,
  browsers: readonly BrowserInfo[],
): BrowserKind {
  const available = (kind: BrowserKind): boolean =>
    browsers.find((info) => info.kind === kind)?.available ?? false
  if (picked && available(picked)) return picked
  if (available(fallback)) return fallback
  return BROWSER_KINDS.find(available) ?? picked ?? fallback
}

function BrowserStep({
  selected,
  onSelect,
}: {
  selected: BrowserKind
  onSelect: (kind: BrowserKind) => void
}) {
  const { t } = useTranslation()
  const browsers = useSettingsStore((s) => s.browsers)
  const setBrowser = useSettingsStore((s) => s.setBrowser)
  const [detecting, setDetecting] = useState(false)
  const infos = BROWSER_KINDS.map((kind) => browsers.find((info) => info.kind === kind) ?? null)
  const searching = detecting || infos.some((info) => !info || info.checking)
  const found = infos.filter((info) => info?.available).length

  const detect = async (): Promise<void> => {
    setDetecting(true)
    try {
      const results = await Promise.allSettled(
        BROWSER_KINDS.map((kind) => invoke('browser.detect', { kind })),
      )
      for (const result of results) if (result.status === 'fulfilled') setBrowser(result.value)
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) toastError(failure.reason)
    } finally {
      setDetecting(false)
    }
  }

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="welcome-browsers-found"
        >
          {searching && <LoaderCircle className="size-4 animate-spin" />}
          {searching
            ? t('welcome.detecting')
            : found > 0
              ? t('welcome.found', { count: found })
              : t('welcome.noneFound')}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void detect()}
          disabled={detecting}
          data-testid="welcome-detect"
        >
          <RefreshCw className={cn(detecting && 'animate-spin')} />
          {t('welcome.detect')}
        </Button>
      </div>
      <div role="radiogroup" aria-label={t('welcome.browserTitle')} className="grid gap-3 sm:grid-cols-2">
        {BROWSER_KINDS.map((kind, index) => {
          const info = infos[index]
          const checking = !info || info.checking
          const version = browserVersion(info)
          return (
            <Choice
              key={kind}
              selected={selected === kind}
              // ainda procurando ou não instalado: não dá para escolher (a não ser o já marcado)
              disabled={!info?.available && selected !== kind}
              onSelect={() => onSelect(kind)}
              testId={`welcome-browser-${kind}`}
              className="flex items-center gap-3"
            >
              <BrowserMark kind={kind} className="size-8" />
              <span className="grid min-w-0 gap-0.5 pr-6">
                <span className="truncate font-semibold">{BROWSER_NAMES[kind]}</span>
                <span
                  className={cn(
                    'flex items-center gap-1.5 text-xs',
                    info?.available && !checking ? 'text-success' : 'text-muted-foreground',
                  )}
                  data-testid={`welcome-browser-${kind}-status`}
                >
                  {checking && <LoaderCircle className="size-3 animate-spin" />}
                  {checking
                    ? t('browsers.checking')
                    : info.available
                      ? [
                          version,
                          info.source === 'bundled'
                            ? t('welcome.bundled')
                            : t(`browsers.source.${info.source ?? 'detected'}`),
                        ]
                          .filter(Boolean)
                          .join(' · ')
                      : t('browsers.notInstalled')}
                </span>
              </span>
            </Choice>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Primeira abertura do Facet neste computador: idioma, tema e navegador padrão. Cada escolha vale
 * na hora; o fim grava o navegador e marca as boas-vindas como concluídas.
 */
export function WelcomeScreen({ theme }: { theme: EffectiveTheme }) {
  const { t } = useTranslation()
  const settings = useSettingsStore((s) => s.settings)
  const browsers = useSettingsStore((s) => s.browsers)
  const update = useSettingsStore((s) => s.update)
  const [step, setStep] = useState(0)
  const [picked, setPicked] = useState<BrowserKind | null>(null)
  const [finishing, setFinishing] = useState(false)
  const current = STEPS[step] ?? 'language'
  const last = step === STEPS.length - 1
  // "Sistema" (o padrão) aparece como o tema que está valendo agora
  const chosenTheme: EffectiveTheme = settings.theme === 'system' ? theme : settings.theme
  const browser = welcomeBrowser(picked, settings.defaultBrowser, browsers)

  const finish = async (): Promise<void> => {
    setFinishing(true)
    try {
      await update({ theme: chosenTheme, defaultBrowser: browser, onboardingCompleted: true })
    } finally {
      setFinishing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex overflow-y-auto bg-background" data-testid="welcome">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 h-72 bg-gradient-to-b from-primary/10 to-transparent"
      />
      <main
        aria-labelledby="welcome-title"
        className="relative m-auto grid w-full max-w-3xl gap-6 px-6 py-10"
        data-step={current}
      >
        <header className="grid justify-items-center gap-3 text-center">
          <FacetLogo className="size-12" />
          <h1 id="welcome-title" className="text-2xl font-semibold tracking-tight">
            {t('welcome.title')}
          </h1>
          <p className="max-w-md text-sm text-muted-foreground">{t('welcome.subtitle')}</p>
        </header>

        <ol
          className="flex items-center justify-center gap-2"
          aria-label={t('welcome.step', { current: step + 1, total: STEPS.length })}
        >
          {STEPS.map((name, index) => (
            <li key={name} className="flex items-center gap-2">
              {index > 0 && (
                <span aria-hidden className={cn('h-px w-8', index <= step ? 'bg-primary' : 'bg-border')} />
              )}
              <button
                type="button"
                disabled={index >= step}
                onClick={() => setStep(index)}
                aria-current={index === step ? 'step' : undefined}
                data-testid={`welcome-step-${name}`}
                className={cn(
                  'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition disabled:cursor-default',
                  index === step && 'border-primary bg-primary/10 text-primary',
                  index < step && 'text-foreground enabled:hover:bg-accent',
                  index > step && 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex size-4 items-center justify-center rounded-full text-[10px]',
                    index <= step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
                  )}
                >
                  {index < step ? <Check className="size-3" /> : index + 1}
                </span>
                {t(`welcome.steps.${name}`)}
              </button>
            </li>
          ))}
        </ol>

        <section
          key={current}
          className="grid gap-4 rounded-2xl border bg-card/60 p-6 shadow-soft animate-in fade-in slide-in-from-bottom-1"
        >
          <div className="grid gap-1">
            <p className="text-xs font-medium tracking-wide text-primary uppercase">
              {t('welcome.step', { current: step + 1, total: STEPS.length })}
            </p>
            <h2 className="text-lg font-semibold">{t(`welcome.${current}Title`)}</h2>
            <p className="text-sm text-muted-foreground">{t(`welcome.${current}Hint`)}</p>
          </div>
          {current === 'language' && <LanguageStep />}
          {current === 'theme' && <ThemeStep selected={chosenTheme} />}
          {current === 'browser' && <BrowserStep selected={browser} onSelect={setPicked} />}
        </section>

        <footer className="flex items-center justify-between gap-3">
          <Button
            variant="ghost"
            onClick={() => setStep(step - 1)}
            className={cn(step === 0 && 'invisible')}
            disabled={step === 0 || finishing}
            data-testid="welcome-back"
          >
            <ArrowLeft />
            {t('welcome.back')}
          </Button>
          <p className="hidden text-center text-xs text-muted-foreground sm:block">
            {t('welcome.changeLater')}
          </p>
          {last ? (
            <Button size="lg" onClick={() => void finish()} disabled={finishing} data-testid="welcome-finish">
              {finishing ? <LoaderCircle className="animate-spin" /> : <Check />}
              {t('welcome.finish')}
            </Button>
          ) : (
            <Button size="lg" onClick={() => setStep(step + 1)} data-testid="welcome-next">
              {t('welcome.next')}
              <ArrowRight />
            </Button>
          )}
        </footer>
      </main>
    </div>
  )
}
