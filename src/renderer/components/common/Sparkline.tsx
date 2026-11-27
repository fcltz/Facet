import { cn } from '@renderer/lib/utils'

/**
 * Mini gráfico de linha (sem eixos), na cor do texto. A escala mínima evita que oscilações de
 * poucos bytes pareçam picos quando a conexão está parada.
 */
export function Sparkline({
  values,
  minScale = 1024,
  points = 60,
  className,
  label,
}: {
  values: readonly number[]
  minScale?: number
  points?: number
  className?: string
  label?: string
}) {
  const width = 100
  const height = 24
  const padded = [...Array<number>(Math.max(0, points - values.length)).fill(0), ...values.slice(-points)]
  const max = Math.max(minScale, ...padded)
  const step = width / Math.max(1, padded.length - 1)
  const coordinates = padded.map((value, index) => {
    const x = index * step
    const y = height - 1 - (Math.max(0, value) / max) * (height - 2)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const line = coordinates.join(' ')
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('overflow-visible', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <polygon points={`0,${height} ${line} ${width},${height}`} fill="currentColor" opacity={0.14} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
