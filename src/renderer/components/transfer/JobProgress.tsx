import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { tr } from '@renderer/i18n'
import { toastError } from '@renderer/lib/ipc'
import { useJobsStore } from '@renderer/stores/jobs.store'

export function JobProgress() {
  const { t } = useTranslation()
  const job = useJobsStore((s) => s.current)
  const cancelling = useJobsStore((s) => s.cancelling)
  if (!job) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="grid gap-2 rounded-lg border bg-muted/40 p-3"
      data-testid="job-progress"
    >
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="flex items-center gap-2">
          <LoaderCircle className="size-4 animate-spin" />
          {tr(`jobs.phases.${job.phase}`, job.phase)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={cancelling}
          onClick={() => void useJobsStore.getState().cancel().catch(toastError)}
        >
          {t(cancelling ? 'jobs.cancelling' : 'common.cancel')}
        </Button>
      </div>
      {job.label && <p className="truncate text-xs text-muted-foreground">{job.label}</p>}
      {job.total > 0 && (
        <>
          <progress
            className="h-2 w-full accent-primary"
            max={job.total}
            value={job.done}
            aria-label={t('jobs.progress')}
          />
          <span className="text-xs tabular-nums">
            {job.done} / {job.total}
          </span>
        </>
      )}
    </div>
  )
}
