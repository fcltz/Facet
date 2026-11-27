import { AppError } from '@shared/ipc/result'
import {
  fingerprintV2Schema,
  type FingerprintCapabilities,
  type FingerprintConfig,
  type FingerprintSnapshot,
} from '@shared/schemas/fingerprint'
import type { ProxyGeo } from '@shared/schemas/proxy'
import { languagesForCountry } from '@shared/data/country-locales'
import { syncFingerprint, type HostLocale } from '../../services/geo-sync'
import { canonicalFingerprint } from './generator'

export function resolveFingerprint(
  configured: FingerprintConfig,
  capabilities: FingerprintCapabilities,
  proxy: ProxyGeo | null,
  host: HostLocale,
  now = Date.now(),
): FingerprintSnapshot {
  const canonical = canonicalFingerprint(configured, capabilities)
  if (
    proxy &&
    ((canonical.timezone.mode === 'auto' && !proxy.timezone) ||
      (canonical.languages.mode === 'auto' &&
        (!proxy.countryCode || !languagesForCountry(proxy.countryCode))))
  )
    throw new AppError(
      'FINGERPRINT_GEO_REQUIRED',
      'O proxy não tem fuso/idiomas disponíveis. Verifique o geo-IP ou configure esses campos manualmente.',
    )
  const effective = fingerprintV2Schema.parse(syncFingerprint(canonical, proxy, host))
  // A ausência de geo-IP nunca reaproveita coordenadas do proxy anterior.
  if (
    effective.geolocation.mode === 'auto' &&
    (!proxy || proxy.latitude === null || proxy.longitude === null)
  ) {
    effective.geolocation.latitude = null
    effective.geolocation.longitude = null
  }
  return { configured: canonical, effective, engineProduct: capabilities.product, createdAt: now }
}
