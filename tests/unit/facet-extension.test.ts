import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { extensionIdFromKeyBase64 } from '@main/extensions/ids'
import { FACET_EXTENSION_ID, FACET_USAGE_HEADER, FACET_USAGE_URL } from '@shared/facet-extension'

const root = path.resolve('resources/facet-extension')
const read = (file: string): string => fs.readFileSync(path.join(root, file), 'utf8')
const json = <T>(file: string): T => JSON.parse(read(file)) as T

interface Manifest {
  manifest_version: number
  version: string
  key: string
  default_locale: string
  description: string
  permissions: string[]
  host_permissions: string[]
  web_accessible_resources?: unknown
  externally_connectable?: unknown
  background: { service_worker: string }
  content_scripts: { matches: string[]; js: string[]; css?: string[]; run_at: string; all_frames: boolean }[]
  action: { default_popup: string; default_icon: Record<string, string> }
  icons: Record<string, string>
  declarative_net_request: { rule_resources: { id: string; enabled: boolean; path: string }[] }
}

interface Rule {
  id: number
  priority: number
  action: { type: string }
  condition: Record<string, unknown>
}

interface Cosmetic {
  highly: string[]
  lowly: Record<string, string[]>
  specific: Record<string, string[]>
  exceptions: Record<string, string[]>
  generichide: string[]
  specifichide: string[]
}

interface Indicator {
  text: string
  tone: string
}
interface Box {
  left: number
  top: number
  right: number
  bottom: number
}
interface FacetCore {
  DEFAULTS: Record<string, boolean>
  FILTER_RULESETS: string[]
  ENDPOINTS: { trace: string; speed: string; usage: string }
  OWN_REQUESTS_RULE_ID: number
  ownRequestsRule(): {
    id: number
    priority: number
    action: { type: string }
    condition: { tabIds: number[]; requestDomains: string[] }
  }
  locale(language: string): 'pt' | 'es' | 'en'
  settings(value: unknown): Record<string, boolean>
  validPatch(value: unknown): boolean
  position(value: unknown): { x: number; y: number }
  ip(value: unknown): string | null
  trace(text: unknown): { ip: string; country: string | null } | null
  usage(value: unknown): { total: number; bytesPerSecond: number } | null
  mbps(bytes: number, ms: number): number | null
  fresh(result: unknown, now: number, ttl: number): boolean
  formatMbps(value: number, language: string): string
  formatBytes(value: number, language: string): string
  words(language: string): Record<string, string>
  indicatorText(
    metrics: unknown,
    speed: unknown,
    measuring: boolean,
    usage: unknown,
    language: string,
  ): Indicator
  indicatorCss(indicator: Indicator, position?: unknown, dragging?: boolean): string
  indicatorRect(
    position: { x: number; y: number },
    size: { width: number; height: number },
    viewport: { width: number; height: number },
  ): Box
  positionAt(
    left: number,
    top: number,
    size: { width: number; height: number },
    viewport: { width: number; height: number },
  ): { x: number; y: number }
  cssString(value: string): string
  rulesets(value: unknown): { enableRulesetIds: string[]; disableRulesetIds: string[] }
  hostSuffixes(hostname: string): string[]
  cosmeticSelectors(data: Cosmetic, hostname: string, tokens: string[] | null): string[]
  hidingCss(selectors: string[]): string
}

const RESOURCE_TYPES = new Set([
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
])
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

let core: FacetCore

beforeAll(async () => {
  // script clássico da extensão (sem exports): define globalThis.FacetCore ao ser carregado
  const script = '../../resources/facet-extension/core.js'
  await import(script)
  core = Reflect.get(globalThis, 'FacetCore') as FacetCore
})

describe('pacote da extensão Facet', () => {
  const manifest = json<Manifest>('manifest.json')

  it('tem o ID fixo do app (derivado da chave) e só as permissões de que precisa', () => {
    expect(extensionIdFromKeyBase64(manifest.key)).toBe(FACET_EXTENSION_ID)
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.permissions).toEqual(['storage', 'declarativeNetRequest', 'scripting', 'privacy'])
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*'])
    // nada que uma página possa sondar ou chamar
    expect(manifest.web_accessible_resources).toBeUndefined()
    expect(manifest.externally_connectable).toBeUndefined()
  })

  it('o content script roda só na página principal e sem CSS de autor', () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['http://*/*', 'https://*/*'],
        js: ['core.js', 'content.js'],
        run_at: 'document_start',
        all_frames: false,
      },
    ])
  })

  it('o content script nunca altera o DOM nem a página (invisível para os scripts do site)', () => {
    for (const file of ['content.js', 'core.js']) {
      const source = read(file)
      for (const api of [
        'createElement',
        'appendChild',
        'append(',
        'prepend(',
        'insertBefore',
        'insertAdjacent',
        'innerHTML',
        'outerHTML',
        'setAttribute',
        'removeAttribute',
        'toggleAttribute',
        'attachShadow',
        '.style',
        'classList.add',
        'classList.remove',
        'classList.toggle',
        'document.write',
        'postMessage',
        'dispatchEvent',
        'setPointerCapture',
      ])
        expect(source, `${file}: ${api}`).not.toContain(api)
    }
  })

  it('o gasto da proxy vem do endereço que o proxy local do Facet atende', () => {
    expect(core.ENDPOINTS.usage).toBe(FACET_USAGE_URL)
    expect(read('background.js')).toContain(`USAGE_HEADER = '${FACET_USAGE_HEADER}'`)
  })

  it('nenhuma lista bloqueia as consultas da própria extensão (IP, velocidade e gasto da proxy)', () => {
    // O EasyPrivacy bloqueia `||cloudflare.com/cdn-cgi/trace` de terceiros, e o service worker da
    // extensão conta como terceiro: sem a regra de sessão, o indicador ficava "Sem conexão".
    const own = core.ownRequestsRule()
    expect(own).toMatchObject({ id: core.OWN_REQUESTS_RULE_ID, action: { type: 'allow' } })
    // só pedidos que não vêm de nenhuma aba (o service worker): nas páginas o trace segue bloqueado
    expect(own.condition.tabIds).toEqual([-1])
    expect(Object.keys(own.condition).sort()).toEqual(['requestDomains', 'tabIds'])
    const filter = (urlFilter: string): RegExp => {
      let body = urlFilter
      let start = ''
      let end = ''
      if (body.startsWith('||')) {
        start = '^[a-z]+://([^/]*\\.)?'
        body = body.slice(2)
      } else if (body.startsWith('|')) {
        start = '^'
        body = body.slice(1)
      }
      if (body.endsWith('|')) {
        end = '$'
        body = body.slice(0, -1)
      }
      const pattern = [...body]
        .map((char) =>
          char === '*'
            ? '.*'
            : char === '^'
              ? '([^A-Za-z0-9_.%-]|$)'
              : /[.+?${}()[\]\\/|]/.test(char)
                ? `\\${char}`
                : char,
        )
        .join('')
      return new RegExp(start + pattern + end)
    }
    const urls = [core.ENDPOINTS.trace, `${core.ENDPOINTS.speed}1048576`, core.ENDPOINTS.usage]
    const blocking: string[] = []
    for (const id of [...core.FILTER_RULESETS, 'optimize']) {
      const rules = JSON.parse(read(id === 'optimize' ? 'optimize.json' : `rules/${id}.json`)) as {
        id: number
        priority: number
        action: { type: string }
        condition: Record<string, unknown>
      }[]
      for (const rule of rules) {
        const condition = rule.condition as {
          urlFilter?: string
          requestDomains?: string[]
          initiatorDomains?: string[]
        }
        if (rule.action.type !== 'block' || condition.initiatorDomains) continue
        for (const url of urls) {
          const host = new URL(url).hostname
          const domain = (condition.requestDomains ?? []).some((d) => host === d || host.endsWith(`.${d}`))
          const matched = condition.urlFilter
            ? filter(condition.urlFilter).test(url) && (!condition.requestDomains?.length || domain)
            : domain
          if (!matched) continue
          blocking.push(`${id}#${rule.id} ${url}`)
          // a regra de sessão vence: prioridade maior e o host coberto
          expect(own.priority, `${id}#${rule.id}`).toBeGreaterThan(rule.priority)
          expect(own.condition.requestDomains, `${id}#${rule.id}`).toContain(host)
        }
      }
    }
    // a regra do EasyPrivacy que causava o "Sem conexão" continua lá (e é coberta)
    expect(blocking.some((entry) => entry.startsWith('privacy#') && entry.endsWith('/cdn-cgi/trace'))).toBe(
      true,
    )
    expect(read('background.js')).toContain('updateSessionRules')
  })

  it('todos os arquivos citados no manifest existem, com traduções e licenças', () => {
    const files = [
      manifest.background.service_worker,
      ...manifest.content_scripts.flatMap((script) => script.js),
      manifest.action.default_popup,
      ...Object.values(manifest.action.default_icon),
      ...Object.values(manifest.icons),
      ...manifest.declarative_net_request.rule_resources.map((resource) => resource.path),
      'cosmetic.json',
      'popup.js',
      'popup.css',
      'NOTICE.txt',
      'third-party/GPL-3.0.txt',
      'third-party/CC-BY-SA-3.0.txt',
    ]
    for (const file of files) expect(fs.existsSync(path.join(root, file)), file).toBe(true)
    expect(manifest.description).toBe('__MSG_description__')
    for (const locale of ['pt_BR', 'en', 'es'])
      expect(
        json<{ description: { message: string } }>(`_locales/${locale}/messages.json`).description.message,
      ).toMatch(/\S/)
    expect(manifest.default_locale).toBe('pt_BR')
  })

  it('as listas do uBlock Origin guardadas conferem com o registro (endereço e SHA-256)', () => {
    const sources =
      json<{ id: string; url: string; sha256: string; license: string }[]>('third-party/sources.json')
    expect(sources.map((source) => source.id)).toEqual([
      'ublock-filters',
      'ublock-badware',
      'ublock-privacy',
      'ublock-unbreak',
      'ublock-quick-fixes',
      'easylist',
      'easyprivacy',
      'plowe-0',
      'urlhaus-1',
    ])
    for (const source of sources) {
      const text = read(`third-party/lists/${source.id}.txt`)
      expect(createHash('sha256').update(text).digest('hex'), source.id).toBe(source.sha256)
      expect(source.url).toMatch(/^https:\/\//)
      expect(source.license).toMatch(/\S/)
    }
  })

  it('regras declarativas válidas para o Chromium, dentro do limite garantido de 30 mil', () => {
    expect(manifest.declarative_net_request.rule_resources).toEqual([
      { id: 'ads', enabled: true, path: 'rules/ads.json' },
      { id: 'privacy', enabled: true, path: 'rules/privacy.json' },
      { id: 'malware', enabled: true, path: 'rules/malware.json' },
      { id: 'unbreak', enabled: true, path: 'rules/unbreak.json' },
      { id: 'optimize', enabled: true, path: 'optimize.json' },
    ])
    let total = 0
    for (const resource of manifest.declarative_net_request.rule_resources) {
      const rules = json<Rule[]>(resource.path)
      total += rules.length
      expect(rules.length, resource.id).toBeGreaterThan(0)
      expect(new Set(rules.map((rule) => rule.id)).size, resource.id).toBe(rules.length)
      for (const rule of rules) {
        const label = `${resource.id}#${rule.id}`
        expect(Number.isInteger(rule.id) && rule.id > 0, label).toBe(true)
        expect([1, 2, 3], label).toContain(rule.priority)
        expect(['block', 'allow', 'allowAllRequests'], label).toContain(rule.action.type)
        const { condition } = rule
        if (condition.urlFilter !== undefined) {
          expect(
            typeof condition.urlFilter === 'string' && /^[\x21-\x7e]+$/.test(condition.urlFilter),
            label,
          ).toBe(true)
          expect((condition.urlFilter as string).startsWith('||*'), label).toBe(false)
        }
        for (const key of [
          'requestDomains',
          'excludedRequestDomains',
          'initiatorDomains',
          'excludedInitiatorDomains',
        ]) {
          const list = condition[key] as string[] | undefined
          if (list === undefined) continue
          expect(list.length > 0 && list.every((host) => HOST.test(host)), `${label} ${key}`).toBe(true)
        }
        for (const key of ['resourceTypes', 'excludedResourceTypes']) {
          const list = condition[key] as string[] | undefined
          if (list === undefined) continue
          expect(list.length > 0 && list.every((type) => RESOURCE_TYPES.has(type)), `${label} ${key}`).toBe(
            true,
          )
        }
        expect(
          condition.resourceTypes !== undefined && condition.excludedResourceTypes !== undefined,
          label,
        ).toBe(false)
        if (rule.action.type === 'allowAllRequests')
          expect(
            (condition.resourceTypes as string[]).every(
              (type) => type === 'main_frame' || type === 'sub_frame',
            ),
            label,
          ).toBe(true)
      }
    }
    expect(total).toBeGreaterThan(10000)
    expect(total).toBeLessThan(30000)
  })

  it('dados cosméticos: genéricos por classe/id, amplos e por site', () => {
    const cosmetic = json<Cosmetic>('cosmetic.json')
    expect(Object.keys(cosmetic.lowly).length).toBeGreaterThan(5000)
    expect(cosmetic.highly.length).toBeGreaterThan(100)
    expect(Object.keys(cosmetic.specific).length).toBeGreaterThan(1000)
    for (const [token, selectors] of Object.entries(cosmetic.lowly).slice(0, 500)) {
      expect(token, token).toMatch(/^[.#][A-Za-z_-][A-Za-z0-9_-]*$/)
      expect(
        selectors.every((selector) => !/[{}]/.test(selector)),
        token,
      ).toBe(true)
    }
  })

  it('economia de recursos: só beacons e relatórios de terceiros (nada que a página perceba)', () => {
    expect(json<Rule[]>('optimize.json')).toEqual([
      {
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: { resourceTypes: ['ping', 'csp_report'], domainType: 'thirdParty' },
      },
    ])
  })
})

describe('funções da extensão Facet (core.js)', () => {
  it('preferências: tudo ligado por padrão e só booleanos conhecidos', () => {
    expect(core.settings(undefined)).toEqual({
      enabled: true,
      adblock: true,
      optimize: true,
      indicator: true,
    })
    expect(core.settings({ adblock: false, indicator: 'não', extra: true })).toEqual({
      enabled: true,
      adblock: false,
      optimize: true,
      indicator: true,
    })
    expect(core.validPatch({ indicator: false })).toBe(true)
    expect(core.validPatch({})).toBe(false)
    expect(core.validPatch({ indicator: 'false' })).toBe(false)
    expect(core.validPatch({ other: true })).toBe(false)
    expect(core.validPatch(null)).toBe(false)
    expect(core.validPatch([true])).toBe(false)
  })

  it('lê IP, país e o gasto da proxy, e rejeita respostas inválidas', () => {
    expect(core.trace('fl=1\nh=www.cloudflare.com\nip=203.0.113.7\nts=1\nloc=BR\n')).toEqual({
      ip: '203.0.113.7',
      country: 'BR',
    })
    expect(core.trace('ip=2001:DB8::1\nloc=XX')).toEqual({ ip: '2001:db8::1', country: null })
    expect(core.trace('ip=999.1.1.1\nloc=BR')).toBeNull()
    expect(core.trace('<html>captcha</html>')).toBeNull()
    expect(core.usage({ total: 1500, bytesPerSecond: 20 })).toEqual({ total: 1500, bytesPerSecond: 20 })
    expect(core.usage({ total: -1 })).toBeNull()
    expect(core.usage({ total: 'x' })).toBeNull()
    expect(core.usage({ total: 10, bytesPerSecond: 'x' })).toEqual({ total: 10, bytesPerSecond: 0 })
  })

  it('velocidade, bytes e validade dos resultados', () => {
    expect(core.mbps(1048576, 1000)).toBeCloseTo(8.388608, 6)
    expect(core.mbps(0, 10)).toBeNull()
    expect(core.formatMbps(23.44, 'pt-BR')).toBe('23,4')
    expect(core.formatMbps(512.7, 'en-US')).toBe('513')
    expect(core.formatBytes(512, 'pt-BR')).toBe('512 B')
    expect(core.formatBytes(1536, 'pt-BR')).toBe('1,5 KB')
    expect(core.formatBytes(152 * 1048576, 'en-US')).toBe('152 MB')
    expect(core.formatBytes(1.4 * 1073741824, 'pt-BR')).toBe('1,4 GB')
    expect(core.fresh({ at: 1000 }, 1500, 600)).toBe(true)
    expect(core.fresh({ at: 1000 }, 1700, 600)).toBe(false)
  })

  it('texto do indicador: consultando, sem conexão, medindo, completo e com o gasto da proxy', () => {
    expect(core.indicatorText(null, null, false, null, 'pt-BR')).toEqual({
      text: 'Consultando…',
      tone: 'muted',
    })
    expect(core.indicatorText({ error: true, ip: null }, null, false, null, 'pt-BR')).toEqual({
      text: 'Sem conexão',
      tone: 'warning',
    })
    // sem IP, a velocidade e o gasto da proxy continuam aparecendo
    expect(
      core.indicatorText({ error: true, ip: null }, { mbps: 12.5 }, false, { total: 2 * 1048576 }, 'pt-BR'),
    ).toEqual({ text: 'Sem conexão · ↓ 12,5 Mbps · ⇅ 2,0 MB', tone: 'warning' })
    const metrics = { ip: '203.0.113.7', country: 'BR', latency: 45, error: false }
    expect(core.indicatorText(metrics, null, true, null, 'pt-BR').text).toBe('BR 203.0.113.7 · 45 ms · ↓ …')
    expect(core.indicatorText(metrics, { mbps: 23.44 }, false, { total: 152 * 1048576 }, 'pt-BR')).toEqual({
      text: 'BR 203.0.113.7 · 45 ms · ↓ 23,4 Mbps · ⇅ 152 MB',
      tone: 'normal',
    })
    expect(core.indicatorText({ ...metrics, country: null }, { mbps: 9 }, false, null, 'en').text).toBe(
      '203.0.113.7 · 45 ms · ↓ 9.0 Mbps',
    )
  })

  it('CSS do indicador: pseudo-elemento arrastável, sempre dentro da janela, com o texto escapado', () => {
    expect(core.cssString('a"b\\c\nd\u0007')).toBe('"a\\"b\\\\cd"')
    const css = core.indicatorCss({ text: 'BR 203.0.113.7 · 45 ms', tone: 'normal' })
    expect(css).toMatch(/^html::after \{/)
    expect(css).toContain('content: "BR 203.0.113.7 · 45 ms" !important;')
    expect(css).toContain('position: fixed !important;')
    expect(css).toContain('left: calc(8px + (100% - 16px) * 0.0000) !important;')
    expect(css).toContain('bottom: calc(8px + (100% - 16px) * 0.0000) !important;')
    expect(css).toContain('cursor: grab !important;')
    expect(css).not.toContain('transition')
    const moved = core.indicatorCss({ text: 'x', tone: 'normal' }, { x: 0.5, y: 2 }, true)
    expect(moved).toContain('left: calc(8px + (100% - 16px) * 0.5000) !important;')
    // posição fora da faixa é presa ao limite (nunca sai da janela)
    expect(moved).toContain('bottom: calc(8px + (100% - 16px) * 1.0000) !important;')
    expect(moved).toContain('cursor: grabbing !important;')
    expect(moved).toContain('transition')
    const hostile = core.indicatorCss({ text: '"} body { display: none } x {"', tone: 'normal' })
    expect(hostile).toContain('content: "\\"} body { display: none } x {\\"" !important;')
  })

  it('retângulo do indicador e posição ao soltar seguem o mesmo cálculo do CSS', () => {
    const size = { width: 200, height: 20 }
    const viewport = { width: 1000, height: 600 }
    // canto inferior esquerdo, com margem de 8 px
    expect(core.indicatorRect({ x: 0, y: 0 }, size, viewport)).toEqual({
      left: 8,
      top: 572,
      right: 208,
      bottom: 592,
    })
    // canto superior direito
    expect(core.indicatorRect({ x: 1, y: 1 }, size, viewport)).toEqual({
      left: 792,
      top: 8,
      right: 992,
      bottom: 28,
    })
    // soltar no meio e ler de volta
    const where = core.positionAt(400, 290, size, viewport)
    const box = core.indicatorRect(where, size, viewport)
    expect(box.left).toBeCloseTo(400, 6)
    expect(box.top).toBeCloseTo(290, 6)
    // arrastar para fora da janela fica no limite
    expect(core.positionAt(-500, 5000, size, viewport)).toEqual({ x: 0, y: 0 })
    expect(core.position({ x: 'a', y: -3 })).toEqual({ x: 0, y: 0 })
  })

  it('regras ligadas conforme as preferências; com a Facet desligada, nenhuma', () => {
    expect(core.rulesets({})).toEqual({
      enableRulesetIds: ['ads', 'privacy', 'malware', 'unbreak', 'optimize'],
      disableRulesetIds: [],
    })
    expect(core.rulesets({ adblock: false })).toEqual({
      enableRulesetIds: ['optimize'],
      disableRulesetIds: ['ads', 'privacy', 'malware', 'unbreak'],
    })
    expect(core.rulesets({ enabled: false }).enableRulesetIds).toEqual([])
  })

  it('cosméticos por host: do site, genéricos amplos e por token, respeitando as exceções', () => {
    const data: Cosmetic = {
      highly: ['[data-ad]', '.everywhere'],
      lowly: { '.ad-slot': ['.ad-slot', 'div > .ad-slot'], '#top-ad': ['#top-ad'] },
      specific: { 'site.com': ['.local-ad'], 'news.site.com': ['.news-ad'] },
      exceptions: { 'site.com': ['.everywhere', 'div > .ad-slot'] },
      generichide: ['quiet.com'],
      specifichide: ['plain.org'],
    }
    expect(core.hostSuffixes('a.news.site.com')).toEqual([
      'a.news.site.com',
      'news.site.com',
      'site.com',
      'com',
    ])
    expect(core.cosmeticSelectors(data, 'news.site.com', null).sort()).toEqual([
      '.local-ad',
      '.news-ad',
      '[data-ad]',
    ])
    expect(core.cosmeticSelectors(data, 'news.site.com', ['.ad-slot', '.other'])).toEqual(['.ad-slot'])
    expect(core.cosmeticSelectors(data, 'quiet.com', null)).toEqual([])
    expect(core.cosmeticSelectors(data, 'quiet.com', ['#top-ad'])).toEqual([])
    expect(core.cosmeticSelectors(data, 'plain.org', null).sort()).toEqual(['.everywhere', '[data-ad]'])
    expect(core.hidingCss(['.a', '#b'])).toBe('.a{display:none!important}\n#b{display:none!important}')
  })

  it('textos do popup e do indicador em português, espanhol e inglês, com as mesmas chaves', () => {
    const keys = Object.keys(core.words('en-US')).sort()
    expect(Object.keys(core.words('pt-BR')).sort()).toEqual(keys)
    expect(Object.keys(core.words('es-ES')).sort()).toEqual(keys)
    expect(core.words('pt-PT').adblock).toBe('Bloquear anúncios')
    expect(core.words('es').adblock).toBe('Bloquear anuncios')
    expect(core.words('es-MX').offline).toBe('Sin conexión')
    expect(core.words('fr-FR').adblock).toBe('Block ads')
    expect(['pt-BR', 'es-419', 'en-GB', ''].map((language) => core.locale(language))).toEqual([
      'pt',
      'es',
      'en',
      'en',
    ])
    expect(core.formatMbps(23.44, 'es-ES')).toBe('23,4')
  })
})
