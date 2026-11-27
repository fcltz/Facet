import { Ban, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { COLOR_PALETTE } from '@shared/constants'
import { cn } from '@renderer/lib/utils'

interface ColorPickerProps {
  value: string | null
  onChange: (color: string | null) => void
  /** Mostra a opção "sem cor" (perfis); grupos e tags sempre têm cor. */
  allowNone?: boolean
  className?: string
  id?: string
}

export function ColorPicker({ value, onChange, allowNone = false, className, id }: ColorPickerProps) {
  const { t } = useTranslation()
  return (
    <div id={id} role="radiogroup" className={cn('flex flex-wrap items-center gap-2', className)}>
      {allowNone && (
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          aria-label={t('general.noColor')}
          title={t('general.noColor')}
          onClick={() => onChange(null)}
          className={cn(
            'flex size-7 items-center justify-center rounded-full border border-dashed text-muted-foreground transition',
            value === null
              ? 'border-primary text-primary ring-2 ring-primary/25'
              : 'hover:border-foreground/40',
          )}
        >
          <Ban className="size-3.5" />
        </button>
      )}
      {COLOR_PALETTE.map((color) => {
        const selected = value?.toLowerCase() === color.toLowerCase()
        return (
          <button
            key={color}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={color}
            title={color}
            onClick={() => onChange(color)}
            className={cn(
              'flex size-7 items-center justify-center rounded-full transition hover:scale-105',
              selected && 'ring-2 ring-offset-2 ring-offset-background',
            )}
            style={{ backgroundColor: color, ...(selected ? { ['--tw-ring-color' as string]: color } : {}) }}
          >
            {selected && <Check className="size-3.5 text-white" strokeWidth={3} />}
          </button>
        )
      })}
    </div>
  )
}
