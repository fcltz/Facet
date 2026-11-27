import fs from 'node:fs'
import https from 'node:https'
import type net from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ProxyForwarder } from '@main/proxy/forwarder'
import { requestViaProxy } from '@main/proxy/http-via-proxy'
import { upstreamUrl } from '@main/proxy/upstream'
import { silentLogger } from '@main/logger'
import { fakeConnectProxy, fakeSocksProxy } from '../helpers/fake-network'

const cert = fs.readFileSync(resolve('tests/fixtures/tls/facet-test.crt'))
const key = fs.readFileSync(resolve('tests/fixtures/tls/facet-test.key'))
/** Só o "proxy remoto" sabe chegar em facet.test; direto, o nome não resolve (TLD reservado). */
const insideTunnel = (name: string): string => (name === 'facet.test' ? '127.0.0.1' : name)

// Regressão: a verificação via HTTPS saía direto (o Node ignora `createConnection` quando há
// agente), e o trace mostrava o IP real desta máquina como se fosse o do proxy.
describe('HTTPS pela cadeia do proxy (destino que só existe dentro do túnel)', () => {
  let site: https.Server
  let sitePort: number

  beforeAll(async () => {
    site = https.createServer({ cert, key }, (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`fl=1\nip=203.0.113.7\npath=${request.url ?? ''}\n`)
    })
    await new Promise<void>((done) => site.listen(0, '127.0.0.1', done))
    sitePort = (site.address() as net.AddressInfo).port
  })
  afterAll(async () => {
    site.closeAllConnections()
    await new Promise<void>((done) => site.close(() => done()))
  })

  for (const type of ['http', 'socks5'] as const) {
    it(`${type}: a requisição HTTPS vai pelo túnel do proxy remoto, nunca direto ao destino`, async () => {
      const remote =
        type === 'http'
          ? await fakeConnectProxy(insideTunnel)
          : await fakeSocksProxy({ username: 'usuário', password: 'p@ss:1' }, insideTunnel)
      const forwarder = await ProxyForwarder.open({
        upstreamUrl: upstreamUrl({
          type,
          host: '127.0.0.1',
          port: remote.port,
          username: type === 'socks5' ? 'usuário' : '',
          password: type === 'socks5' ? 'p@ss:1' : null,
        }),
        logger: silentLogger,
      })
      try {
        const response = await requestViaProxy(
          forwarder.port,
          `https://facet.test:${sitePort}/cdn-cgi/trace?x=1`,
          { timeoutMs: 10000, ca: cert },
        )
        expect(response.status).toBe(200)
        expect(response.body).toContain('ip=203.0.113.7')
        expect(response.body).toContain('path=/cdn-cgi/trace?x=1')
        // o nome vai para o proxy remoto, que o resolve (nada de DNS local)
        const asked =
          'seen' in remote ? remote.seen : remote.requests.map((request) => `${request.host}:${request.port}`)
        expect(asked).toEqual([`facet.test:${sitePort}`])
      } finally {
        await forwarder.close()
        await remote.close()
      }
    })
  }

  it('o certificado do destino continua validado dentro do túnel', async () => {
    const remote = await fakeConnectProxy(insideTunnel)
    const forwarder = await ProxyForwarder.open({
      upstreamUrl: upstreamUrl({
        type: 'http',
        host: '127.0.0.1',
        port: remote.port,
        username: '',
        password: null,
      }),
      logger: silentLogger,
    })
    try {
      await expect(
        requestViaProxy(forwarder.port, `https://facet.test:${sitePort}/`, { timeoutMs: 10000 }),
      ).rejects.toMatchObject({ code: 'PROXY_UNREACHABLE', details: { tls: true } })
    } finally {
      await forwarder.close()
      await remote.close()
    }
  })
})
