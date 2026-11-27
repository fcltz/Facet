import dns from 'node:dns'
import http from 'node:http'
import net from 'node:net'
import { Server as ProxyChainServer } from 'proxy-chain'

/**
 * Servidores locais para os testes de proxy: nenhum teste depende da internet
 * nem de credenciais reais.
 */

export interface Closable {
  port: number
  close: () => Promise<void>
}

export async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((done) => server.close(() => done()))
  return port
}

export interface FakeRemoteProxy extends Closable {
  /** Destinos pedidos ao proxy (host:porta), na ordem. */
  seen: string[]
  /** URLs completas das requisições HTTP simples (sem túnel) que passaram pelo proxy. */
  urls: string[]
  /** Credenciais recebidas na última requisição. */
  lastAuth: { username: string; password: string } | null
}

/**
 * Resolve `*.localhost` para esta máquina, como o Chromium faz (o resolvedor do Windows não faz):
 * com proxy, quem resolve o nome é o proxy remoto, não o navegador.
 */
const lookupWithLocalhost = ((
  hostname: string,
  options: dns.LookupOptions,
  callback: (...args: unknown[]) => void,
) => {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    if (options?.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
    else callback(null, '127.0.0.1', 4)
    return
  }
  dns.lookup(hostname, options, callback as never)
}) as unknown as typeof dns.lookup

/** "Proxy remoto" HTTP com usuário e senha opcionais (proxy-chain sem upstream = saída direta). */
export async function fakeRemoteProxy(auth?: {
  username: string
  password: string
}): Promise<FakeRemoteProxy> {
  const seen: string[] = []
  const urls: string[] = []
  const state: { lastAuth: FakeRemoteProxy['lastAuth'] } = { lastAuth: null }
  const server = new ProxyChainServer({
    port: 0,
    host: '127.0.0.1',
    verbose: false,
    prepareRequestFunction: ({ username, password, hostname, port, isHttp, request }) => {
      state.lastAuth = { username, password }
      const refused = auth !== undefined && (username !== auth.username || password !== auth.password)
      if (!refused) {
        seen.push(`${hostname}:${port}`)
        if (isHttp && request.url) urls.push(request.url)
      }
      return { requestAuthentication: refused, dnsLookup: lookupWithLocalhost }
    },
  })
  await server.listen()
  return {
    port: server.port,
    seen,
    urls,
    get lastAuth() {
      return state.lastAuth
    },
    close: () => server.close(true),
  }
}

export interface SocksRequest {
  /** 1 = IPv4, 3 = nome (resolvido pelo proxy), 4 = IPv6. */
  atyp: number
  host: string
  port: number
  username: string
  password: string
}

export interface FakeSocksProxy extends Closable {
  requests: SocksRequest[]
}

/** SOCKS5 mínimo (RFC 1928 + usuário/senha RFC 1929) que registra o destino pedido. */
export async function fakeSocksProxy(
  auth: { username: string; password: string },
  resolveHost: (name: string) => string = () => '127.0.0.1',
): Promise<FakeSocksProxy> {
  const requests: SocksRequest[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())
    let stage: 'greeting' | 'auth' | 'request' | 'piping' = 'greeting'
    let buffer = Buffer.alloc(0)
    let credentials = { username: '', password: '' }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return
        const methods = [...buffer.subarray(2, 2 + buffer[1]!)]
        buffer = buffer.subarray(2 + buffer[1]!)
        if (!methods.includes(2)) {
          client.end(Buffer.from([5, 0xff]))
          return
        }
        client.write(Buffer.from([5, 2]))
        stage = 'auth'
      }
      if (stage === 'auth') {
        if (buffer.length < 2) return
        const userLength = buffer[1]!
        if (buffer.length < 3 + userLength) return
        const passLength = buffer[2 + userLength]!
        if (buffer.length < 3 + userLength + passLength) return
        credentials = {
          username: buffer.subarray(2, 2 + userLength).toString('utf8'),
          password: buffer.subarray(3 + userLength, 3 + userLength + passLength).toString('utf8'),
        }
        buffer = buffer.subarray(3 + userLength + passLength)
        const accepted = credentials.username === auth.username && credentials.password === auth.password
        client.write(Buffer.from([1, accepted ? 0 : 1]))
        if (!accepted) {
          client.end()
          return
        }
        stage = 'request'
      }
      if (stage === 'request') {
        if (buffer.length < 5) return
        const atyp = buffer[3]!
        let host: string
        let offset: number
        if (atyp === 1) {
          if (buffer.length < 10) return
          host = [...buffer.subarray(4, 8)].join('.')
          offset = 8
        } else if (atyp === 3) {
          const length = buffer[4]!
          if (buffer.length < 5 + length + 2) return
          host = buffer.subarray(5, 5 + length).toString('utf8')
          offset = 5 + length
        } else {
          client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]))
          return
        }
        const port = buffer.readUInt16BE(offset)
        const rest = buffer.subarray(offset + 2)
        requests.push({ atyp, host, port, ...credentials })
        stage = 'piping'
        client.removeListener('data', onData)
        const target = net.connect(port, atyp === 3 ? resolveHost(host) : host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          if (rest.length > 0) target.write(rest)
          client.pipe(target)
          target.pipe(client)
        })
        sockets.add(target)
        target.on('close', () => sockets.delete(target))
        target.on('error', () => {
          if (!client.destroyed) client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]))
        })
      }
    }
    client.on('data', onData)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: (server.address() as net.AddressInfo).port,
    requests,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

export interface FakeConnectProxy extends Closable {
  /** Destinos pedidos por CONNECT (host:porta), na ordem. */
  seen: string[]
}

/**
 * Proxy HTTP mínimo, só com CONNECT, que resolve os nomes com `resolveHost`: permite um destino
 * (ex.: facet.test) que só existe dentro do túnel e falha se alguém tentar ir direto.
 */
export async function fakeConnectProxy(resolveHost: (name: string) => string): Promise<FakeConnectProxy> {
  const seen: string[] = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => client.destroy())
    let head = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf('\r\n\r\n')
      if (end === -1) return
      client.removeListener('data', onData)
      const requestLine = head.subarray(0, end).toString('latin1').split('\r\n')[0] ?? ''
      const match = /^CONNECT ([^\s:]+):(\d+) HTTP\/1\.[01]$/.exec(requestLine)
      if (!match) {
        client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
        return
      }
      const host = match[1]!
      const port = Number(match[2])
      seen.push(`${host}:${port}`)
      const rest = head.subarray(end + 4)
      const target = net.connect(port, resolveHost(host), () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (rest.length > 0) target.write(rest)
        client.pipe(target)
        target.pipe(client)
      })
      sockets.add(target)
      target.on('close', () => sockets.delete(target))
      target.on('error', () => {
        if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      })
    }
    client.on('data', onData)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: (server.address() as net.AddressInfo).port,
    seen,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

/** Proxy que responde sempre o mesmo status (ex.: 502 = bloqueia o destino; 403 = plano vencido). */
export async function fakeStatusProxy(status: number): Promise<Closable> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let head = ''
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1')
      if (head.includes('\r\n\r\n')) {
        socket.end(`HTTP/1.1 ${status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

/** Aceita a conexão e nunca responde (proxy travado). */
export async function blackHole(): Promise<Closable> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => undefined)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return {
    port: (server.address() as net.AddressInfo).port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

export interface FakeGeo {
  ip: string
  countryCode: string
  country: string
  region: string
  city: string
  timezone: string
  latitude: number
  longitude: number
}

export const SAO_PAULO: FakeGeo = {
  ip: '203.0.113.7',
  countryCode: 'BR',
  country: 'Brazil',
  region: 'São Paulo',
  city: 'São Paulo',
  timezone: 'America/Sao_Paulo',
  latitude: -23.55,
  longitude: -46.63,
}

export const TOKYO: FakeGeo = {
  ip: '198.51.100.20',
  countryCode: 'JP',
  country: 'Japan',
  region: 'Tokyo',
  city: 'Tokyo',
  timezone: 'Asia/Tokyo',
  latitude: 35.68,
  longitude: 139.69,
}

/** "IP real" padrão da conexão de teste sem proxy (diferente de todas as saídas de teste). */
export const DEFAULT_REAL_IP = '192.0.2.250'

export interface FakeGeoServer extends Closable {
  traceUrl: string
  geoUrl: string
  /** URL de troca de IP: cada chamada passa para o próximo IP da lista. */
  rotateUrl: string
  /** Página de teste (HTML) servida para o navegador. */
  pageUrl: string
  /** Trace "sem proxy": devolve o IP real configurado (`setRealIp`). */
  realIpUrl: string
  current: () => FakeGeo
  /** Troca o IP real da conexão de teste; null volta ao padrão. */
  setRealIp: (ip: string | null) => void
  hits: { trace: number; geo: number; rotate: number; page: number; real: number }
}

/**
 * Cloudflare trace, provedor de geo-IP (formato do ipwho.is), URL de troca de IP,
 * trace direto (IP real) e uma página HTML, todos num servidor local. O "IP de saída"
 * é o da posição atual da lista `exits`.
 */
export async function fakeGeoServer(exits: FakeGeo[] = [SAO_PAULO, TOKYO]): Promise<FakeGeoServer> {
  let index = 0
  let realIp = DEFAULT_REAL_IP
  const hits = { trace: 0, geo: 0, rotate: 0, page: 0, real: 0 }
  const current = (): FakeGeo => exits[index % exits.length]!
  const sockets = new Set<net.Socket>()
  const server = http.createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://local').pathname
    if (path === '/cdn-cgi/trace') {
      hits.trace++
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`fl=1\nip=${current().ip}\nloc=${current().countryCode}\n`)
    } else if (path === '/real-trace') {
      hits.real++
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`fl=1\nip=${realIp}\nloc=BR\n`)
    } else if (path === '/geo') {
      hits.geo++
      const geo = current()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          success: true,
          ip: geo.ip,
          country_code: geo.countryCode,
          country: geo.country,
          region: geo.region,
          city: geo.city,
          timezone: { id: geo.timezone },
          latitude: geo.latitude,
          longitude: geo.longitude,
        }),
      )
    } else if (path === '/rotate') {
      hits.rotate++
      index++
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    } else {
      hits.page++
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<!doctype html><title>Facet proxy test</title><h1>via proxy</h1>')
    }
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as net.AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  return {
    port,
    traceUrl: `${base}/cdn-cgi/trace`,
    geoUrl: `${base}/geo`,
    rotateUrl: `${base}/rotate`,
    pageUrl: `${base}/page`,
    realIpUrl: `${base}/real-trace`,
    current,
    setRealIp: (ip) => {
      realIp = ip ?? DEFAULT_REAL_IP
    },
    hits,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}
