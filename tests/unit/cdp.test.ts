import { afterEach, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { CdpClient } from '@main/browser/cdp/client'

let server: WebSocketServer | undefined
let client: CdpClient | undefined
afterEach(async () => {
  client?.close()
  for (const connection of server?.clients ?? []) connection.terminate()
  if (server) await new Promise<void>((done) => server!.close(() => done()))
  server = undefined
  client = undefined
})

it('correlaciona respostas CDP e rejeita comandos pendentes quando a conexão cai', async () => {
  server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((done) => server!.once('listening', done))
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Sem porta')
  server.on('connection', (socket) =>
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString()) as { id: number; method: string }
      if (request.method === 'Target.getTargets')
        socket.send(JSON.stringify({ id: request.id, result: { targetInfos: [] } }))
      else socket.close()
    }),
  )
  client = await CdpClient.connect(`ws://127.0.0.1:${address.port}`)
  expect(await client.send('Target.getTargets', {})).toEqual({ targetInfos: [] })
  await expect(client.send('Browser.getVersion', undefined)).rejects.toMatchObject({
    code: 'BROWSER_DISCONNECTED',
  })
})

it('recusa endpoint remoto e cancelamento antes de conectar', async () => {
  await expect(CdpClient.connect('ws://example.com:9222')).rejects.toMatchObject({
    code: 'BROWSER_START_FAILED',
  })
  const abort = new AbortController()
  abort.abort()
  await expect(CdpClient.connect('ws://127.0.0.1:9222', 100, abort.signal)).rejects.toBeDefined()
})
