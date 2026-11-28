import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import type { Protocol } from 'devtools-protocol'
import { CdpClient } from '@main/browser/cdp/client'
import { FingerprintController } from '@main/browser/fingerprint/controller'
import { applyFingerprint } from '@main/browser/fingerprint/apply'
import { silentLogger } from '@main/logger'
import { createDefaultFingerprint } from '@shared/schemas/fingerprint'

const config = createDefaultFingerprint({
  mode: 'emulated',
  os: 'macos',
  engineMajor: 158,
  timezone: 'Asia/Tokyo',
})
const target = (type: string, url = 'about:blank'): Protocol.Target.TargetInfo => ({
  targetId: 'page-1',
  type,
  url,
  title: '',
  attached: true,
  canAccessOpener: false,
})

describe('preparação do fingerprint', () => {
  it('retoma service worker antes de aguardar respostas e informa cobertura parcial', async () => {
    let resume = false
    const pending: (() => void)[] = []
    const client = {
      send: vi.fn((method: string) => {
        if (method === 'Runtime.runIfWaitingForDebugger') {
          resume = true
          pending.forEach((fn) => fn())
          return Promise.resolve({})
        }
        if (method === 'Network.setUserAgentOverride') return Promise.reject(new Error('unsupported'))
        return new Promise((resolve) => {
          pending.push(() => resolve({}))
        })
      }),
    } as unknown as CdpClient
    const warn = vi.fn()
    await applyFingerprint(
      client,
      'worker-session',
      target('service_worker', 'http://localhost/sw.js'),
      config,
      warn,
    )
    expect(resume).toBe(true)
    expect(warn).toHaveBeenCalledWith('workerCoverage')
  })
  it('falha explícita em comando obrigatório de página e preserva contexts de extensão', async () => {
    const client = {
      send: vi.fn(async (method: string) => {
        if (method === 'Emulation.setTimezoneOverride') throw new Error('unsupported timezone')
        return {}
      }),
    } as unknown as CdpClient
    await expect(
      applyFingerprint(client, 'page-session', target('page'), config, vi.fn()),
    ).rejects.toMatchObject({ code: 'FINGERPRINT_FAILED' })
    vi.mocked(client.send).mockClear()
    await applyFingerprint(
      client,
      'extension-session',
      target('service_worker', 'chrome-extension://abc/worker.js'),
      config,
      vi.fn(),
    )
    expect(client.send).not.toHaveBeenCalled()
  })
})

describe('alvo cuja preparação falhou', () => {
  /** Cliente falso: o iframe anexado recusa os ajustes; `alive` diz se ele ainda existe. */
  function harness(alive: boolean) {
    const listeners = new Map<string, (params: unknown) => void>()
    const client = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargetInfo') {
          if (alive) return { targetInfo: target('iframe', 'https://ads.example/') }
          throw new Error('No target with given id found')
        }
        if (method === 'Emulation.setTimezoneOverride') throw new Error('Session with given id not found')
        return {}
      }),
      on: vi.fn((method: string, listener: (params: unknown) => void) => {
        listeners.set(method, listener)
        return () => listeners.delete(method)
      }),
    } as unknown as CdpClient
    const attach = (): void =>
      listeners.get('Target.attachedToTarget')?.({
        sessionId: 'frame-session',
        targetInfo: target('iframe', 'https://ads.example/'),
        waitingForDebugger: true,
      })
    return { client, attach }
  }

  it('alvo que sumiu (iframe removido, pop-up fechado) não fecha o perfil', async () => {
    const { client, attach } = harness(false)
    const fatal = vi.fn()
    const controller = new FingerprintController(client, config, silentLogger, fatal)
    await controller.start()
    attach()
    await expect(controller.ready('page-1')).rejects.toBeDefined()
    await vi.waitFor(() =>
      expect(client.send).toHaveBeenCalledWith(
        'Target.getTargetInfo',
        { targetId: 'page-1' },
        undefined,
        2000,
      ),
    )
    await new Promise((done) => setTimeout(done, 50))
    expect(fatal).not.toHaveBeenCalled()
    controller.stop()
  })

  it('alvo vivo que não aceitou os ajustes fecha o perfil (falha fechada)', async () => {
    const { client, attach } = harness(true)
    const fatal = vi.fn()
    const controller = new FingerprintController(client, config, silentLogger, fatal)
    await controller.start()
    attach()
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(fatal.mock.calls[0]?.[0]).toMatchObject({ code: 'FINGERPRINT_FAILED' })
    controller.stop()
  })
})

let server: WebSocketServer | undefined
let client: CdpClient | undefined
afterEach(async () => {
  client?.close()
  for (const socket of server?.clients ?? []) socket.terminate()
  if (server) await new Promise<void>((done) => server!.close(() => done()))
  server = undefined
  client = undefined
})

it('só navega depois de receber as confirmações das configurações da aba', async () => {
  server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((done) => server!.once('listening', done))
  const commands: string[] = []
  let acknowledgeTimezone: (() => void) | undefined
  server.on('connection', (socket) =>
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString()) as {
        id: number
        method: string
        params?: { url?: string }
        sessionId?: string
      }
      commands.push(request.method)
      const reply = (result: unknown = {}): void => {
        socket.send(JSON.stringify({ id: request.id, result }))
      }
      if (request.method === 'Target.createTarget') {
        expect(request.params?.url).toBe('about:blank')
        reply({ targetId: 'page-1' })
        socket.send(
          JSON.stringify({
            method: 'Target.attachedToTarget',
            params: { sessionId: 'page-session', targetInfo: target('page'), waitingForDebugger: true },
          }),
        )
      } else if (request.method === 'Emulation.setTimezoneOverride') acknowledgeTimezone = () => reply()
      else reply()
    }),
  )
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Sem porta')
  client = await CdpClient.connect(`ws://127.0.0.1:${address.port}`)
  const fatal = vi.fn()
  const controller = new FingerprintController(client, config, silentLogger, fatal)
  await controller.start()
  const opened = controller.createPage().then((id) => controller.navigate(id, 'https://example.test'))
  await vi.waitFor(() => expect(acknowledgeTimezone).toBeDefined())
  expect(commands).not.toContain('Page.navigate')
  acknowledgeTimezone!()
  await opened
  expect(commands).toContain('Page.navigate')
  // Sem Page.enable o script de documento não roda nas navegações seguintes.
  const order = ['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Page.navigate'].map((method) =>
    commands.indexOf(method),
  )
  expect(order.every((index) => index >= 0)).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(fatal).not.toHaveBeenCalled()
  controller.stop()
})

describe('navegação do Facet com site lento', () => {
  /** CDP falso: prepara a aba na hora e entrega cada Page.navigate a `navigate`. */
  async function fakeBrowser(navigate: (reply: (message: object) => void) => void): Promise<CdpClient> {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((done) => server!.once('listening', done))
    server.on('connection', (socket) =>
      socket.on('message', (data) => {
        const request = JSON.parse(data.toString()) as { id: number; method: string }
        const reply = (message: object): void => socket.send(JSON.stringify({ id: request.id, ...message }))
        if (request.method === 'Target.createTarget') {
          reply({ result: { targetId: 'page-1' } })
          socket.send(
            JSON.stringify({
              method: 'Target.attachedToTarget',
              params: { sessionId: 'page-session', targetInfo: target('page'), waitingForDebugger: true },
            }),
          )
        } else if (request.method === 'Page.navigate') navigate(reply)
        else reply({ result: {} })
      }),
    )
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Sem porta')
    client = await CdpClient.connect(`ws://127.0.0.1:${address.port}`)
    return client
  }

  it('site sem resposta: segue depois da espera, só com aviso, e o perfil não fecha', async () => {
    let answer: ((message: object) => void) | undefined
    const cdp = await fakeBrowser((reply) => {
      answer = reply
    })
    const warn = vi.fn()
    const debug = vi.fn()
    const fatal = vi.fn()
    const controller = new FingerprintController(cdp, config, { ...silentLogger, warn, debug }, fatal, {
      navigationWaitMs: 150,
    })
    await controller.start()
    const id = await controller.createPage()
    const started = Date.now()
    await controller.navigate(id, 'https://lento.example/')
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
    expect(answer).toBeDefined()
    // o normal com um site de verdade: só no log de depuração
    expect(debug).toHaveBeenCalledWith('O site ainda não respondeu; o perfil abre com a aba carregando')
    expect(warn).not.toHaveBeenCalled()
    // a resposta que chega depois só vai para o log
    answer!({ result: { frameId: 'frame', loaderId: 'loader', errorText: 'net::ERR_TIMED_OUT' } })
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('Navegação inicial não terminou', 'net::ERR_TIMED_OUT'),
    )
    expect(fatal).not.toHaveBeenCalled()
    controller.stop()
  })

  it('erro imediato do site só gera aviso; erro do próprio comando continua sendo erro', async () => {
    let mode: 'site' | 'command' = 'site'
    const cdp = await fakeBrowser((reply) =>
      mode === 'site'
        ? reply({ result: { frameId: 'frame', errorText: 'net::ERR_CONNECTION_REFUSED' } })
        : reply({ error: { code: -32000, message: 'Cannot navigate to invalid URL' } }),
    )
    const warn = vi.fn()
    const fatal = vi.fn()
    const controller = new FingerprintController(cdp, config, { ...silentLogger, warn }, fatal)
    await controller.start()
    const id = await controller.createPage()
    const started = Date.now()
    await controller.navigate(id, 'http://127.0.0.1:9/')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(warn).toHaveBeenCalledWith('Navegação inicial não terminou', 'net::ERR_CONNECTION_REFUSED')
    expect(warn).not.toHaveBeenCalledWith('O site ainda não respondeu; o perfil abre com a aba carregando')
    mode = 'command'
    await expect(controller.navigate(id, 'http://invalido')).rejects.toThrow('Cannot navigate to invalid URL')
    expect(fatal).not.toHaveBeenCalled()
    controller.stop()
  })
})
