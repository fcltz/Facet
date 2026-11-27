import { describe, expect, it } from 'vitest'

interface Rule {
  id?: number
  priority: number
  action: { type: string }
  condition: Record<string, unknown>
}
interface Compiler {
  preprocess(text: string, environment?: Record<string, boolean>): string[]
  parseNetworkFilter(line: string): unknown
  toRule(filter: unknown): { rule?: Rule; hostOnly?: string; skip?: string }
  parseCosmeticFilter(line: string): {
    skip?: string
    exception?: boolean
    included?: string[]
    excluded?: string[]
    selector?: string
  } | null
  genericToken(selector: string): string | null
  compile(
    lists: { id: string; ruleset: string; format: string; text: string }[],
    options?: { domainsPerRule?: number },
  ): {
    rulesets: Record<string, Rule[]>
    cosmetic: {
      highly: string[]
      lowly: Record<string, string[]>
      specific: Record<string, string[]>
      exceptions: Record<string, string[]>
      generichide: string[]
      specifichide: string[]
    }
    stats: { network: number; cosmetic: number; skipped: Record<string, number> }
  }
}

// módulo ESM do script de build (sem tipos): carregado pelo caminho em variável
const modulePath = '../../scripts/filters/compile.mjs'
const compiler = (await import(modulePath)) as Compiler
const rule = (line: string) => compiler.toRule(compiler.parseNetworkFilter(line))

describe('compilador de filtros (sintaxe do uBlock Origin → declarativeNetRequest)', () => {
  it('aplica !#if/!#else/!#endif no ambiente de um bloqueador MV3 no Chromium', () => {
    const text = [
      'a',
      '!#if env_firefox',
      'firefox',
      '!#else',
      'outros',
      '!#endif',
      '!#if env_chromium && !env_mobile',
      'chromium',
      '!#if cap_html_filtering',
      'html',
      '!#endif',
      '!#endif',
      '!#if (ext_ublock || adguard)',
      'ublock',
      '!#endif',
    ].join('\n')
    expect(compiler.preprocess(text)).toEqual(['a', 'outros', 'chromium', 'ublock'])
  })

  it('host inteiro vira requestDomains; prefixos e caminhos viram urlFilter', () => {
    expect(rule('||doubleclick.net^')).toEqual({
      hostOnly: 'doubleclick.net',
      rule: { priority: 1, action: { type: 'block' }, condition: {} },
    })
    expect(rule('||get-me-wow.').rule?.condition).toEqual({ urlFilter: '||get-me-wow.' })
    expect(rule('||142.91.159.').rule?.condition).toEqual({ urlFilter: '||142.91.159.' })
    expect(rule('/ads/banner$script,third-party').rule).toEqual({
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: '/ads/banner', domainType: 'thirdParty', resourceTypes: ['script'] },
    })
    expect(rule('||example.com/track*$xhr,1p').rule?.condition).toEqual({
      urlFilter: '||example.com/track',
      domainType: 'firstParty',
      resourceTypes: ['xmlhttprequest'],
    })
    expect(rule('|https://ads.example.com/$image,match-case').rule?.condition).toEqual({
      urlFilter: '|https://ads.example.com/',
      isUrlFilterCaseSensitive: true,
      resourceTypes: ['image'],
    })
  })

  it('exceções, página inteira, $important e tipos negados', () => {
    expect(rule('@@||cdn.example.com/ads.js$script').rule).toEqual({
      priority: 2,
      action: { type: 'allow' },
      condition: { urlFilter: '||cdn.example.com/ads.js', resourceTypes: ['script'] },
    })
    expect(rule('@@||example.com^$document')).toEqual({
      hostOnly: 'example.com',
      rule: {
        priority: 2,
        action: { type: 'allowAllRequests' },
        condition: { resourceTypes: ['main_frame', 'sub_frame'] },
      },
    })
    expect(rule('||track.example^$important').rule?.priority).toBe(3)
    expect(rule('||ads.example^$~image,~script').rule?.condition).toEqual({
      excludedResourceTypes: ['image', 'script'],
    })
    expect(rule('||malware.example^$all').rule?.condition.resourceTypes).toContain('main_frame')
  })

  it('$domain, $denyallow, $to e $method; entidades e regex ficam de fora', () => {
    expect(rule('||ads.example.com^$script,domain=foo.com|~bar.foo.com').rule?.condition).toEqual({
      initiatorDomains: ['foo.com'],
      excludedInitiatorDomains: ['bar.foo.com'],
      resourceTypes: ['script'],
    })
    expect(rule('*$script,3p,denyallow=cdn.com|static.com,domain=site.com').rule?.condition).toEqual({
      domainType: 'thirdParty',
      initiatorDomains: ['site.com'],
      excludedRequestDomains: ['cdn.com', 'static.com'],
      resourceTypes: ['script'],
    })
    expect(rule('*$script,denyallow=cdn.com')).toEqual({ skip: 'denyallow-without-domain' })
    expect(rule('/collect$to=analytics.com|~cdn.analytics.com,method=post').rule?.condition).toEqual({
      urlFilter: '/collect',
      requestDomains: ['analytics.com'],
      excludedRequestDomains: ['cdn.analytics.com'],
      requestMethods: ['post'],
    })
    expect(rule('||ads.com^$domain=google.*')).toEqual({ skip: 'entity-domain' })
    expect(rule('/^https?:\\/\\/ads\\./$script')).toEqual({ skip: 'regex' })
    expect(rule('*$image,3p')).toEqual({ skip: 'too-broad' })
  })

  it('opções que alteram a resposta ou exigem scripts ficam de fora', () => {
    for (const [line, reason] of <[string, string][]>[
      ['||site.com/ad.js$script,redirect=noop.js', 'option-redirect'],
      ['||site.com^$removeparam=utm_source', 'option-removeparam'],
      ['||site.com^$csp=script-src none', 'option-csp'],
      ['||popup.com^$popup', 'option-popup'],
      ['||site.com^$frobnicate', 'option-unknown'],
    ])
      expect(compiler.parseNetworkFilter(line), line).toMatchObject({ skip: reason })
  })

  it('cosméticos: específicos, genéricos, exceções; scriptlets e procedurais ficam de fora', () => {
    expect(compiler.parseCosmeticFilter('example.com,~sub.example.com##.ad-box')).toEqual({
      exception: false,
      included: ['example.com'],
      excluded: ['sub.example.com'],
      selector: '.ad-box',
    })
    expect(compiler.parseCosmeticFilter('###ad-top')).toEqual({
      exception: false,
      included: [],
      excluded: [],
      selector: '#ad-top',
    })
    expect(compiler.parseCosmeticFilter('example.com#@#.ad-box')).toMatchObject({ exception: true })
    expect(compiler.parseCosmeticFilter('example.com##+js(aopr, ads)')).toEqual({ skip: 'scriptlet' })
    expect(compiler.parseCosmeticFilter('example.com##.x:has-text(Ad)')).toEqual({ skip: 'procedural' })
    expect(compiler.parseCosmeticFilter('example.com#?#.x:-abp-has(.y)')).toEqual({ skip: 'extended' })
    expect(compiler.parseCosmeticFilter('example.com##^script:has-text(ad)')).toEqual({ skip: 'html' })
    expect(compiler.parseCosmeticFilter('google.*##.ad')).toEqual({ skip: 'entity-domain' })
    expect(compiler.parseCosmeticFilter('||site.com/#anchor')).toBeNull()
    // :has() é CSS nativo
    expect(compiler.parseCosmeticFilter('##div:has(> .sponsor)')).toMatchObject({
      selector: 'div:has(> .sponsor)',
    })
  })

  it('token genérico: classe ou id do último composto (o elemento escondido precisa tê-lo)', () => {
    expect(compiler.genericToken('.ad-banner')).toBe('.ad-banner')
    expect(compiler.genericToken('#ad_box')).toBe('#ad_box')
    expect(compiler.genericToken('div.wrapper > a.sponsored')).toBe('.sponsored')
    expect(compiler.genericToken('.a:not(.b)')).toBe('.a')
    expect(compiler.genericToken('a[href*=".com/ads"]')).toBeNull()
    expect(compiler.genericToken('[data-ad-slot]')).toBeNull()
  })

  it('compila listas: badfilter, agrupamento por host, hosts/domínios e dados cosméticos', () => {
    const result = compiler.compile(
      [
        {
          id: 'a',
          ruleset: 'ads',
          format: 'filters',
          text: [
            '! comentário',
            '[Adblock Plus 2.0]',
            '||ads1.com^',
            '||ads2.com^',
            '||ads3.com^',
            '||ads2.com^',
            '/banner.$image',
            '/banner.$image',
            '||removed.com^',
            '||removed.com^$badfilter',
            '@@||ok.com^$generichide',
            '@@||ok2.com^$elemhide',
            '##.ad-slot',
            '##[data-ad]',
            '##.kept',
            '#@#.kept',
            'site.com##.local-ad',
            'site.com#@#.ad-slot',
            '~other.com##.everywhere-but-other',
            'site.com##+js(nobab)',
          ].join('\n'),
        },
        {
          id: 'h',
          ruleset: 'ads',
          format: 'hosts',
          text: '# hosts\n127.0.0.1 tracker.net\n0.0.0.0 localhost\n',
        },
        { id: 'd', ruleset: 'malware', format: 'domains', text: '# malware\nevil.example\n' },
      ],
      { domainsPerRule: 2 },
    )
    const ads = result.rulesets.ads ?? []
    expect(ads.map((item) => item.id)).toEqual(ads.map((_, index) => index + 1))
    // 4 hosts em blocos de 2; a regra de caminho uma vez só
    const hostRules = ads.filter((item) => Array.isArray(item.condition.requestDomains))
    expect(hostRules.map((item) => item.condition.requestDomains)).toEqual([
      ['ads1.com', 'ads2.com'],
      ['ads3.com', 'tracker.net'],
    ])
    expect(ads.filter((item) => item.condition.urlFilter === '/banner.')).toHaveLength(1)
    expect(JSON.stringify(ads)).not.toContain('removed.com')
    expect(result.rulesets.malware).toEqual([
      {
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: {
          resourceTypes: expect.arrayContaining(['main_frame', 'script']),
          requestDomains: ['evil.example'],
        },
      },
    ])
    expect(result.cosmetic).toEqual({
      highly: ['[data-ad]'],
      lowly: { '.ad-slot': ['.ad-slot'], '.everywhere-but-other': ['.everywhere-but-other'] },
      specific: { 'site.com': ['.local-ad'] },
      exceptions: { 'other.com': ['.everywhere-but-other'], 'site.com': ['.ad-slot'] },
      generichide: ['ok.com', 'ok2.com'],
      specifichide: ['ok2.com'],
    })
    expect(result.stats.skipped).toMatchObject({ badfilter: 1, 'cosmetic-scriptlet': 1 })
  })
})
