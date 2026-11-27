import type { GeoIpProvider } from '@shared/schemas/settings'
import type { ProxyGeo } from '@shared/schemas/proxy'

export type GeoProviderId = Exclude<GeoIpProvider, 'auto'>

export interface GeoResult extends ProxyGeo {
  ip: string | null
}

export interface GeoProvider {
  id: GeoProviderId
  url(token: string | null): string
  /** Lança Error quando o provedor responde com falha. */
  parse(body: unknown): GeoResult
}

type Json = Record<string, unknown>

function object(value: unknown): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Resposta não é um objeto JSON')
  return value as Json
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return null
}

function countryCode(value: unknown): string | null {
  const code = text(value)?.toUpperCase()
  return code && /^[A-Z]{2}$/.test(code) ? code : null
}

function timezone(value: unknown): string | null {
  const id = text(value)
  if (!id) return null
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: id })
    return id
  } catch {
    return null
  }
}

function coordinate(value: unknown, limit: number): number | null {
  const n = number(value)
  return n !== null && Math.abs(n) <= limit ? n : null
}

const englishRegions = new Intl.DisplayNames(['en'], { type: 'region' })

function countryName(name: unknown, code: string | null): string | null {
  const given = text(name)
  if (given) return given
  try {
    return code ? (englishRegions.of(code) ?? null) : null
  } catch {
    return null
  }
}

export function normalizeGeo(raw: {
  ip: unknown
  countryCode: unknown
  countryName?: unknown
  region?: unknown
  city?: unknown
  timezone?: unknown
  latitude?: unknown
  longitude?: unknown
}): GeoResult {
  const code = countryCode(raw.countryCode)
  return {
    ip: text(raw.ip),
    countryCode: code,
    countryName: countryName(raw.countryName, code),
    region: text(raw.region),
    city: text(raw.city),
    timezone: timezone(raw.timezone),
    latitude: coordinate(raw.latitude, 90),
    longitude: coordinate(raw.longitude, 180),
  }
}

export const GEO_PROVIDERS: Record<GeoProviderId, GeoProvider> = {
  ipwhois: {
    id: 'ipwhois',
    url: () => 'https://ipwho.is/',
    parse(body) {
      const json = object(body)
      if (json.success === false) throw new Error(text(json.message) ?? 'ipwho.is recusou a consulta')
      const tz = json.timezone
      return normalizeGeo({
        ip: json.ip,
        countryCode: json.country_code,
        countryName: json.country,
        region: json.region,
        city: json.city,
        timezone: typeof tz === 'object' && tz !== null ? (tz as Json).id : tz,
        latitude: json.latitude,
        longitude: json.longitude,
      })
    },
  },
  geojs: {
    id: 'geojs',
    url: () => 'https://get.geojs.io/v1/ip/geo.json',
    parse(body) {
      const json = object(body)
      return normalizeGeo({
        ip: json.ip,
        countryCode: json.country_code,
        countryName: json.country,
        region: json.region,
        city: json.city,
        timezone: json.timezone,
        latitude: json.latitude,
        longitude: json.longitude,
      })
    },
  },
  ipinfo: {
    id: 'ipinfo',
    url: (token) =>
      token ? `https://ipinfo.io/json?token=${encodeURIComponent(token)}` : 'https://ipinfo.io/json',
    parse(body) {
      const json = object(body)
      if (json.error) throw new Error(text((json.error as Json).message) ?? 'ipinfo.io recusou a consulta')
      const [lat, lon] = (text(json.loc) ?? '').split(',')
      return normalizeGeo({
        ip: json.ip,
        countryCode: json.country,
        region: json.region,
        city: json.city,
        timezone: json.timezone,
        latitude: lat,
        longitude: lon,
      })
    },
  },
  ipapi: {
    id: 'ipapi',
    // O plano gratuito do ip-api.com só existe em HTTP (a consulta passa em claro pelo proxy).
    url: () =>
      'http://ip-api.com/json/?fields=status,message,query,country,countryCode,regionName,city,lat,lon,timezone',
    parse(body) {
      const json = object(body)
      if (json.status !== 'success') throw new Error(text(json.message) ?? 'ip-api.com recusou a consulta')
      return normalizeGeo({
        ip: json.query,
        countryCode: json.countryCode,
        countryName: json.country,
        region: json.regionName,
        city: json.city,
        timezone: json.timezone,
        latitude: json.lat,
        longitude: json.lon,
      })
    },
  },
}

/** Ordem da cadeia automática (todas sem chave; ipapi por último por ser só HTTP). */
export const AUTO_PROVIDER_ORDER: readonly GeoProviderId[] = ['ipwhois', 'geojs', 'ipinfo', 'ipapi']

/** `ip=…` e `loc=XX` do /cdn-cgi/trace da Cloudflare. */
export function parseTrace(body: string): { ip: string | null; countryCode: string | null } {
  const fields = new Map(
    body
      .split(/\r?\n/)
      .map((line) => line.split('='))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([key, value]) => [key.trim(), value.trim()] as const),
  )
  const ip = fields.get('ip') ?? null
  return { ip: ip && ip.length <= 45 ? ip : null, countryCode: countryCode(fields.get('loc')) }
}
