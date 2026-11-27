import { hasFlag } from 'country-flag-icons'
import * as Flags from 'country-flag-icons/react/3x2'
import { Globe } from 'lucide-react'
import type { ComponentType, SVGAttributes } from 'react'
import { cn } from '@renderer/lib/utils'

type FlagComponent = ComponentType<SVGAttributes<SVGElement> & { title?: string }>
const FLAGS = Flags as unknown as Record<string, FlagComponent | undefined>

/**
 * Bandeira em SVG. Emoji de bandeira não é renderizado no Windows (aparece
 * "BR"), por isso as bandeiras vêm do pacote country-flag-icons.
 */
export function CountryFlag({
  code,
  title,
  className,
}: {
  code: string | null | undefined
  title?: string
  className?: string
}) {
  const upper = code?.toUpperCase()
  const Flag = upper && hasFlag(upper) ? FLAGS[upper] : undefined
  if (!Flag) {
    return <Globe aria-hidden className={cn('size-3.5 shrink-0 text-muted-foreground', className)} />
  }
  return (
    <Flag
      title={title}
      aria-hidden={title ? undefined : true}
      className={cn('h-3.5 w-[21px] shrink-0 rounded-[3px] shadow-[0_0_0_1px_rgb(0_0_0/0.08)]', className)}
    />
  )
}
