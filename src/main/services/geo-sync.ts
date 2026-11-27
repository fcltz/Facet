import { languagesForCountry } from '@shared/data/country-locales'
import type { FingerprintConfig } from '@shared/schemas/fingerprint'
import type { ProxyGeo } from '@shared/schemas/proxy'

export interface HostLocale {
  timezone: string
  languages: string[]
}

/** Precisão (m) declarada para a geolocalização vinda do IP: nível de cidade. */
const IP_GEO_ACCURACY = 1500

/**
 * Atualiza só os campos em modo "auto" do fingerprint:
 * - sem proxy: fuso e idiomas desta máquina, sem geolocalização;
 * - proxy com país conhecido: fuso, idiomas e lat/lon do IP do proxy;
 * - proxy sem coordenadas: apaga coordenadas automáticas anteriores.
 * A resolução da abertura exige fuso/idiomas disponíveis, ou configuração manual.
 */
export function syncFingerprint(
  fingerprint: FingerprintConfig,
  proxy: ProxyGeo | null,
  host: HostLocale,
): FingerprintConfig {
  const next = structuredClone(fingerprint)
  if (proxy === null) {
    if (next.timezone.mode === 'auto') next.timezone.id = host.timezone
    if (next.languages.mode === 'auto' && host.languages.length > 0) next.languages.list = [...host.languages]
    if (next.geolocation.mode === 'auto') {
      next.geolocation.latitude = null
      next.geolocation.longitude = null
    }
    return next
  }
  if (next.timezone.mode === 'auto' && proxy.timezone) next.timezone.id = proxy.timezone
  const languages = proxy.countryCode ? languagesForCountry(proxy.countryCode) : null
  if (next.languages.mode === 'auto' && languages) next.languages.list = languages
  if (next.geolocation.mode === 'auto') {
    next.geolocation.latitude = proxy.latitude
    next.geolocation.longitude = proxy.longitude
    next.geolocation.accuracy = IP_GEO_ACCURACY
  }
  return next
}

export function sameFingerprint(a: FingerprintConfig, b: FingerprintConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
