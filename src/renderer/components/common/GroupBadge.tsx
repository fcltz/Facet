import type { Group } from '@shared/schemas/group-tag'
import { cn } from '@renderer/lib/utils'

export function GroupDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('size-2.5 shrink-0 rounded-[4px]', className)}
      style={{ backgroundColor: color }}
    />
  )
}

export function GroupBadge({
  group,
  className,
}: {
  group: Pick<Group, 'name' | 'color'>
  className?: string
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-2 text-sm', className)}>
      <GroupDot color={group.color} />
      <span className="truncate">{group.name}</span>
    </span>
  )
}
