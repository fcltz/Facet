import { describe, expect, it } from 'vitest'
import { classifyProxyLog } from '@main/proxy/forwarder'
import { GEO_PROVIDERS, normalizeGeo, parseTrace } from '@main/proxy/geoip/providers'
import {
  displayProxy,
  parsePastedProxy,
  parseProxyLine,
  parseProxyList,
  proxyKey,
} from '@shared/proxy/parser'
import { describeUpstream, redactSecrets, upstreamUrl } from '@main/proxy/upstream'
import { sameFingerprint, syncFingerprint } from '@main/services/geo-sync'
import { acceptLanguagesFrom, languagesForCountry } from '@shared/data/country-locales'
import { createDefaultFingerprint } from '@shared/schemas/fingerprint'
import type { ProxyGeo } from '@shared/schemas/proxy'

function ok(line: string, type: 'http' | 'https' | 'socks5' = 'http') {
  const result = parseProxyLine(line, type)
  if (!result.ok) throw new Error(`esperava sucesso para ${line}: ${result.error}`)
  return result.proxy
}

function error(line: string): string {
  const result = parseProxyLine(line, 'http')
  if (result.ok) throw new Error(`esperava erro para ${line}`)
  return result.error
}

describe('parser de proxies', () => {
  it('aceita os formatos da especificação', () => {
    expect(ok('1.2.3.4:8080')).toEqual({
      type: 'http',
      host: '1.2.3.4',
      port: 8080,
      username: '',
      password: '',
    })
    expect(ok('1.2.3.4:8080:user:pass')).toMatchObject({
      host: '1.2.3.4',
      username: 'user',
      password: 'pass',
    })
    expect(ok('user:pass@proxy.example.com:3128')).toMatchObject({
      host: 'proxy.example.com',
      port: 3128,
      username: 'user',
      password: 'pass',
    })
    expect(ok('socks5://user:pass@1.2.3.4:1080')).toMatchObject({ type: 'socks5', username: 'user' })
    expect(ok('socks5h://5.6.7.8:1080')).toMatchObject({ type: 'socks5', host: '5.6.7.8' })
    expect(ok('https://proxy.example.com:443')).toMatchObject({ type: 'https', port: 443 })
  })

  it('aceita user:pass:host:port, host:port@user:pass e senha com ":"', () => {
    expect(ok('alice:secret:proxy.example.com:8000')).toMatchObject({
      host: 'proxy.example.com',
      username: 'alice',
      password: 'secret',
    })
    expect(ok('proxy.example.com:8000@alice:secret')).toMatchObject({
      host: 'proxy.example.com',
      username: 'alice',
    })
    expect(ok('proxy.example.com:8000:alice:pa:ss')).toMatchObject({ username: 'alice', password: 'pa:ss' })
    // "@" na senha não confunde com user:pass@host:port
    expect(ok('1.2.3.4:8080:alice:p@ss:w/rd')).toMatchObject({
      host: '1.2.3.4',
      username: 'alice',
      password: 'p@ss:w/rd',
    })
    expect(ok('alice:p@ss@1.2.3.4:8080')).toMatchObject({ username: 'alice', password: 'p@ss' })
  })

  it('resolve a ambiguidade pelo lado com host forte e recusa empate', () => {
    // "admin:1234" também parece host:porta, mas 1.2.3.4 é claramente o host
    expect(ok('1.2.3.4:8080:admin:1234')).toMatchObject({
      host: '1.2.3.4',
      username: 'admin',
      password: '1234',
    })
    expect(error('alpha:8080:beta:9090')).toBe('ambiguous')
  })

  it('decodifica credenciais da URL e aceita IPv6 entre colchetes', () => {
    expect(ok('http://us%40er:p%3Ass%2Fw@proxy.example.com:80')).toMatchObject({
      username: 'us@er',
      password: 'p:ss/w',
    })
    expect(ok('[2001:db8::1]:8080')).toMatchObject({ host: '2001:db8::1', port: 8080 })
    expect(ok('[2001:db8::1]:8080:user:pass')).toMatchObject({ host: '2001:db8::1', username: 'user' })
  })

  it('aponta erros por motivo', () => {
    expect(error('socks4://1.2.3.4:1080')).toBe('unsupportedType')
    expect(error('1.2.3.4:99999')).toBe('invalidPort')
    expect(error('999.1.1.1:80')).toBe('invalidHost')
    expect(error('só texto')).toBe('invalidFormat')
    expect(error(':senha@1.2.3.4:80')).toBe('passwordWithoutUser')
    expect(error(`${'u'.repeat(600)}:p@1.2.3.4:80`)).toBe('credentialTooLong')
  })

  it('marca duplicados na lista, ignora comentários e respeita o limite de linhas', () => {
    const { lines, truncated } = parseProxyList(
      ['# comentário', '1.2.3.4:80', '', 'HTTP://1.2.3.4:80', '1.2.3.4:80:user:pass', 'lixo'].join('\n'),
      'http',
    )
    expect(lines.map((l) => [l.line, l.result.ok, l.duplicateInList])).toEqual([
      [2, true, false],
      [4, true, true],
      [5, true, false],
      [6, false, false],
    ])
    expect(truncated).toBe(false)
    expect(parseProxyList('1.1.1.1:1\n1.1.1.2:1\n1.1.1.3:1', 'http', 2)).toMatchObject({ truncated: true })
  })

  it('nunca exibe a senha', () => {
    const { lines } = parseProxyList(
      [
        '1.2.3.4:80:user:segredo',
        '1.2.3.4:99999:user:segredo',
        'user:segredo:999.1.1.1:80',
        'u:segredo@x',
      ].join('\n'),
      'http',
    )
    expect(lines.map((l) => l.result.ok)).toEqual([true, false, false, false])
    expect(lines.map((l) => l.display).join('\n')).not.toContain('segredo')
    expect(displayProxy(ok('user:segredo@1.2.3.4:80'))).toBe('http://user:••••@1.2.3.4:80')
  })

  it('a chave de duplicidade ignora maiúsculas no host e diferencia usuário', () => {
    expect(proxyKey(ok('PROXY.example.com:80'))).toBe(proxyKey(ok('proxy.example.com:80')))
    expect(proxyKey(ok('a:1@proxy.example.com:80'))).not.toBe(proxyKey(ok('b:1@proxy.example.com:80')))
  })
})

describe('URL do proxy remoto', () => {
  it('usa socks5h, codifica credenciais e põe IPv6 entre colchetes', () => {
    expect(
      upstreamUrl({ type: 'socks5', host: '2001:db8::1', port: 1080, username: 'us@r', password: 'p:ss/w' }),
    ).toBe('socks5h://us%40r:p%3Ass%2Fw@[2001:db8::1]:1080')
    expect(upstreamUrl({ type: 'http', host: '1.2.3.4', port: 80, username: '', password: null })).toBe(
      'http://1.2.3.4:80',
    )
    expect(describeUpstream({ type: 'https', host: 'proxy.example.com', port: 443 })).toBe(
      'https://proxy.example.com:443',
    )
  })

  it('remove credenciais e segredos de textos de log', () => {
    const text = 'falhou http://user:segredo@1.2.3.4:80 com segredo e p%40ss'
    const clean = redactSecrets(text, ['segredo', 'p@ss'])
    expect(clean).not.toContain('segredo')
    expect(clean).not.toContain('p%40ss')
    expect(clean).toContain('http://***@1.2.3.4:80')
  })
})

describe('falhas do proxy remoto vistas pelo proxy local', () => {
  it('conta conexão recusada, senha recusada e falha SOCKS', () => {
    expect(
      classifyProxyLog(
        'Failed to connect to upstream proxy: Error: connect ECONNREFUSED 127.0.0.1:9\n    at x',
      ),
    ).toBe('Falha ao conectar ao proxy: connect ECONNREFUSED 127.0.0.1:9')
    expect(classifyProxyLog('Failed to authenticate upstream proxy: 407')).toContain('HTTP 407')
    expect(classifyProxyLog('Failed to authenticate upstream proxy: 403')).toContain('HTTP 403')
    expect(
      classifyProxyLog(
        'Failed to connect to upstream SOCKS proxy SocksClientError: Socks5 Authentication failed',
      ),
    ).toBe('O proxy SOCKS5 recusou o usuário ou a senha')
    expect(
      classifyProxyLog(
        'Failed to connect to upstream SOCKS proxy SocksClientError: Proxy connection timed out',
      ),
    ).toBe('Falha no proxy SOCKS5: Proxy connection timed out')
    expect(
      classifyProxyLog('Request failed with error: Error: 407 Proxy Authentication Required\n at y'),
    ).toContain('HTTP 407')
  })

  it('não conta erros do site de destino nem mensagens comuns', () => {
    expect(classifyProxyLog('Failed to authenticate upstream proxy: 502')).toBeNull()
    expect(
      classifyProxyLog(
        'Failed to connect to upstream SOCKS proxy SocksClientError: Socks5 proxy rejected connection - HostUnreachable',
      ),
    ).toBeNull()
    expect(classifyProxyLog('Using chain() => example.com:443')).toBeNull()
    expect(classifyProxyLog('Request failed with error: Error: boom')).toBeNull()
  })
})

describe('geo-IP', () => {
  it('lê cada provedor e normaliza os campos', () => {
    const expected = {
      ip: '203.0.113.7',
      countryCode: 'BR',
      city: 'São Paulo',
      timezone: 'America/Sao_Paulo',
      latitude: -23.55,
      longitude: -46.63,
    }
    expect(
      GEO_PROVIDERS.ipwhois.parse({
        success: true,
        ip: '203.0.113.7',
        country_code: 'BR',
        country: 'Brazil',
        region: 'São Paulo',
        city: 'São Paulo',
        timezone: { id: 'America/Sao_Paulo' },
        latitude: -23.55,
        longitude: -46.63,
      }),
    ).toMatchObject(expected)
    expect(
      GEO_PROVIDERS.geojs.parse({
        ip: '203.0.113.7',
        country_code: 'BR',
        city: 'São Paulo',
        timezone: 'America/Sao_Paulo',
        latitude: '-23.55',
        longitude: '-46.63',
      }),
    ).toMatchObject(expected)
    expect(
      GEO_PROVIDERS.ipinfo.parse({
        ip: '203.0.113.7',
        country: 'BR',
        city: 'São Paulo',
        timezone: 'America/Sao_Paulo',
        loc: '-23.55,-46.63',
      }),
    ).toMatchObject({ ...expected, countryName: 'Brazil' })
    expect(
      GEO_PROVIDERS.ipapi.parse({
        status: 'success',
        query: '203.0.113.7',
        countryCode: 'BR',
        city: 'São Paulo',
        timezone: 'America/Sao_Paulo',
        lat: -23.55,
        lon: -46.63,
      }),
    ).toMatchObject(expected)
    expect(GEO_PROVIDERS.ipinfo.url('tok en')).toBe('https://ipinfo.io/json?token=tok%20en')
  })

  it('recusa respostas de erro e descarta valores inválidos', () => {
    expect(() => GEO_PROVIDERS.ipwhois.parse({ success: false, message: 'limite' })).toThrow('limite')
    expect(() => GEO_PROVIDERS.ipapi.parse({ status: 'fail', message: 'quota' })).toThrow('quota')
    expect(
      normalizeGeo({
        ip: '1.1.1.1',
        countryCode: 'Brasil',
        timezone: 'Mars/Base',
        latitude: 200,
        longitude: 'x',
      }),
    ).toMatchObject({ countryCode: null, timezone: null, latitude: null, longitude: null })
  })

  it('lê o trace da Cloudflare', () => {
    expect(parseTrace('fl=1\nip=198.51.100.4\nloc=DE\ntls=TLSv1.3\n')).toEqual({
      ip: '198.51.100.4',
      countryCode: 'DE',
    })
    expect(parseTrace('nada')).toEqual({ ip: null, countryCode: null })
  })
})

describe('idiomas por país', () => {
  it('usa o idioma provável do país com exceções de navegador', () => {
    expect(languagesForCountry('BR')).toEqual(['pt-BR', 'pt', 'en-US', 'en'])
    expect(languagesForCountry('de')).toEqual(['de-DE', 'de', 'en-US', 'en'])
    expect(languagesForCountry('US')).toEqual(['en-US', 'en'])
    expect(languagesForCountry('IN')).toEqual(['en-IN', 'en'])
    expect(languagesForCountry('ZZZ')).toBeNull()
  })

  it('monta a lista do navegador a partir das preferências do sistema', () => {
    expect(acceptLanguagesFrom(['pt-BR', 'en-US'])).toEqual(['pt-BR', 'pt', 'en-US', 'en'])
    expect(acceptLanguagesFrom(['en_GB', 'en-GB'])).toEqual(['en-GB', 'en'])
    expect(acceptLanguagesFrom(['@@inválido'])).toEqual(['en-US', 'en'])
  })
})

describe('sincronização do fingerprint com o proxy', () => {
  const host = { timezone: 'America/Sao_Paulo', languages: ['pt-BR', 'pt', 'en-US', 'en'] }
  const tokyo: ProxyGeo = {
    countryCode: 'JP',
    countryName: 'Japan',
    region: 'Tokyo',
    city: 'Tokyo',
    timezone: 'Asia/Tokyo',
    latitude: 35.68,
    longitude: 139.69,
  }

  it('segue o país do proxy só nos campos automáticos', () => {
    const base = createDefaultFingerprint({ os: 'windows', engineMajor: 158, timezone: 'America/Sao_Paulo' })
    const synced = syncFingerprint(base, tokyo, host)
    expect(synced.timezone.id).toBe('Asia/Tokyo')
    expect(synced.languages.list).toEqual(['ja-JP', 'ja', 'en-US', 'en'])
    expect(synced.geolocation).toMatchObject({ latitude: 35.68, longitude: 139.69 })

    const manual = structuredClone(base)
    manual.timezone = { mode: 'manual', id: 'Europe/Lisbon' }
    expect(syncFingerprint(manual, tokyo, host).timezone.id).toBe('Europe/Lisbon')
  })

  it('sem proxy volta para esta máquina; proxy sem país não muda nada', () => {
    const base = syncFingerprint(
      createDefaultFingerprint({ os: 'windows', engineMajor: 158, timezone: 'UTC' }),
      tokyo,
      host,
    )
    const direct = syncFingerprint(base, null, host)
    expect(direct.timezone.id).toBe('America/Sao_Paulo')
    expect(direct.languages.list).toEqual(host.languages)
    expect(direct.geolocation).toMatchObject({ latitude: null, longitude: null })
    const unchecked = syncFingerprint(base, { ...tokyo, countryCode: null }, host)
    expect(sameFingerprint(unchecked, base)).toBe(true)
  })
})

describe('linha de proxy colada no formulário', () => {
  it('separa host, porta, usuário e senha de qualquer formato da importação', () => {
    const expected = {
      type: 'http',
      host: 'proxy.exemplo.com',
      port: 824,
      username: 'usuario123',
      password: 'senha456',
    }
    for (const line of [
      'proxy.exemplo.com:824:usuario123:senha456',
      '  usuario123:senha456@proxy.exemplo.com:824  ',
      'usuario123:senha456:proxy.exemplo.com:824',
      'proxy.exemplo.com:824@usuario123:senha456',
    ]) {
      for (const field of ['address', 'credential'] as const)
        expect(parsePastedProxy(line, 'http', field), `${line} (${field})`).toEqual({
          proxy: expected,
          typed: false,
        })
    }
    // sem tipo na linha vale o tipo escolhido; com tipo, ele também é preenchido
    expect(parsePastedProxy('proxy.exemplo.com:824:u:p', 'socks5', 'address')?.proxy.type).toBe('socks5')
    expect(parsePastedProxy('socks5://u:p%40s@proxy.exemplo.com:1080', 'http', 'credential')).toEqual({
      proxy: { type: 'socks5', host: 'proxy.exemplo.com', port: 1080, username: 'u', password: 'p@s' },
      typed: true,
    })
  })

  it('host:porta só separa nos campos de endereço; valores comuns colam normalmente', () => {
    expect(parsePastedProxy('1.2.3.4:8080', 'http', 'address')).toEqual({
      proxy: { type: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' },
      typed: false,
    })
    // uma senha ou usuário com ":" não é confundido com proxy
    expect(parsePastedProxy('abc.com:8080', 'http', 'credential')).toBeNull()
    expect(parsePastedProxy('senha:com:dois', 'http', 'credential')).toBeNull()
    for (const value of ['proxy.exemplo.com', '8080', 'senha', '', '   '])
      expect(parsePastedProxy(value, 'http', 'address'), value).toBeNull()
    // várias linhas ficam para a importação
    expect(parsePastedProxy('a.com:1:u:p\nb.com:2:u:p', 'http', 'address')).toBeNull()
  })
})
