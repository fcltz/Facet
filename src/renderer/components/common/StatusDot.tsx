import { useTranslation } from 'react-i18next'
import type { RuntimeStatus } from '@shared/schemas/profile'
import { cn } from '@renderer/lib/utils'

const DOT: Record<RuntimeStatus, string> = {
  stopped: 'bg-muted-foreground/40',
  starting: 'bg-warning animate-status-pulse',
  running: 'bg-success ring-[3px] ring-success/20',
  stopping: 'bg-warning animate-status-pulse',
  disconnected: 'bg-destructive animate-status-pulse',
  error: 'bg-destructive ring-[3px] ring-destructive/20',
}

export function StatusDot({ status, className }: { status: RuntimeStatus; className?: string }) {
  return (
    <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[status], className)} />
  )
}

export function StatusLabel({ status, className }: { status: RuntimeStatus; className?: string }) {
  const { t } = useTranslation()
  return (
    <span className={cn('inline-flex items-center gap-2 text-sm', className)} data-status={status}>
      <StatusDot status={status} />
      <span
        className={cn(
          status === 'running' && 'font-medium text-foreground',
          status === 'stopped' && 'text-muted-foreground',
          (status === 'starting' || status === 'stopping') && 'text-foreground/80',
          status === 'error' && 'font-medium text-destructive',
        )}
      >
        {t(`status.${status}`)}
      </span>
    </span>
  )
}
