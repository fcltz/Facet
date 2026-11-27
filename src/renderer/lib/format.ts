import { useSyncExternalStore } from 'react'
import type { Language } from '@shared/schemas/settings'
import { currentLanguage, tr } from '@renderer/i18n'
import { bytesText, rateText } from './bytes'

/* Relógio compartilhado: um único timer atualiza todas as datas relativas da tela. */
const clockListeners = new Set<() => void>()
let clockNow = Date.now()
let clockTimer: ReturnType<typeof setInterval> | null = null

function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener)
  if (!clockTimer) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      for (const notify of clockListeners) notify()
    }, 30_000)
  }
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

/** Horário atual, atualizado a cada 30 s (para "há 3 minutos" não ficar parado). */
export function useNow(): number {
  return useSyncExternalStore(subscribeClock, () => clockNow)
}

const SECOND = 1
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', YEAR],
  ['month', MONTH],
  ['week', WEEK],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
  ['second', SECOND],
]

const relativeCache = new Map<Language, Intl.RelativeTimeFormat>()
const dateTimeCache = new Map<Language, Intl.DateTimeFormat>()
const numberCache = new Map<Language, Intl.NumberFormat>()
const regionCache = new Map<Language, Intl.DisplayNames>()

function cached<T>(cache: Map<Language, T>, language: Language, create: () => T): T {
  let value = cache.get(language)
  if (!value) {
    value = create()
    cache.set(language, value)
  }
  return value
}

/** "há 3 dias", "em 2 horas", "agora mesmo". */
export function formatRelative(timestamp: number, now = Date.now(), language = currentLanguage()): string {
  const diff = Math.round((timestamp - now) / 1000)
  const abs = Math.abs(diff)
  if (abs < 45) return tr('time.justNow')
  const formatter = cached(
    relativeCache,
    language,
    () => new Intl.RelativeTimeFormat(language, { numeric: 'auto' }),
  )
  for (const [unit, seconds] of UNITS) {
    if (abs >= seconds || unit === 'second') return formatter.format(Math.round(diff / seconds), unit)
  }
  return formatter.format(diff, 'second')
}

export function formatDateTime(timestamp: number, language = currentLanguage()): string {
  const formatter = cached(
    dateTimeCache,
    language,
    () => new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }),
  )
  return formatter.format(timestamp)
}

export function formatNumber(value: number, language = currentLanguage()): string {
  return cached(numberCache, language, () => new Intl.NumberFormat(language)).format(value)
}

/** Bytes em base 1024 ("382,6 KB") no idioma da interface. */
export function formatBytes(bytes: number, language = currentLanguage()): string {
  return bytesText(bytes, language)
}

/** Taxa de transferência ("382,6 KB/s") no idioma da interface. */
export function formatRate(bytesPerSecond: number, language = currentLanguage()): string {
  return rateText(bytesPerSecond, language)
}

/** Nome do país no idioma da interface ("BR" → "Brasil" / "Brazil"). */
export function countryName(code: string | null | undefined, language = currentLanguage()): string | null {
  if (!code) return null
  try {
    return (
      cached(regionCache, language, () => new Intl.DisplayNames([language], { type: 'region' })).of(code) ??
      code
    )
  } catch {
    return code
  }
}

/** Ordenação "natural": "Perfil 2" antes de "Perfil 10". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b)
}
