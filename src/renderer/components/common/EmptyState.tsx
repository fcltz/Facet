import { Cookie, Globe, Puzzle, SearchX, Trash2, Users, type LucideIcon } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@renderer/lib/utils'

export type EmptyStateVariant = 'profiles' | 'search' | 'trash' | 'proxies' | 'extensions' | 'cookies'

const ICONS: Record<EmptyStateVariant, LucideIcon> = {
  profiles: Users,
  search: SearchX,
  trash: Trash2,
  proxies: Globe,
  extensions: Puzzle,
  cookies: Cookie,
}

function Illustration({ variant }: { variant: EmptyStateVariant }) {
  const gradientId = useId()
  const Icon = ICONS[variant]
  return (
    <div className="relative mx-auto h-32 w-44">
      <svg viewBox="0 0 176 128" className="absolute inset-0 size-full" aria-hidden>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style={{ stopColor: 'var(--primary)', stopOpacity: 0.2 }} />
            <stop offset="1" style={{ stopColor: 'var(--primary)', stopOpacity: 0.03 }} />
          </linearGradient>
        </defs>
        <ellipse cx="88" cy="66" rx="72" ry="52" fill={`url(#${gradientId})`} />
        <rect x="14" y="22" width="48" height="30" rx="8" className="fill-card stroke-border" />
        <rect x="22" y="31" width="24" height="4" rx="2" className="fill-muted-foreground/35" />
        <rect x="22" y="39" width="32" height="4" rx="2" className="fill-muted-foreground/20" />
        <rect x="114" y="72" width="50" height="30" rx="8" className="fill-card stroke-border" />
        <circle cx="125" cy="87" r="5" className="fill-primary/50" />
        <rect x="134" y="81" width="22" height="4" rx="2" className="fill-muted-foreground/35" />
        <rect x="134" y="89" width="15" height="4" rx="2" className="fill-muted-foreground/20" />
        <circle cx="152" cy="28" r="4" className="fill-primary/35" />
        <circle cx="28" cy="98" r="3" className="fill-primary/30" />
        <circle cx="44" cy="112" r="2" className="fill-primary/20" />
      </svg>
      <div className="absolute top-1/2 left-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border bg-card shadow-float">
        <Icon className="size-7 text-primary" strokeWidth={1.75} />
      </div>
    </div>
  )
}

export function StageBadge({ stage, className }: { stage: number; className?: string }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary',
        className,
      )}
    >
      {t('common.stageBadge', { stage })}
    </span>
  )
}

interface EmptyStateProps {
  variant: EmptyStateVariant
  title: string
  description?: string
  action?: ReactNode
  stage?: number
  compact?: boolean
  className?: string
}

export function EmptyState({
  variant,
  title,
  description,
  action,
  stage,
  compact,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-3 py-8' : 'h-full gap-4 px-6 py-16',
        className,
      )}
      data-testid={`empty-${variant}`}
    >
      {!compact && <Illustration variant={variant} />}
      <div className="max-w-md space-y-2">
        {stage !== undefined && <StageBadge stage={stage} />}
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description && <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  )
}
