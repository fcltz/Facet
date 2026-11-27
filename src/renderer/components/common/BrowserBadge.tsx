import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { BROWSER_KINDS, BROWSER_NAMES, type BrowserKind } from '@shared/constants'
import type { BrowserInfo } from '@shared/schemas/browser'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@renderer/components/ui/select'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings.store'

/** Marca simples nas cores de cada navegador (não é o logotipo). */
const MARKS: Record<BrowserKind, CSSProperties> = {
  ungoogled: {
    background:
      'radial-gradient(circle, #e2e8f0 0 28%, transparent 30%), conic-gradient(from 20deg, #1e3a8a, #3b82f6, #93c5fd, #1e3a8a)',
  },
  chrome: {
    background:
      'radial-gradient(circle, #4285f4 0 27%, #ffffff 29% 37%, transparent 39%), conic-gradient(from -60deg, #ea4335 0 120deg, #34a853 0 240deg, #fbbc05 0)',
  },
  brave: { background: 'linear-gradient(160deg, #ff7a45, #fb542b 55%, #d93c12)' },
  opera: { background: 'radial-gradient(ellipse 34% 46% at center, transparent 92%, #ff1b2d 100%)' },
}

export function BrowserMark({ kind, className }: { kind: BrowserKind; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block size-3.5 shrink-0 rounded-full', className)}
      style={MARKS[kind]}
    />
  )
}

export function BrowserBadge({ kind, className }: { kind: BrowserKind; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5 text-sm', className)}>
      <BrowserMark kind={kind} />
      <span className="truncate">{BROWSER_NAMES[kind]}</span>
    </span>
  )
}

/** "158.0.8127.36" a partir de "Chrome/158.0.8127.36". */
export function browserVersion(info: Pick<BrowserInfo, 'product'> | null | undefined): string | null {
  return /\/([\d.]+)/.exec(info?.product ?? '')?.[1] ?? null
}

/**
 * Seletor de navegador: os instalados primeiro na escolha, com a versão; os que não estão nesta
 * máquina aparecem desabilitados (menos o valor atual, para não sumir da tela).
 */
export function BrowserSelect({
  value,
  onChange,
  id,
  className,
  testId,
}: {
  value: BrowserKind
  onChange: (kind: BrowserKind) => void
  id?: string
  className?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const browsers = useSettingsStore((s) => s.browsers)
  const defaultBrowser = useSettingsStore((s) => s.settings.defaultBrowser)
  return (
    <Select value={value} onValueChange={(next) => onChange(next as BrowserKind)}>
      <SelectTrigger id={id} className={cn('w-full', className)} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {BROWSER_KINDS.map((kind) => {
          const info = browsers.find((browser) => browser.kind === kind)
          const version = browserVersion(info)
          const available = (info?.available ?? false) && !info?.checking
          return (
            <SelectItem
              key={kind}
              value={kind}
              disabled={!available && kind !== value}
              data-testid={testId ? `${testId}-${kind}` : undefined}
            >
              <BrowserMark kind={kind} />
              <span>{BROWSER_NAMES[kind]}</span>
              <span className="ml-auto pl-3 text-xs text-muted-foreground">
                {available
                  ? [version, kind === defaultBrowser ? t('browsers.default') : null]
                      .filter(Boolean)
                      .join(' · ')
                  : !info || info.checking
                    ? t('browsers.checking')
                    : t('browsers.notInstalled')}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
