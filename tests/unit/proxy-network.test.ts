import http from 'node:http'
import net from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { silentLogger } from '@main/logger'
import { CheckLimiter, launchBlocker, ProxyChecker } from '@main/proxy/checker'
import { ProxyForwarder } from '@main/proxy/forwarder'
import { GeoIpClient } from '@main/proxy/geoip'
import { GEO_PROVIDERS, type GeoProvider, type GeoProviderId } from '@main/proxy/geoip/providers'
import { isFatalProxyError, requestViaProxy } from '@main/proxy/http-via-proxy'
import { ForwarderPool } from '@main/proxy/pool'
import { normalizeIp, RealIpProbe } from '@main/proxy/real-ip'
import { rotateIp } from '@main/proxy/rotate'
import { upstreamUrl, type UpstreamProxy } from '@main/proxy/upstream'
import {
  FACET_EXTENSION_ID,
  FACET_EXTENSION_ORIGIN,
  FACET_USAGE_HEADER,
  FACET_USAGE_URL,
} from '@shared/facet-extension'
import { AppError } from '@shared/ipc/result'
import type { ProxyCheckOutcome } from '@shared/schemas/proxy'
import {
  blackHole,
  fakeGeoServer,
  fakeRemoteProxy,
  fakeSocksProxy,
  fakeStatusProxy,
  freePort,
  SAO_PAULO,
  type Closable,
} from '../helpers/fake-network'

const PASSWORD = 'p@ss:w/rd'
const cleanups: (() => Promise<unknown> | unknown)[] = []
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

function track<T extends Closable | ProxyForwarder>(value: T): T {
  cleanups.push(() => value.close())
  return value
}

async function forwarder(proxy: UpstreamProxy): Promise<ProxyForwarder> {
  return track(await ProxyForwarder.open({ upstreamUrl: upstreamUrl(proxy), logger: silentLogger }))
}

function localProviders(url: string): Record<GeoProviderId, GeoProvider> {
  const local = (provider: GeoProvider): GeoProvider => ({ ...provider, url: () => url })
  return {
    ipwhois: local(GEO_PROVIDERS.ipwhois),
    geojs: local(GEO_PROVIDERS.geojs),
    ipinfo: local(GEO_PROVIDERS.ipinfo),
    ipapi: local(GEO_PROVIDERS.ipapi),
  }
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('esperava falha')
}

/** Abre um túnel CONNECT pelo proxy local e devolve o socket já conectado ao destino. */
async function tunnel(proxyPort: number, authority: string): Promise<net.Socket> {
  const socket = net.connect(proxyPort, '127.0.0.1')
  cleanups.push(() => socket.destroy())
  await new Promise<void>((done, fail) => {
    socket.once('error', fail)
    socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    let head = ''
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1')
      if (!head.includes('\r\n\r\n')) return
      socket.removeListener('data', onData)
      if (head.startsWith('HTTP/1.1 200')) done()
      else fail(new Error(head.split('\r\n')[0]))
    }
    socket.on('data', onData)
  })
  return socket
}

/** GET por um proxy HTTP com cabeçalhos escolhidos (o Origin de quem pede). */
function viaProxy(
  port: number,
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: url,
        headers: { host: target.host, ...headers },
        agent: false,
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (body += chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, body, headers: response.headers }),
        )
      },
    )
    request.on('error', reject)
    request.setTimeout(5000, () => request.destroy(new Error('timeout')))
    request.end()
  })
}

describe('proxy local (forwarder)', () => {
  it('encadeia até o proxy remoto autenticado com senha que tem caracteres especiais', async () => {
    const geo = track(await fakeGeoServer())
    const remote = track(await fakeRemoteProxy({ username: 'user', password: PASSWORD }))
    const local = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: 'user',
      password: PASSWORD,
    })
    const response = await requestViaProxy(local.port, geo.traceUrl, { timeoutMs: 5000 })
    expect(response.status).toBe(200)
    expect(response.body).toContain(`ip=${SAO_PAULO.ip}`)
    expect(remote.lastAuth).toEqual({ username: 'user', password: PASSWORD })
    expect(remote.seen).toContain(`127.0.0.1:${geo.port}`)
    expect(local.health().failures).toBe(0)
  })

  it('senha recusada vira PROXY_AUTH_FAILED e conta a falha sem expor a senha', async () => {
    const remote = track(await fakeRemoteProxy({ username: 'user', password: 'certa' }))
    const local = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: 'user',
      password: 'errada-123',
    })
    const error = await rejection(requestViaProxy(local.port, 'https://127.0.0.1:1/', { timeoutMs: 5000 }))
    expect(error.code).toBe('PROXY_AUTH_FAILED')
    expect(isFatalProxyError(error)).toBe(true)
    await vi.waitFor(() => expect(local.health().failures).toBeGreaterThan(0))
    expect(local.health().lastError).toContain('407')
    expect(JSON.stringify(local.health())).not.toContain('errada-123')
  })

  it('proxy fora do ar vira PROXY_UNREACHABLE (fatal) e conta a falha', async () => {
    const dead = await freePort()
    const local = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: dead,
      username: '',
      password: null,
    })
    const error = await rejection(requestViaProxy(local.port, 'https://127.0.0.1:1/', { timeoutMs: 5000 }))
    expect(error.code).toBe('PROXY_UNREACHABLE')
    expect(isFatalProxyError(error)).toBe(true)
    await vi.waitFor(() => expect(local.health().failures).toBe(1))
    expect(local.health().lastError).toContain('ECONNREFUSED')
  })

  it('proxy que não responde vira PROXY_TIMEOUT', async () => {
    const hole = track(await blackHole())
    const local = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: hole.port,
      username: '',
      password: null,
    })
    const error = await rejection(requestViaProxy(local.port, 'https://127.0.0.1:1/', { timeoutMs: 400 }))
    expect(error.code).toBe('PROXY_TIMEOUT')
  })

  it('SOCKS5 resolve o nome no proxy remoto (socks5h), com usuário e senha', async () => {
    const geo = track(await fakeGeoServer())
    const socks = track(await fakeSocksProxy({ username: 'u1', password: PASSWORD }))
    const local = await forwarder({
      type: 'socks5',
      host: '127.0.0.1',
      port: socks.port,
      username: 'u1',
      password: PASSWORD,
    })
    // ".test" não existe no DNS local: só funciona se o nome for resolvido pelo proxy
    const response = await requestViaProxy(
      local.port,
      `http://fixture.facet.test:${geo.port}/cdn-cgi/trace`,
      {
        timeoutMs: 5000,
      },
    )
    expect(response.status).toBe(200)
    const socket = await tunnel(local.port, `fixture.facet.test:${geo.port}`)
    socket.end()
    expect(socks.requests).toEqual([
      { atyp: 3, host: 'fixture.facet.test', port: geo.port, username: 'u1', password: PASSWORD },
      { atyp: 3, host: 'fixture.facet.test', port: geo.port, username: 'u1', password: PASSWORD },
    ])
  })

  it('closeConnections encerra os túneis abertos e continua aceitando conexões novas', async () => {
    const remote = track(await fakeRemoteProxy())
    const echo = net.createServer((socket) => socket.pipe(socket))
    await new Promise<void>((done) => echo.listen(0, '127.0.0.1', done))
    cleanups.push(() => new Promise<void>((done) => echo.close(() => done())))
    const echoPort = (echo.address() as net.AddressInfo).port
    const local = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: '',
      password: null,
    })

    const socket = await tunnel(local.port, `127.0.0.1:${echoPort}`)
    const reply = new Promise<string>((done) => socket.once('data', (chunk) => done(chunk.toString())))
    socket.write('ping')
    expect(await reply).toBe('ping')
    const closed = new Promise<void>((done) => socket.once('close', () => done()))
    local.closeConnections()
    await closed
    const again = await tunnel(local.port, `127.0.0.1:${echoPort}`)
    again.end()
  })

  it('conta o tráfego com o proxy remoto (o que o provedor cobra) e a taxa por segundo', async () => {
    const geo = track(await fakeGeoServer())
    const remote = track(await fakeRemoteProxy())
    const local = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: '',
      password: null,
    })
    expect(local.sample()).toMatchObject({ upload: 0, download: 0, total: 0 })
    const response = await requestViaProxy(local.port, geo.traceUrl, { timeoutMs: 5000 })
    expect(response.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const first = local.sample()
    expect(first.upload).toBeGreaterThan(0)
    expect(first.download).toBeGreaterThan(response.body.length)
    expect(first.total).toBe(first.upload + first.download)
    expect(first.bytesPerSecond).toBeGreaterThan(0)
    // sem tráfego novo: o total fica e a taxa zera
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = local.sample()
    expect(second).toMatchObject({ total: first.total, bytesPerSecond: 0, since: first.since })
  })

  it('responde o gasto só à extensão Facet, sem passar pelo proxy remoto; para os outros é um domínio qualquer', async () => {
    const geo = track(await fakeGeoServer())
    const remote = track(await fakeRemoteProxy())
    const local = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: '',
      password: null,
    })
    await requestViaProxy(local.port, geo.traceUrl, { timeoutMs: 5000 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const before = local.sample().total
    const usage = await viaProxy(local.port, FACET_USAGE_URL, { [FACET_USAGE_HEADER]: FACET_EXTENSION_ID })
    expect(usage.status).toBe(200)
    expect(usage.headers['cache-control']).toBe('no-store')
    const data = JSON.parse(usage.body) as { total: number; upload: number; download: number }
    expect(data).toMatchObject({ total: before })
    expect(data.upload + data.download).toBe(before)
    // respondido aqui: nada foi ao proxy remoto nem entrou no gasto
    expect(remote.urls.some((url) => url.includes('usage.facet.test'))).toBe(false)
    expect(local.sample().total).toBe(before)
    // sem o cabeçalho (um site, mesmo com a origem da extensão, ou outro valor) segue para o
    // proxy remoto, que não conhece o endereço
    const attempts: Record<string, string>[] = [
      { origin: FACET_EXTENSION_ORIGIN },
      { [FACET_USAGE_HEADER]: 'outro' },
      {},
    ]
    for (const headers of attempts) {
      const other = await viaProxy(local.port, FACET_USAGE_URL, headers)
      expect(other.status).not.toBe(200)
      expect(other.body).not.toContain('"total"')
    }
    expect(remote.urls.filter((url) => url.includes('usage.facet.test'))).toHaveLength(3)
  })

  it('porta fixa ocupada vira erro claro com motivo próprio', async () => {
    const holder = net.createServer()
    await new Promise<void>((done) => holder.listen(0, '127.0.0.1', done))
    cleanups.push(() => new Promise<void>((done) => holder.close(() => done())))
    const port = (holder.address() as net.AddressInfo).port
    const error = await rejection(
      ProxyForwarder.open({ upstreamUrl: 'http://127.0.0.1:9', port, logger: silentLogger }),
    )
    expect(error.code).toBe('PROXY_UNREACHABLE')
    expect(error.details).toEqual({ reason: 'localProxyPort' })
  })
})

describe('ForwarderPool', () => {
  it('agrupa os avisos de falha por perfil e para de avisar ao fechar', async () => {
    const onHealth = vi.fn()
    const pool = new ForwarderPool({ logger: silentLogger, onHealth, healthIntervalMs: 300 })
    cleanups.push(() => pool.closeAll())
    const dead = await freePort()
    const port = await pool.open('perfil-1', 'proxy-1', `http://127.0.0.1:${dead}`)
    expect(pool.port('perfil-1')).toBe(port)
    expect(pool.profilesUsing('proxy-1')).toEqual(['perfil-1'])
    await Promise.allSettled(
      [1, 2, 3].map(() => requestViaProxy(port, 'https://127.0.0.1:1/', { timeoutMs: 5000 })),
    )
    await vi.waitFor(() => expect(onHealth).toHaveBeenCalledTimes(1), { timeout: 2000 })
    expect(onHealth).toHaveBeenCalledWith('perfil-1', expect.objectContaining({ failures: 3 }))
    expect(pool.closeConnectionsForProxy('proxy-1')).toEqual(['perfil-1'])
    await pool.close('perfil-1')
    expect(pool.port('perfil-1')).toBeNull()
    expect(pool.closeConnectionsForProxy('proxy-1')).toEqual([])
  })

  it('envia uma amostra de tráfego por segundo de cada perfil aberto e para ao fechar', async () => {
    const onTraffic = vi.fn()
    const pool = new ForwarderPool({ logger: silentLogger, onTraffic, trafficIntervalMs: 50 })
    cleanups.push(() => pool.closeAll())
    const remote = track(await fakeRemoteProxy())
    await pool.open('perfil-1', 'proxy-1', `http://127.0.0.1:${remote.port}`)
    await vi.waitFor(() => expect(onTraffic.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2000 })
    expect(onTraffic).toHaveBeenCalledWith(
      'perfil-1',
      expect.objectContaining({ total: 0, bytesPerSecond: 0, upload: 0, download: 0 }),
    )
    await pool.close('perfil-1')
    const calls = onTraffic.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(onTraffic.mock.calls.length).toBe(calls)
  })
})

describe('ProxyChecker', () => {
  function checker(traceUrl: string, geoUrl: string, realIp?: RealIpProbe): ProxyChecker {
    const geo = new GeoIpClient({
      provider: () => 'auto',
      token: () => null,
      providers: localProviders(geoUrl),
    })
    return new ProxyChecker({
      geo,
      traceUrl: () => traceUrl,
      logger: silentLogger,
      checkTimeoutMs: 3000,
      realIp,
    })
  }

  it('saída pelo IP real desta conexão: offline com PROXY_REAL_IP, mantendo IP e local', async () => {
    const geo = track(await fakeGeoServer())
    const remote = track(await fakeRemoteProxy({ username: 'user', password: PASSWORD }))
    const proxy: UpstreamProxy = {
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: 'user',
      password: PASSWORD,
    }
    const viaChecker = checker(geo.traceUrl, geo.geoUrl, new RealIpProbe({ urls: [geo.realIpUrl], ttlMs: 0 }))
    // conexão de teste com outro IP: o proxy protege, fica online
    expect(await viaChecker.check(proxy)).toMatchObject({
      status: 'online',
      exitIp: SAO_PAULO.ip,
      error: null,
    })
    geo.setRealIp(SAO_PAULO.ip)
    const outcome = await viaChecker.check(proxy)
    expect(outcome).toMatchObject({
      status: 'offline',
      latencyMs: null,
      exitIp: SAO_PAULO.ip,
      countryCode: 'BR',
      city: 'São Paulo',
      timezone: 'America/Sao_Paulo',
      error: { code: 'PROXY_REAL_IP', details: { ip: SAO_PAULO.ip, reason: 'realIp' } },
    })
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD)
    expect(geo.hits.real).toBeGreaterThanOrEqual(2)
    // sem como descobrir o IP real (consulta direta fora do ar): nada é bloqueado por falta de dados
    const blind = new RealIpProbe({ urls: [`http://127.0.0.1:${await freePort()}/trace`], ttlMs: 0 })
    expect((await checker(geo.traceUrl, geo.geoUrl, blind).check(proxy)).status).toBe('online')
  })

  it('IPv6: o geo-IP vê o IP real escrito de outra forma e o proxy também é recusado', async () => {
    const geo = track(await fakeGeoServer([{ ...SAO_PAULO, ip: '2001:db8::7' }]))
    const remote = track(await fakeRemoteProxy())
    geo.setRealIp('2001:0DB8:0000:0000:0000:0000:0000:0007')
    // "trace" sem a linha ip=: o IP de saída vem do provedor de geo-IP
    const outcome = await checker(
      geo.pageUrl,
      geo.geoUrl,
      new RealIpProbe({ urls: [geo.realIpUrl], ttlMs: 0 }),
    ).check({ type: 'http', host: '127.0.0.1', port: remote.port, username: '', password: null })
    expect(outcome).toMatchObject({
      status: 'offline',
      exitIp: '2001:db8::7',
      error: { code: 'PROXY_REAL_IP' },
    })
  })

  it('checagem antes de abrir recusa o proxy que sai pelo IP real', async () => {
    const geo = track(await fakeGeoServer())
    const remote = track(await fakeRemoteProxy())
    const local = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: '',
      password: null,
    })
    const viaChecker = checker(geo.traceUrl, geo.geoUrl, new RealIpProbe({ urls: [geo.realIpUrl], ttlMs: 0 }))
    expect(launchBlocker(await viaChecker.checkPort(local.port))).toBeNull()
    geo.setRealIp(SAO_PAULO.ip)
    const error = launchBlocker(await viaChecker.checkPort(local.port))
    expect(error?.code).toBe('PROXY_REAL_IP')
    expect(error?.details).toMatchObject({ ip: SAO_PAULO.ip })
    // sem saber o IP real, nada é bloqueado por falta de dados
    const blind = new RealIpProbe({ urls: [`http://127.0.0.1:${await freePort()}/trace`], ttlMs: 0 })
    expect(launchBlocker(await checker(geo.traceUrl, geo.geoUrl, blind).checkPort(local.port))).toBeNull()
  })

  it('verificação completa: online, IP de saída, país, cidade, fuso e latência pelo proxy', async () => {
    const geo = track(await fakeGeoServer())
    const remote = track(await fakeRemoteProxy({ username: 'user', password: PASSWORD }))
    const outcome = await checker(geo.traceUrl, geo.geoUrl).check({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: 'user',
      password: PASSWORD,
    })
    expect(outcome).toMatchObject({
      status: 'online',
      exitIp: SAO_PAULO.ip,
      countryCode: 'BR',
      countryName: 'Brazil',
      city: 'São Paulo',
      timezone: 'America/Sao_Paulo',
      latitude: -23.55,
      longitude: -46.63,
      error: null,
    })
    expect(outcome.latencyMs).toBeGreaterThanOrEqual(0)
    expect(geo.hits).toMatchObject({ trace: 1, geo: 1 })
  })

  it('senha errada: offline com PROXY_AUTH_FAILED e sem a senha na mensagem', async () => {
    const remote = track(await fakeRemoteProxy({ username: 'user', password: 'certa' }))
    const outcome = await checker('https://127.0.0.1:1/cdn-cgi/trace', 'https://127.0.0.1:1/geo').check({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: 'user',
      password: 'errada-456',
    })
    expect(outcome.status).toBe('offline')
    expect(outcome.error?.code).toBe('PROXY_AUTH_FAILED')
    expect(JSON.stringify(outcome)).not.toContain('errada-456')
  })

  it('geo-IP fora do ar mantém o proxy online, com o erro registrado', async () => {
    const geo = track(await fakeGeoServer())
    const remote = track(await fakeRemoteProxy())
    const dead = await freePort()
    const outcome = await checker(geo.traceUrl, `http://127.0.0.1:${dead}/geo`).check({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: '',
      password: null,
    })
    expect(outcome).toMatchObject({ status: 'online', exitIp: SAO_PAULO.ip, countryCode: 'BR', city: null })
    expect(outcome.error?.code).toBe('GEOIP_FAILED')
  })

  it('checagem antes de abrir bloqueia só falhas do próprio proxy', async () => {
    const geo = track(await fakeGeoServer())
    const remote = track(await fakeRemoteProxy())
    const viaTrace = checker(geo.traceUrl, geo.geoUrl)
    const viaTls = checker('https://127.0.0.1:1/cdn-cgi/trace', geo.geoUrl)
    const good = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: remote.port,
      username: '',
      password: null,
    })
    expect(launchBlocker(await viaTrace.checkPort(good.port))).toBeNull()
    // proxy que só bloqueia o destino de teste (responde 502 ao túnel): continua utilizável
    const blocking = track(await fakeStatusProxy(502))
    const blocked = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: blocking.port,
      username: '',
      password: null,
    })
    const blockedOutcome = await viaTls.checkPort(blocked.port)
    expect(blockedOutcome.error?.code).toBe('PROXY_UNREACHABLE')
    expect(launchBlocker(blockedOutcome)).toBeNull()
    // proxy HTTP e SOCKS5 fora do ar bloqueiam a abertura
    for (const type of ['http', 'socks5'] as const) {
      const dead = await forwarder({
        type,
        host: '127.0.0.1',
        port: await freePort(),
        username: '',
        password: null,
      })
      expect(launchBlocker(await viaTls.checkPort(dead.port))?.code, type).toBe('PROXY_UNREACHABLE')
    }
    // senha recusada também
    const guarded = track(await fakeRemoteProxy({ username: 'user', password: 'certa' }))
    const wrong = await forwarder({
      type: 'http',
      host: '127.0.0.1',
      port: guarded.port,
      username: 'user',
      password: 'errada',
    })
    expect(launchBlocker(await viaTrace.checkPort(wrong.port))?.code).toBe('PROXY_AUTH_FAILED')
  })

  it('a fila limita verificações simultâneas e cancela as que esperam', async () => {
    const limiter = new CheckLimiter(2)
    let active = 0
    let peak = 0
    const task = async (): Promise<number> => {
      active++
      peak = Math.max(peak, active)
      await new Promise((done) => setTimeout(done, 20))
      active--
      return 1
    }
    expect(await Promise.all([1, 2, 3, 4, 5].map(() => limiter.run(task)))).toEqual([1, 1, 1, 1, 1])
    expect(peak).toBe(2)
    const controller = new AbortController()
    const blocker = new Promise<void>((done) => setTimeout(done, 50))
    const running = [limiter.run(() => blocker), limiter.run(() => blocker)]
    const waiting = limiter.run(task, controller.signal)
    controller.abort()
    expect((await rejection(waiting)).code).toBe('CANCELLED')
    await Promise.all(running)
  })
})

describe('IP real desta conexão', () => {
  it('normaliza IPv4, IPv6 e IPv4 mapeado; texto que não é IP vira null', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7')
    expect(normalizeIp('2001:0DB8:0000:0000:0000:0000:0000:0007')).toBe('2001:db8::7')
    expect(normalizeIp('[2001:db8::7]')).toBe('2001:db8::7')
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(normalizeIp('proxy.example')).toBeNull()
    expect(normalizeIp('')).toBeNull()
    expect(normalizeIp(null)).toBeNull()
  })

  it('consulta IPv4 e IPv6 juntos, guarda por 5 min e compartilha a consulta entre verificações', async () => {
    let now = 0
    const fetch = vi.fn(async (url: string) => (url.includes('v6') ? 'ip=2001:db8::9\n' : 'ip=203.0.113.9\n'))
    const probe = new RealIpProbe({ urls: ['https://v4/trace', 'https://v6/trace'], fetch, now: () => now })
    const [first, second] = await Promise.all([probe.current(), probe.current()])
    expect([...first].sort()).toEqual(['2001:db8::9', '203.0.113.9'])
    expect(second).toBe(first)
    expect(fetch).toHaveBeenCalledTimes(2)
    now = 4 * 60_000
    await probe.current()
    expect(fetch).toHaveBeenCalledTimes(2)
    now = 6 * 60_000
    await probe.current()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('sem resposta: não acusa nada, registra no log e tenta de novo depois de 1 min', async () => {
    let now = 0
    const warn = vi.fn()
    const fetch = vi.fn(async (): Promise<string> => {
      throw new Error('sem rede')
    })
    const probe = new RealIpProbe({
      urls: ['https://v4/trace'],
      fetch,
      now: () => now,
      logger: { ...silentLogger, warn },
    })
    expect(await probe.isRealIp('203.0.113.9')).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    now = 30_000
    expect(await probe.isRealIp('203.0.113.9')).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    now = 61_000
    await probe.isRealIp('203.0.113.9')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('antes de acusar, confirma com consulta nova se o resultado tem mais de 1 min (IP dinâmico)', async () => {
    let now = 0
    let ip = '203.0.113.9'
    const fetch = vi.fn(async () => `ip=${ip}\n`)
    const probe = new RealIpProbe({ urls: ['https://v4/trace'], fetch, now: () => now })
    expect(await probe.isRealIp('203.0.113.9')).toBe(true)
    expect(await probe.isRealIp('198.51.100.1')).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    now = 2 * 60_000
    ip = '198.51.100.77'
    expect(await probe.isRealIp('203.0.113.9')).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await probe.isRealIp('198.51.100.77')).toBe(true)
  })

  it('lista vazia desliga a comparação; cancelar libera quem esperava sem derrubar a consulta', async () => {
    const unused = vi.fn(async () => 'ip=203.0.113.9\n')
    expect(await new RealIpProbe({ urls: [], fetch: unused }).isRealIp('203.0.113.9')).toBe(false)
    expect(unused).not.toHaveBeenCalled()

    let release: (body: string) => void = () => undefined
    const slow = vi.fn(
      () =>
        new Promise<string>((done) => {
          release = done
        }),
    )
    const probe = new RealIpProbe({ urls: ['https://v4/trace'], fetch: slow })
    const controller = new AbortController()
    const waiting = probe.isRealIp('203.0.113.9', controller.signal)
    const other = probe.isRealIp('203.0.113.9')
    controller.abort()
    expect((await rejection(waiting)).code).toBe('CANCELLED')
    release('ip=203.0.113.9\n')
    expect(await other).toBe(true)
    expect(slow).toHaveBeenCalledOnce()
  })
})

describe('troca de IP', () => {
  const outcome = (ip: string): ProxyCheckOutcome => ({
    status: 'online',
    latencyMs: 10,
    exitIp: ip,
    countryCode: 'BR',
    countryName: 'Brazil',
    region: null,
    city: null,
    timezone: null,
    latitude: null,
    longitude: null,
    error: null,
    checkedAt: 0,
  })

  it('chama a URL do provedor e verifica de novo até o IP mudar', async () => {
    const geo = track(await fakeGeoServer())
    const check = vi
      .fn<() => Promise<ProxyCheckOutcome>>()
      .mockResolvedValueOnce(outcome('203.0.113.7'))
      .mockResolvedValueOnce(outcome('198.51.100.20'))
    const result = await rotateIp({
      changeIpUrl: geo.rotateUrl,
      previousIp: '203.0.113.7',
      check,
      sleep: async () => {},
    })
    expect(result.changed).toBe(true)
    expect(result.outcome.exitIp).toBe('198.51.100.20')
    expect(geo.hits.rotate).toBe(1)
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('IP que não muda depois das tentativas volta como não alterado', async () => {
    const geo = track(await fakeGeoServer())
    const check = vi.fn(async () => outcome('203.0.113.7'))
    const result = await rotateIp({
      changeIpUrl: geo.rotateUrl,
      previousIp: '203.0.113.7',
      check,
      attempts: 3,
      sleep: async () => {},
    })
    expect(result.changed).toBe(false)
    expect(check).toHaveBeenCalledTimes(3)
  })

  it('URL que falha vira PROXY_ROTATE_FAILED', async () => {
    const dead = await freePort()
    const error = await rejection(
      rotateIp({
        changeIpUrl: `http://127.0.0.1:${dead}/x`,
        previousIp: null,
        check: vi.fn(),
        timeoutMs: 2000,
      }),
    )
    expect(error.code).toBe('PROXY_ROTATE_FAILED')
  })
})
