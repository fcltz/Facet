import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { _electron as electron, expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { BrowserKind } from '../../src/shared/constants'
import type { InvokeChannel } from '../../src/shared/ipc/channels'
import type { ChannelInput, ChannelOutput, FacetBridge } from '../../src/shared/ipc/contract'

/**
 * Imagens do README (`docs/images`), nos temas claro e escuro: `npm run docs:images`.
 *
 * Tudo é fictício e fica numa pasta própria (`.tmp-docs`): nenhum perfil, proxy ou configuração de
 * quem roda o script é lido ou alterado. Os endereços são de documentação (RFC 2606 e RFC 5737) e
 * os perfis não são abertos, então nenhum proxy é contatado.
 */

const OUTPUT = resolve('docs', 'images')
const WORK = resolve('.tmp-docs')
const USER_DATA = join(WORK, 'user-data')
// largura em que a tabela de perfis cabe sem cortar nomes
const SIZE = { width: 1600, height: 1000 }
const THEMES = ['light', 'dark'] as const
type Theme = (typeof THEMES)[number]
type Os = 'windows' | 'macos' | 'linux' | 'android' | 'ios'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const GROUPS = {
  shop: { name: 'E-commerce', color: '#5B5BF7' },
  social: { name: 'Social media', color: '#EC4899' },
  ads: { name: 'Tráfego pago', color: '#F97316' },
  qa: { name: 'QA', color: '#14B8A6' },
} as const
type GroupKey = keyof typeof GROUPS

const TAGS = {
  marketplace: { name: 'Marketplace', color: '#3B82F6' },
  ads: { name: 'Anúncios', color: '#EAB308' },
  warmup: { name: 'Aquecendo', color: '#22C55E' },
  priority: { name: 'Prioridade', color: '#EF4444' },
  mobile: { name: 'Mobile', color: '#A855F7' },
} as const
type TagKey = keyof typeof TAGS

interface DemoGeo {
  ip: string
  countryCode: string
  country: string
  region: string
  city: string
  timezone: string
  latitude: number
  longitude: number
}

interface DemoProxy {
  name: string
  type: 'http' | 'https' | 'socks5'
  host: string
  port: number
  username: string
  rotating?: boolean
  latency: number | null
  /** null = sem resposta na última verificação. */
  geo: DemoGeo | null
}

const PROXIES = {
  sp: {
    name: 'Residencial São Paulo',
    type: 'socks5',
    host: 'br-sp.residencial.example',
    port: 1080,
    username: 'demo-sp',
    latency: 84,
    geo: {
      ip: '203.0.113.24',
      countryCode: 'BR',
      country: 'Brazil',
      region: 'São Paulo',
      city: 'São Paulo',
      timezone: 'America/Sao_Paulo',
      latitude: -23.55,
      longitude: -46.63,
    },
  },
  rj: {
    name: 'Móvel Rio de Janeiro',
    type: 'http',
    host: 'br-rj.movel.example',
    port: 8000,
    username: 'demo-rj',
    rotating: true,
    latency: 132,
    geo: {
      ip: '203.0.113.57',
      countryCode: 'BR',
      country: 'Brazil',
      region: 'Rio de Janeiro',
      city: 'Rio de Janeiro',
      timezone: 'America/Sao_Paulo',
      latitude: -22.91,
      longitude: -43.17,
    },
  },
  ny: {
    name: 'Datacenter Nova York',
    type: 'http',
    host: 'us-ny.dc.example',
    port: 3128,
    username: 'demo-ny',
    latency: 46,
    geo: {
      ip: '198.51.100.14',
      countryCode: 'US',
      country: 'United States',
      region: 'New York',
      city: 'New York',
      timezone: 'America/New_York',
      latitude: 40.71,
      longitude: -74.01,
    },
  },
  md: {
    name: 'Residencial Madri',
    type: 'socks5',
    host: 'es-md.residencial.example',
    port: 1080,
    username: 'demo-md',
    latency: 158,
    geo: {
      ip: '198.51.100.88',
      countryCode: 'ES',
      country: 'Spain',
      region: 'Madrid',
      city: 'Madrid',
      timezone: 'Europe/Madrid',
      latitude: 40.42,
      longitude: -3.7,
    },
  },
  li: {
    name: 'ISP Lisboa',
    type: 'https',
    host: 'pt-li.isp.example',
    port: 443,
    username: 'demo-li',
    latency: 171,
    geo: {
      ip: '192.0.2.45',
      countryCode: 'PT',
      country: 'Portugal',
      region: 'Lisboa',
      city: 'Lisbon',
      timezone: 'Europe/Lisbon',
      latitude: 38.72,
      longitude: -9.14,
    },
  },
  be: {
    name: 'Residencial Berlim',
    type: 'socks5',
    host: 'de-be.residencial.example',
    port: 1080,
    username: 'demo-be',
    latency: 149,
    geo: {
      ip: '192.0.2.130',
      countryCode: 'DE',
      country: 'Germany',
      region: 'Berlin',
      city: 'Berlin',
      timezone: 'Europe/Berlin',
      latitude: 52.52,
      longitude: 13.4,
    },
  },
  tk: {
    name: 'Móvel Tóquio',
    type: 'http',
    host: 'jp-tk.movel.example',
    port: 8080,
    username: 'demo-tk',
    rotating: true,
    latency: 262,
    geo: {
      ip: '198.51.100.203',
      countryCode: 'JP',
      country: 'Japan',
      region: 'Tokyo',
      city: 'Tokyo',
      timezone: 'Asia/Tokyo',
      latitude: 35.68,
      longitude: 139.69,
    },
  },
  ld: {
    name: 'Datacenter Londres',
    type: 'http',
    host: 'uk-ld.dc.example',
    port: 3128,
    username: 'demo-ld',
    latency: null,
    geo: null,
  },
} satisfies Record<string, DemoProxy>
type ProxyKey = keyof typeof PROXIES

interface DemoProfile {
  name: string
  group: GroupKey | null
  tags: TagKey[]
  proxy: ProxyKey | null
  os: Os
  browser: BrowserKind
  /** Há quanto tempo foi aberto pela última vez (null = nunca). */
  openedAgo: number | null
  opens: number
}

const PROFILES: DemoProfile[] = [
  {
    name: 'Loja Moda 01',
    group: 'shop',
    tags: ['marketplace', 'priority'],
    proxy: 'sp',
    os: 'windows',
    browser: 'ungoogled',
    openedAgo: 4 * MINUTE,
    opens: 128,
  },
  {
    name: 'Loja Moda 02',
    group: 'shop',
    tags: ['marketplace'],
    proxy: 'sp',
    os: 'windows',
    browser: 'ungoogled',
    openedAgo: 52 * MINUTE,
    opens: 97,
  },
  {
    name: 'Casa & Decoração',
    group: 'shop',
    tags: ['marketplace'],
    proxy: 'li',
    os: 'macos',
    browser: 'chrome',
    openedAgo: 3 * HOUR,
    opens: 41,
  },
  {
    name: 'Pet Shop Central',
    group: 'shop',
    tags: ['marketplace', 'warmup'],
    proxy: 'rj',
    os: 'windows',
    browser: 'brave',
    openedAgo: 26 * HOUR,
    opens: 12,
  },
  {
    name: 'Marca Pessoal',
    group: 'social',
    tags: ['mobile'],
    proxy: 'rj',
    os: 'ios',
    browser: 'ungoogled',
    openedAgo: 18 * MINUTE,
    opens: 64,
  },
  {
    name: 'Agência · Cliente A',
    group: 'social',
    tags: ['priority'],
    proxy: 'ny',
    os: 'windows',
    browser: 'chrome',
    openedAgo: 7 * HOUR,
    opens: 33,
  },
  {
    name: 'Agência · Cliente B',
    group: 'social',
    tags: ['warmup'],
    proxy: 'md',
    os: 'android',
    browser: 'ungoogled',
    openedAgo: 2 * DAY,
    opens: 5,
  },
  {
    name: 'Campanha Verão',
    group: 'ads',
    tags: ['ads'],
    proxy: 'ny',
    os: 'macos',
    browser: 'opera',
    openedAgo: 5 * HOUR,
    opens: 22,
  },
  {
    name: 'Campanha Black Friday',
    group: 'ads',
    tags: ['ads', 'priority'],
    proxy: 'be',
    os: 'windows',
    browser: 'ungoogled',
    openedAgo: 9 * MINUTE,
    opens: 210,
  },
  {
    name: 'Remarketing Europa',
    group: 'ads',
    tags: ['ads'],
    proxy: 'be',
    os: 'linux',
    browser: 'brave',
    openedAgo: 3 * DAY,
    opens: 18,
  },
  {
    name: 'QA · Checkout',
    group: 'qa',
    tags: [],
    proxy: null,
    os: 'windows',
    browser: 'chrome',
    openedAgo: 30 * HOUR,
    opens: 7,
  },
  {
    name: 'QA · Android',
    group: 'qa',
    tags: ['mobile'],
    proxy: 'tk',
    os: 'android',
    browser: 'ungoogled',
    openedAgo: 6 * DAY,
    opens: 3,
  },
  {
    name: 'QA · iPhone',
    group: 'qa',
    tags: ['mobile'],
    proxy: 'tk',
    os: 'ios',
    browser: 'ungoogled',
    openedAgo: null,
    opens: 0,
  },
  {
    name: 'Pesquisa de preços',
    group: null,
    tags: [],
    proxy: 'ld',
    os: 'windows',
    browser: 'ungoogled',
    openedAgo: null,
    opens: 0,
  },
]

async function call<C extends InvokeChannel>(
  page: Page,
  channel: C,
  input?: ChannelInput<C>,
): Promise<ChannelOutput<C>> {
  const result = await page.evaluate(
    ([name, data]) =>
      (Reflect.get(globalThis, 'api') as FacetBridge).invoke(name as C, data as ChannelInput<C>),
    [channel, input] as const,
  )
  if (!result.ok) throw new Error(`${channel}: ${result.error.message}`)
  return result.data as ChannelOutput<C>
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(entry[0]),
    ),
  )
  const app = await electron.launch({
    args: [resolve('.')],
    // o tema segue o nativeTheme do Electron, como no uso normal
    colorScheme: null,
    env: { ...env, FACET_USER_DATA_DIR: USER_DATA, FACET_E2E_NO_RELAUNCH: '1' },
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setContentSize(size.width, size.height)
    window?.center()
  }, SIZE)
  await expect
    .poll(() =>
      page.evaluate(() => [Reflect.get(globalThis, 'innerWidth'), Reflect.get(globalThis, 'innerHeight')]),
    )
    .toEqual([SIZE.width, SIZE.height])
  return { app, page }
}

async function setTheme(page: Page, theme: Theme): Promise<void> {
  await call(page, 'settings.update', { theme })
  if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
  else await expect(page.locator('html')).not.toHaveClass(/dark/)
}

async function shoot(page: Page, name: string, theme: Theme): Promise<void> {
  // sem hover nem foco visível sobrando de cliques anteriores
  await page.mouse.move(0, 0)
  await page.evaluate(() => {
    const document = Reflect.get(globalThis, 'document') as { activeElement: { blur?: () => void } | null }
    document.activeElement?.blur?.()
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUTPUT, `${name}-${theme}.png`), animations: 'disabled', caret: 'hide' })
}

const nav = (page: Page, destination: string) =>
  page.locator(`[data-testid="nav-item"][data-page="${destination}"]`)

/** Grava o resultado da última verificação de cada proxy (os endereços fictícios não respondem). */
function seedProxyChecks(ids: Record<ProxyKey, string>): void {
  const db = new Database(join(USER_DATA, 'data', 'facet.sqlite'))
  try {
    const update = db.prepare(
      `UPDATE proxies SET check_status = ?, checked_at = ?, latency_ms = ?, exit_ip = ?, country_code = ?,
        country_name = ?, region = ?, city = ?, timezone = ?, latitude = ?, longitude = ?, last_error = ?,
        last_error_code = ? WHERE id = ?`,
    )
    const now = Date.now()
    for (const [key, proxy] of Object.entries(PROXIES) as [ProxyKey, DemoProxy][]) {
      const geo = proxy.geo
      update.run(
        geo ? 'online' : 'offline',
        now - 6 * MINUTE,
        proxy.latency,
        geo?.ip ?? null,
        geo?.countryCode ?? null,
        geo?.country ?? null,
        geo?.region ?? null,
        geo?.city ?? null,
        geo?.timezone ?? null,
        geo?.latitude ?? null,
        geo?.longitude ?? null,
        geo ? null : 'O proxy não respondeu a tempo.',
        geo ? null : 'PROXY_TIMEOUT',
        ids[key],
      )
    }
  } finally {
    db.close()
  }
}

/** Histórico de uso de cada perfil (última abertura e quantas vezes abriu). */
function seedProfileHistory(): void {
  const db = new Database(join(USER_DATA, 'data', 'facet.sqlite'))
  try {
    const update = db.prepare(
      'UPDATE profiles SET last_opened_at = ?, last_closed_at = ?, open_count = ? WHERE name = ?',
    )
    const now = Date.now()
    for (const profile of PROFILES) {
      const opened = profile.openedAgo === null ? null : now - profile.openedAgo
      update.run(opened, opened === null ? null : opened + 25 * MINUTE, profile.opens, profile.name)
    }
  } finally {
    db.close()
  }
}

test('imagens do README com dados fictícios', async () => {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(USER_DATA, { recursive: true })
  mkdirSync(OUTPUT, { recursive: true })

  // 1ª abertura: boas-vindas; depois grupos, tags e proxies
  let { app, page } = await launch()
  await expect(page.getByTestId('welcome')).toBeVisible()
  await call(page, 'settings.update', { language: 'pt-BR', startPage: '' })
  await expect(page.getByTestId('welcome-language-pt-BR')).toHaveAttribute('aria-checked', 'true')
  for (const theme of THEMES) {
    await setTheme(page, theme)
    await shoot(page, 'welcome', theme)
  }
  await call(page, 'settings.update', {
    onboardingCompleted: true,
    theme: 'light',
    defaultBrowser: 'ungoogled',
  })
  await expect(page.getByTestId('sidebar')).toBeVisible()

  const groups = {} as Record<GroupKey, string>
  for (const [key, group] of Object.entries(GROUPS) as [GroupKey, (typeof GROUPS)[GroupKey]][])
    groups[key] = (await call(page, 'groups.create', { name: group.name, color: group.color })).id
  const tags = {} as Record<TagKey, string>
  for (const [key, tag] of Object.entries(TAGS) as [TagKey, (typeof TAGS)[TagKey]][])
    tags[key] = (await call(page, 'tags.create', { name: tag.name, color: tag.color })).id
  const proxies = {} as Record<ProxyKey, string>
  for (const [key, proxy] of Object.entries(PROXIES) as [ProxyKey, DemoProxy][]) {
    const created = await call(page, 'proxies.create', {
      name: proxy.name,
      type: proxy.type,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: 'senha-de-demonstracao',
      changeIpUrl: proxy.rotating ? `https://api.${proxy.host}/rotate?key=demo` : '',
      notes: '',
    })
    proxies[key] = created.id
  }
  await app.close()
  seedProxyChecks(proxies)

  // perfis criados com os proxies já localizados: fuso, idioma e geolocalização acompanham o IP
  ;({ app, page } = await launch())
  await expect(page.getByTestId('sidebar')).toBeVisible()
  for (const profile of PROFILES) {
    const [created] = await call(page, 'profiles.bulkCreate', {
      count: 1,
      namePrefix: profile.name,
      browser: profile.browser,
      os: profile.os,
      groupId: profile.group ? groups[profile.group] : null,
      proxyId: profile.proxy ? proxies[profile.proxy] : null,
      tagIds: profile.tags.map((tag) => tags[tag]),
    })
    await call(page, 'profiles.update', { id: created!.id, patch: { name: profile.name } })
  }
  await app.close()
  seedProfileHistory()

  ;({ app, page } = await launch())
  await expect(page.getByTestId('sidebar')).toBeVisible()
  await expect(page.getByTestId('profile-row')).toHaveCount(PROFILES.length)
  // a detecção dos navegadores termina antes das fotos (sem "Verificando…")
  await expect
    .poll(async () => (await call(page, 'browser.getInfo')).browsers.every((browser) => !browser.checking), {
      timeout: 90_000,
    })
    .toBe(true)

  for (const theme of THEMES) {
    await setTheme(page, theme)

    await nav(page, 'profiles').click()
    await expect(page.getByTestId('profile-row')).toHaveCount(PROFILES.length)
    await shoot(page, 'profiles', theme)

    await nav(page, 'proxies').click()
    await expect(page.getByTestId('proxy-row')).toHaveCount(Object.keys(PROXIES).length)
    await shoot(page, 'proxies', theme)

    await nav(page, 'profiles').click()
    await page.getByTestId('profile-name').filter({ hasText: 'QA · Android' }).click()
    await page.getByTestId('drawer-tab-fingerprint').click()
    await expect(page.getByTestId('fp-device')).toBeVisible()
    // o aparelho no alto, seguido do fuso e dos idiomas que acompanham o proxy (Tóquio)
    await page
      .getByTestId('fp-device')
      .evaluate((element) => (element.closest('section') ?? element).scrollIntoView({ block: 'start' }))
    await expect(page.locator('#fp-timezone-mode')).toBeInViewport()
    await shoot(page, 'fingerprint', theme)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('profile-drawer')).toBeHidden()

    await page.getByTestId('new-profile-more').click()
    await page.getByTestId('bulk-create').click()
    await page.getByTestId('bulk-count-input').fill('25')
    await page.locator('#bulk-prefix').fill('Loja')
    await page.getByTestId('bulk-create-dialog').getByTestId('os-ios').click()
    await shoot(page, 'bulk', theme)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('bulk-create-dialog')).toBeHidden()
  }
  await app.close()
})
