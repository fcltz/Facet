import { Apple, AppWindow, Smartphone, Terminal, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { OS_LIST } from '@shared/constants'
import type { OsName } from '@shared/schemas/common'
import { cn } from '@renderer/lib/utils'

const ICONS: Record<OsName, LucideIcon> = {
  windows: AppWindow,
  macos: Apple,
  linux: Terminal,
  android: Smartphone,
  ios: Smartphone,
}

/** Sistema desta máquina: padrão para perfis novos (fingerprint mais difícil de detectar). */
export function hostOs(): OsName {
  const platform = window.api.platform
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  return 'linux'
}

export function OsIcon({ os, className }: { os: OsName; className?: string }) {
  const Icon = ICONS[os]
  return <Icon aria-hidden className={cn('size-3.5 shrink-0', className)} />
}

export function OsBadge({ os, className }: { os: OsName; className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm', className)}>
      <OsIcon os={os} className="text-muted-foreground" />
      {t(`os.${os}`)}
    </span>
  )
}

/** Seletor segmentado Windows | macOS | Linux | Android | iOS. */
export function OsSegmented({
  value,
  onChange,
  id,
}: {
  value: OsName
  onChange: (os: OsName) => void
  id?: string
}) {
  const { t } = useTranslation()
  return (
    <div id={id} role="radiogroup" className="grid grid-cols-5 gap-1 rounded-lg border bg-muted/50 p-1">
      {OS_LIST.map((os) => {
        const selected = value === os
        return (
          <button
            key={os}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`os-${os}`}
            onClick={() => onChange(os)}
            className={cn(
              'flex h-8 items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors',
              selected
                ? 'bg-card text-foreground shadow-soft'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <OsIcon os={os} className={selected ? 'text-primary' : undefined} />
            {t(`os.${os}`)}
            {os === hostOs() && <span className="size-1.5 rounded-full bg-success" aria-hidden />}
          </button>
        )
      })}
    </div>
  )
}
