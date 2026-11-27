const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
const formatters = new Map<string, Intl.NumberFormat>()

/** Bytes em base 1024 ("382,6 KB"); uma casa decimal abaixo de 100 na unidade. */
export function bytesText(bytes: number, language: string): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  const key = `${language}:${digits}`
  let formatter = formatters.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(language, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
    formatters.set(key, formatter)
  }
  return `${formatter.format(value)} ${UNITS[unit]}`
}

/** Taxa de transferência ("382,6 KB/s"). */
export function rateText(bytesPerSecond: number, language: string): string {
  return `${bytesText(bytesPerSecond, language)}/s`
}
