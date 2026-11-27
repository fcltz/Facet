import { PREVIEW_ENGINE_MAJOR } from '@shared/constants'
import type { DesktopOs } from '@shared/schemas/common'
import {
  createDefaultFingerprint,
  HARDWARE_CONCURRENCY_PRESETS,
  SCREEN_PRESETS,
} from '@shared/schemas/fingerprint'
import type { Group, Tag } from '@shared/schemas/group-tag'
import { DEFAULT_LAUNCH_OPTIONS, type Profile } from '@shared/schemas/profile'
import type { ProxyCheckStatus, ProxySummary, ProxyType } from '@shared/schemas/proxy'

/**
 * Dados de demonstração da Etapa 1. São gerados com uma semente fixa: a cada
 * abertura do app a tabela mostra exatamente os mesmos perfis, o que facilita
 * testar a interface. Os IPs são de faixas reservadas para documentação
 * (RFC 5737) e os hosts usam o domínio reservado `.example`.
 */

export interface MockSeed {
  groups: Group[]
  tags: Tag[]
  proxies: ProxySummary[]
  profiles: Profile[]
}

export interface MockSeedOptions {
  now: number
  seed?: number
  activeProfiles?: number
  trashedProfiles?: number
  hostTimezone?: string
  engineMajor?: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** PRNG determinístico (mulberry32). */
export class SeededRandom {
  private state: number

  constructor(seed: number) {
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(min: number, max: number): number {
    const lo = Math.ceil(Math.min(min, max))
    const hi = Math.floor(Math.max(min, max))
    return lo + Math.floor(this.next() * (hi - lo + 1))
  }

  chance(probability: number): boolean {
    return this.next() < probability
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)]
    if (item === undefined) throw new Error('SeededRandom.pick chamado com lista vazia')
    return item
  }

  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items]
    const out: T[] = []
    while (out.length < count && pool.length > 0) {
      const [item] = pool.splice(Math.floor(this.next() * pool.length), 1)
      if (item !== undefined) out.push(item)
    }
    return out
  }

  /** UUID v4 válido (versão e variante corretas), mas determinístico. */
  uuid(): string {
    const bytes = Array.from({ length: 16 }, () => Math.floor(this.next() * 256))
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}

const GROUP_DEFS = [
  { name: 'E-commerce', color: '#5B5BF7', prefix: 'Loja' },
  { name: 'Social Media', color: '#EC4899', prefix: 'Social' },
  { name: 'Tráfego pago', color: '#F97316', prefix: 'Ads' },
  { name: 'QA', color: '#14B8A6', prefix: 'QA' },
  { name: 'Clientes', color: '#3B82F6', prefix: 'Cliente' },
  { name: 'Verificação de anúncios', color: '#A855F7', prefix: 'Verificação' },
] as const

const TAG_DEFS = [
  ['aquecimento', '#EAB308'],
  ['verificado', '#22C55E'],
  ['facebook', '#3B82F6'],
  ['instagram', '#EC4899'],
  ['tiktok', '#64748B'],
  ['shopee', '#F97316'],
  ['google-ads', '#06B6D4'],
  ['teste', '#A855F7'],
  ['vip', '#EF4444'],
  ['backup', '#84CC16'],
] as const

interface ProxyDef {
  cc: string
  country: string
  city: string
  timezone: string
  type: ProxyType
  status: ProxyCheckStatus
  languages: string[]
  rotating?: boolean
}

const PROXY_DEFS: ProxyDef[] = [
  {
    cc: 'BR',
    country: 'Brazil',
    city: 'São Paulo',
    timezone: 'America/Sao_Paulo',
    type: 'http',
    status: 'online',
    languages: ['pt-BR', 'pt', 'en-US', 'en'],
    rotating: true,
  },
  {
    cc: 'BR',
    country: 'Brazil',
    city: 'Rio de Janeiro',
    timezone: 'America/Sao_Paulo',
    type: 'socks5',
    status: 'online',
    languages: ['pt-BR', 'pt', 'en-US', 'en'],
  },
  {
    cc: 'US',
    country: 'United States',
    city: 'New York',
    timezone: 'America/New_York',
    type: 'http',
    status: 'online',
    languages: ['en-US', 'en'],
  },
  {
    cc: 'US',
    country: 'United States',
    city: 'Los Angeles',
    timezone: 'America/Los_Angeles',
    type: 'socks5',
    status: 'online',
    languages: ['en-US', 'en'],
    rotating: true,
  },
  {
    cc: 'US',
    country: 'United States',
    city: 'Miami',
    timezone: 'America/New_York',
    type: 'https',
    status: 'offline',
    languages: ['en-US', 'en'],
  },
  {
    cc: 'DE',
    country: 'Germany',
    city: 'Frankfurt am Main',
    timezone: 'Europe/Berlin',
    type: 'http',
    status: 'online',
    languages: ['de-DE', 'de', 'en-US', 'en'],
  },
  {
    cc: 'GB',
    country: 'United Kingdom',
    city: 'London',
    timezone: 'Europe/London',
    type: 'socks5',
    status: 'online',
    languages: ['en-GB', 'en'],
  },
  {
    cc: 'FR',
    country: 'France',
    city: 'Paris',
    timezone: 'Europe/Paris',
    type: 'http',
    status: 'online',
    languages: ['fr-FR', 'fr', 'en-US', 'en'],
  },
  {
    cc: 'PT',
    country: 'Portugal',
    city: 'Lisbon',
    timezone: 'Europe/Lisbon',
    type: 'http',
    status: 'online',
    languages: ['pt-PT', 'pt', 'en'],
  },
  {
    cc: 'ES',
    country: 'Spain',
    city: 'Madrid',
    timezone: 'Europe/Madrid',
    type: 'socks5',
    status: 'unknown',
    languages: ['es-ES', 'es', 'en'],
  },
  {
    cc: 'IT',
    country: 'Italy',
    city: 'Milan',
    timezone: 'Europe/Rome',
    type: 'http',
    status: 'online',
    languages: ['it-IT', 'it', 'en'],
  },
  {
    cc: 'NL',
    country: 'Netherlands',
    city: 'Amsterdam',
    timezone: 'Europe/Amsterdam',
    type: 'https',
    status: 'online',
    languages: ['nl-NL', 'nl', 'en'],
  },
  {
    cc: 'CA',
    country: 'Canada',
    city: 'Toronto',
    timezone: 'America/Toronto',
    type: 'http',
    status: 'offline',
    languages: ['en-CA', 'en', 'fr-CA'],
  },
  {
    cc: 'MX',
    country: 'Mexico',
    city: 'Mexico City',
    timezone: 'America/Mexico_City',
    type: 'socks5',
    status: 'online',
    languages: ['es-MX', 'es', 'en'],
  },
  {
    cc: 'JP',
    country: 'Japan',
    city: 'Tokyo',
    timezone: 'Asia/Tokyo',
    type: 'http',
    status: 'online',
    languages: ['ja-JP', 'ja', 'en-US', 'en'],
  },
]

/** Coordenadas aproximadas das cidades de demonstração (para a sincronização de geolocalização). */
const CITY_COORDINATES: Record<string, [number, number]> = {
  'São Paulo': [-23.55, -46.63],
  'Rio de Janeiro': [-22.91, -43.17],
  'New York': [40.71, -74.01],
  'Los Angeles': [34.05, -118.24],
  Miami: [25.76, -80.19],
  'Frankfurt am Main': [50.11, 8.68],
  London: [51.51, -0.13],
  Paris: [48.86, 2.35],
  Lisbon: [38.72, -9.14],
  Madrid: [40.42, -3.7],
  Milan: [45.46, 9.19],
  Amsterdam: [52.37, 4.9],
  Toronto: [43.65, -79.38],
  'Mexico City': [19.43, -99.13],
  Tokyo: [35.68, 139.69],
}

/** Faixas reservadas para documentação (RFC 5737). */
const DOC_NETS = ['192.0.2', '198.51.100', '203.0.113'] as const

const NOTE_SAMPLES = [
  'Conta principal do cliente: não trocar o proxy.',
  'Aquecimento: 15 min de navegação por dia.',
  'Login com 2FA no celular do time.',
  'Usar só para testes de checkout.',
  'Verificar anúncios da campanha de dezembro.',
  'Perfil de QA: limpar cookies depois de cada rodada.',
]

const STARTUP_SAMPLES = ['https://www.example.com/', 'https://example.org/', 'https://www.wikipedia.org/']

function pickOs(rng: SeededRandom): DesktopOs {
  const roll = rng.next()
  if (roll < 0.7) return 'windows'
  if (roll < 0.9) return 'macos'
  return 'linux'
}

function buildProxies(
  rng: SeededRandom,
  now: number,
): { proxies: ProxySummary[]; defs: Map<string, ProxyDef> } {
  const defs = new Map<string, ProxyDef>()
  const counters = new Map<string, number>()
  const proxies = PROXY_DEFS.map((def, index): ProxySummary => {
    const n = (counters.get(def.cc) ?? 0) + 1
    counters.set(def.cc, n)
    const id = rng.uuid()
    defs.set(id, def)
    const checked = def.status !== 'unknown'
    const hasAuth = rng.chance(0.8)
    const net = DOC_NETS[index % DOC_NETS.length] ?? DOC_NETS[0]
    return {
      id,
      name: rng.chance(0.5) ? `${def.city} ${n}` : null,
      type: def.type,
      host: `${def.cc.toLowerCase()}${n}.gw.proxy.example`,
      port: rng.int(10000, 60000),
      username: hasAuth ? `user-${def.cc.toLowerCase()}${n}` : '',
      hasPassword: hasAuth,
      rotating: Boolean(def.rotating),
      changeIpHost: def.rotating ? 'api.proxy.example' : null,
      notes: '',
      checkStatus: def.status,
      checkedAt: checked ? now - rng.int(10 * MINUTE, 2 * DAY) : null,
      latencyMs: def.status === 'online' ? rng.int(35, 420) : null,
      exitIp: checked ? `${net}.${10 + index * 7}` : null,
      countryCode: checked ? def.cc : null,
      countryName: checked ? def.country : null,
      city: checked ? def.city : null,
      region: null,
      timezone: checked ? def.timezone : null,
      latitude: checked ? (CITY_COORDINATES[def.city]?.[0] ?? null) : null,
      longitude: checked ? (CITY_COORDINATES[def.city]?.[1] ?? null) : null,
      lastError:
        def.status === 'offline' ? (rng.chance(0.5) ? 'ECONNREFUSED' : 'Tempo esgotado (10 s)') : null,
      lastErrorCode: def.status === 'offline' ? 'PROXY_UNREACHABLE' : null,
      createdAt: now - 30 * DAY,
      updatedAt: now - 30 * DAY,
    }
  })
  return { proxies, defs }
}

export function createMockSeed(options: MockSeedOptions): MockSeed {
  const rng = new SeededRandom(options.seed ?? 20261124)
  const now = options.now
  const hostTimezone = options.hostTimezone ?? 'America/Sao_Paulo'
  const engineMajor = options.engineMajor ?? PREVIEW_ENGINE_MAJOR
  const activeCount = options.activeProfiles ?? 120
  const trashedCount = options.trashedProfiles ?? 4

  const groups: Group[] = GROUP_DEFS.map((def, index) => {
    const createdAt = now - (200 - index * 10) * DAY
    return {
      id: rng.uuid(),
      name: def.name,
      color: def.color,
      sortOrder: index,
      createdAt,
      updatedAt: createdAt,
    }
  })
  const prefixByGroup = new Map(groups.map((g, i) => [g.id, GROUP_DEFS[i]?.prefix ?? 'Perfil']))

  const tags: Tag[] = TAG_DEFS.map(([name, color], index) => ({
    id: rng.uuid(),
    name,
    color,
    createdAt: now - (180 - index * 5) * DAY,
  }))

  const { proxies, defs } = buildProxies(rng, now)
  const counters = new Map<string, number>()
  const profiles: Profile[] = []

  for (let i = 0; i < activeCount + trashedCount; i++) {
    const group = rng.chance(0.85) ? rng.pick(groups) : null
    const prefix = group ? (prefixByGroup.get(group.id) ?? 'Perfil') : 'Pessoal'
    const n = (counters.get(prefix) ?? 0) + 1
    counters.set(prefix, n)

    const os = pickOs(rng)
    const proxy = rng.chance(0.8) ? rng.pick(proxies) : null
    const proxyDef = proxy ? defs.get(proxy.id) : undefined
    const fingerprint = createDefaultFingerprint({
      os,
      engineMajor,
      timezone: proxyDef?.timezone ?? hostTimezone,
      languages: proxyDef?.languages,
      screen: rng.pick(SCREEN_PRESETS[os]),
      hardwareConcurrency: rng.pick(HARDWARE_CONCURRENCY_PRESETS[os]),
    })

    const createdAt = now - rng.int(1, 120) * DAY - rng.int(0, DAY - 1)
    const updatedAt = Math.min(now, createdAt + rng.int(0, 20) * DAY)
    const opened = rng.chance(0.75)
    const lastOpenedAt = opened
      ? now - rng.int(5 * MINUTE, Math.min(30 * DAY, now - createdAt - MINUTE))
      : null
    const lastClosedAt =
      lastOpenedAt === null ? null : Math.min(now - MINUTE, lastOpenedAt + rng.int(5 * MINUTE, 6 * HOUR))
    const trashed = i >= activeCount

    profiles.push({
      id: rng.uuid(),
      // número definitivo atribuído abaixo, pela ordem de criação
      serial: 0,
      name: `${prefix} ${String(n).padStart(2, '0')}`,
      browser: 'brave',
      groupId: group?.id ?? null,
      proxyId: proxy?.id ?? null,
      tagIds: rng.sample(tags, rng.int(0, 3)).map((t) => t.id),
      extensionIds: [],
      color: rng.chance(0.25) ? rng.pick(GROUP_DEFS).color : null,
      notes: rng.chance(0.2) ? rng.pick(NOTE_SAMPLES) : '',
      os,
      userAgent: fingerprint.userAgent,
      fingerprint,
      launchOptions: {
        ...DEFAULT_LAUNCH_OPTIONS,
        startupUrls: rng.chance(0.2) ? [rng.pick(STARTUP_SAMPLES)] : [],
      },
      lastOpenedAt,
      lastClosedAt,
      openCount: opened ? rng.int(1, 80) : 0,
      deletedAt: trashed ? now - rng.int(1, 10) * DAY : null,
      createdAt,
      updatedAt,
    })
  }
  // Mesma regra da migration 0006: 1, 2, 3… pela ordem de criação (empate pelo id).
  ;[...profiles]
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .forEach((profile, index) => {
      profile.serial = index + 1
    })

  return { groups, tags, proxies, profiles }
}
