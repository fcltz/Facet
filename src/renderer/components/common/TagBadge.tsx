import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Tag } from '@shared/schemas/group-tag'
import { cn, withAlpha } from '@renderer/lib/utils'

export function TagBadge({
  tag,
  onRemove,
  className,
}: {
  tag: Pick<Tag, 'name' | 'color'>
  onRemove?: () => void
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex h-5 max-w-[150px] items-center gap-1.5 rounded-md border px-1.5 text-xs font-medium text-foreground/90',
        className,
      )}
      style={{ backgroundColor: withAlpha(tag.color, 0.1), borderColor: withAlpha(tag.color, 0.28) }}
    >
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
      <span className="truncate">{tag.name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('tagPicker.remove', { name: tag.name })}
          className="-mr-0.5 rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  )
}
