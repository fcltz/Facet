import { describe, expect, it } from 'vitest'
import { mergeCookies, parseCookies, serializeCookies, validateCookie } from '@shared/cookies/formats'
import type { BrowserCookie } from '@shared/schemas/cookies'

const NOW = Date.UTC(2026, 10, 26) // 26/11/2026
const FUTURE = NOW / 1000 + 86400 * 30

const base = (patch: Partial<BrowserCookie> = {}): BrowserCookie => ({
  name: 'sid',
  value: 'abc',
  domain: '.example.com',
  path: '/',
  expires: FUTURE,
  httpOnly: false,
  secure: false,
  sameSite: null,
  partitionKey: null,
  ...patch,
})

function ok(text: string) {
  const outcome = parseCookies(text, NOW)
  if (!outcome.ok) throw new Error(`falhou: ${outcome.error}`)
  return outcome
}

describe('leitura de cookies', () => {
  it('EditThisCookie/Cookie-Editor: hostOnly, sessão, SameSite e partição', () => {
    const outcome = ok(
      JSON.stringify([
        {
          domain: '.example.com',
          expirationDate: FUTURE + 0.5,
          hostOnly: false,
          httpOnly: true,
          name: 'a',
          path: '/',
          sameSite: 'no_restriction',
          secure: true,
          session: false,
          storeId: '0',
          value: '1',
        },
        {
          domain: 'www.example.com',
          hostOnly: true,
          name: 'b',
          path: '/app',
          sameSite: 'lax',
          secure: false,
          session: true,
          value: 2,
        },
        { domain: 'example.com', hostOnly: false, name: 'c', sameSite: 'unspecified', value: '3' },
        {
          domain: 'embed.example.org',
          hostOnly: true,
          name: 'd',
          secure: true,
          sameSite: 'no_restriction',
          value: '4',
          partitionKey: { topLevelSite: 'https://example.net', hasCrossSiteAncestor: true },
        },
      ]),
    )
    expect(outcome.format).toBe('editThisCookie')
    expect(outcome.rejected).toEqual([])
    const [a, b, c, d] = outcome.cookies
    expect(a).toEqual(
      base({ name: 'a', value: '1', expires: FUTURE + 0.5, httpOnly: true, secure: true, sameSite: 'None' }),
    )
    expect(b).toMatchObject({
      domain: 'www.example.com',
      path: '/app',
      expires: null,
      sameSite: 'Lax',
      value: '2',
    })
    expect(c).toMatchObject({ domain: '.example.com', path: '/', sameSite: null, expires: null })
    expect(d?.partitionKey).toEqual({ topLevelSite: 'https://example.net', hasCrossSiteAncestor: true })
  })

  it('CDP/Puppeteer e Playwright storageState', () => {
    const cdp = ok(
      JSON.stringify([
        {
          name: 'x',
          value: 'y',
          domain: 'site.test',
          path: '/',
          expires: -1,
          sameSite: 'Strict',
          secure: true,
          partitionKey: 'https://top.test',
        },
      ]),
    )
    expect(cdp.format).toBe('cdp')
    expect(cdp.cookies[0]).toMatchObject({
      domain: 'site.test',
      expires: null,
      sameSite: 'Strict',
      partitionKey: { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true },
    })
    const playwright = ok(
      JSON.stringify({
        cookies: [
          {
            name: 'p',
            value: 'q',
            domain: '.site.test',
            path: '/',
            expires: FUTURE,
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      }),
    )
    expect(playwright.format).toBe('playwright')
    expect(playwright.cookies[0]).toEqual(
      base({ name: 'p', value: 'q', domain: '.site.test', httpOnly: true, sameSite: 'Lax' }),
    )
  })

  it('Netscape: #HttpOnly_, subdomínios, sessão, comentários, CRLF e BOM', () => {
    const text = [
      '\uFEFF# Netscape HTTP Cookie File',
      '# comentário',
      '',
      `.example.com\tTRUE\t/\tTRUE\t${FUTURE}\tdomain\tv1`,
      `#HttpOnly_www.example.com\tFALSE\t/x\tFALSE\t0\thost\tv 2`,
      'linha quebrada',
    ].join('\r\n')
    const outcome = ok(text)
    expect(outcome.format).toBe('netscape')
    expect(outcome.cookies).toEqual([
      base({ name: 'domain', value: 'v1', secure: true }),
      base({
        name: 'host',
        value: 'v 2',
        domain: 'www.example.com',
        path: '/x',
        expires: null,
        httpOnly: true,
      }),
    ])
    expect(outcome.rejected).toEqual([{ position: 6, reason: 'invalidFormat', name: null, domain: null }])
  })

  it('separa vencidos e repetidos (vale o último)', () => {
    const outcome = ok(
      JSON.stringify([
        { name: 'old', value: '1', domain: 'a.test', path: '/', expires: NOW / 1000 - 10 },
        { name: 'dup', value: 'first', domain: 'a.test', path: '/', expires: FUTURE },
        { name: 'dup', value: 'second', domain: 'a.test', path: '/', expires: FUTURE },
      ]),
    )
    expect(outcome.expired).toBe(1)
    expect(outcome.duplicates).toBe(1)
    expect(outcome.cookies.map((cookie) => cookie.value)).toEqual(['second'])
  })

  it('erros de entrada', () => {
    expect(parseCookies('   ', NOW)).toEqual({ ok: false, error: 'empty' })
    expect(parseCookies('[{', NOW)).toEqual({ ok: false, error: 'invalidJson' })
    expect(parseCookies('{"a":1}', NOW)).toEqual({ ok: false, error: 'unknownFormat' })
    expect(parseCookies('isto não é cookie', NOW)).toEqual({ ok: false, error: 'unknownFormat' })
    expect(parseCookies('x'.repeat(20 * 1024 * 1024 + 1), NOW)).toEqual({ ok: false, error: 'tooLarge' })
  })
})

describe('validação de cookies (regras do Chromium)', () => {
  it.each([
    [{ name: 'a=b' }, 'invalidName'],
    [{ name: '', value: '' }, 'invalidName'],
    [{ value: 'a;b' }, 'invalidValue'],
    [{ value: 'x'.repeat(4096) }, 'tooLarge'],
    [{ domain: 'exa mple.com' }, 'invalidDomain'],
    [{ domain: '.127.0.0.1' }, 'invalidDomain'],
    [{ path: 'sem-barra' }, 'invalidPath'],
    [{ name: '__Secure-x' }, 'securePrefix'],
    [{ name: '__Host-x', secure: true }, 'hostPrefix'],
    [{ name: '__host-x', secure: true, domain: 'example.com', path: '/a' }, 'hostPrefix'],
    [{ sameSite: 'None' as const }, 'sameSiteNoneInsecure'],
    [
      { partitionKey: { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true } },
      'partitionedInsecure',
    ],
    [
      { secure: true, partitionKey: { topLevelSite: 'top.test', hasCrossSiteAncestor: true } },
      'invalidPartition',
    ],
  ] as const)('%o → %s', (patch, reason) => {
    expect(validateCookie(base(patch as Partial<BrowserCookie>))).toBe(reason)
  })

  it('aceita host, IP, localhost e __Host- correto', () => {
    expect(validateCookie(base({ domain: '127.0.0.1' }))).toBeNull()
    expect(validateCookie(base({ domain: 'localhost' }))).toBeNull()
    expect(
      validateCookie(base({ name: '__Host-ok', secure: true, domain: 'example.com', path: '/' })),
    ).toBeNull()
  })

  it('aponta a posição e o motivo dos recusados na leitura', () => {
    const outcome = ok(
      JSON.stringify([{ name: '__Secure-a', value: '1', domain: 'a.test' }, { value: 'sem nome' }]),
    )
    expect(outcome.rejected).toEqual([
      { position: 1, reason: 'securePrefix', name: '__Secure-a', domain: 'a.test' },
      { position: 2, reason: 'invalidFormat', name: null, domain: null },
    ])
  })
})

describe('escrita de cookies', () => {
  const cookies: BrowserCookie[] = [
    base({ name: 'z', httpOnly: true, secure: true, sameSite: 'None' }),
    base({ name: 'host', domain: 'www.example.com', expires: null, sameSite: 'Strict' }),
    base({
      name: 'chips',
      domain: 'embed.test',
      secure: true,
      sameSite: 'None',
      partitionKey: { topLevelSite: 'https://top.test', hasCrossSiteAncestor: true },
    }),
  ]

  it('JSON compatível com EditThisCookie volta igual', () => {
    const json = serializeCookies(cookies, 'json')
    const items = JSON.parse(json) as Record<string, unknown>[]
    expect(items.find((item) => item.name === 'host')).toMatchObject({
      hostOnly: true,
      session: true,
      sameSite: 'strict',
      storeId: '0',
    })
    expect(items.find((item) => item.name === 'z')).toMatchObject({
      hostOnly: false,
      sameSite: 'no_restriction',
      expirationDate: FUTURE,
    })
    const back = ok(json)
    expect(back.format).toBe('editThisCookie')
    expect(mergeCookies([], back.cookies).sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      [...cookies].sort((a, b) => a.name.localeCompare(b.name)),
    )
  })

  it('Netscape volta igual, sem SameSite e sem partição', () => {
    const text = serializeCookies(cookies, 'netscape')
    expect(text.startsWith('# Netscape HTTP Cookie File')).toBe(true)
    expect(text).toContain(`#HttpOnly_.example.com\tTRUE\t/\tTRUE\t${Math.floor(FUTURE)}\tz\tabc`)
    const back = ok(text)
    expect(back.cookies.find((cookie) => cookie.name === 'host')).toEqual({ ...cookies[1], sameSite: null })
    expect(back.cookies.find((cookie) => cookie.name === 'chips')?.partitionKey).toBeNull()
  })

  it('mergeCookies: o novo substitui a mesma identidade', () => {
    const merged = mergeCookies([base({ value: 'old' }), base({ name: 'other' })], [base({ value: 'new' })])
    expect(merged.map((cookie) => `${cookie.name}=${cookie.value}`).sort()).toEqual(['other=abc', 'sid=new'])
  })
})
