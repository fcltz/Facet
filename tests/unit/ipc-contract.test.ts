import { describe, expect, it, vi } from 'vitest'
import { createInvoker, type HandlerMap } from '@main/ipc/register'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '@shared/ipc/channels'
import { ipcContract } from '@shared/ipc/contract'
import { AppError } from '@shared/ipc/result'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

function handlersReturning(value: unknown): HandlerMap {
  return Object.fromEntries(
    INVOKE_CHANNELS.map((channel) => [channel, vi.fn(async () => value)]),
  ) as unknown as HandlerMap
}

describe('contrato IPC', () => {
  it('a allowlist do preload é exatamente o conjunto de canais do contrato', () => {
    expect(new Set(Object.keys(ipcContract))).toEqual(new Set(INVOKE_CHANNELS))
    expect(INVOKE_CHANNELS).toHaveLength(Object.keys(ipcContract).length)
  })

  it('todo canal tem schema Zod de entrada', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(typeof ipcContract[channel].input.safeParse, channel).toBe('function')
    }
  })

  it('canais e eventos não se repetem', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length)
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length)
  })

  it('IDs de extensão e entrada da Chrome Web Store são validados no contrato', () => {
    const id = 'a'.repeat(32)
    expect(ipcContract['extensions.refresh'].input.safeParse({ id }).success).toBe(true)
    expect(ipcContract['extensions.refresh'].input.safeParse({ id: 'q'.repeat(32) }).success).toBe(false)
    expect(ipcContract['extensions.importWebStore'].input.safeParse({ input: id }).success).toBe(true)
    expect(
      ipcContract['extensions.importWebStore'].input.safeParse({ input: 'https://exemplo.com' }).success,
    ).toBe(false)
    expect(
      ipcContract['extensions.setConfig'].input.safeParse({
        id,
        config: { area: 'local', mode: 'once', json: '[1,2]' },
        reapply: false,
      }).success,
    ).toBe(false)
    expect(
      ipcContract['extensions.assign'].input.safeParse({
        extensionId: id,
        profileIds: 'allActive',
        enabled: true,
      }).success,
    ).toBe(true)
  })

  it('criação em massa aceita páginas iniciais http/https (opcionais) e recusa o resto', () => {
    const base = { count: 2, namePrefix: 'Lote', os: 'windows', groupId: null, proxyId: null, tagIds: [] }
    const input = ipcContract['profiles.bulkCreate'].input
    expect(input.safeParse(base).success).toBe(true)
    expect(input.safeParse({ ...base, startupUrls: [] }).success).toBe(true)
    expect(input.safeParse({ ...base, startupUrls: ['https://browserscan.net/'] }).success).toBe(true)
    for (const url of ['browserscan.net', 'javascript:alert(1)', 'file:///C:/Windows/win.ini'])
      expect(input.safeParse({ ...base, startupUrls: [url] }).success, url).toBe(false)
    expect(ipcContract['fingerprint.generate'].input.safeParse({ os: 'windows', fresh: true }).success).toBe(
      true,
    )
  })

  it('canais sem entrada aceitam chamada sem argumento', () => {
    for (const channel of [
      'app.getInfo',
      'settings.get',
      'groups.list',
      'proxies.list',
      'proxies.cancelCheck',
      'extensions.list',
      'settings.getGeoIpToken',
      'runtime.statuses',
    ] as const) {
      expect(ipcContract[channel].input.safeParse(undefined).success, channel).toBe(true)
    }
  })
})

describe('createInvoker', () => {
  it('recusa canal desconhecido', async () => {
    const invoke = createInvoker(handlersReturning('ok'))
    const result = await invoke('nada.existe', undefined)
    expect(result).toEqual({ ok: false, error: expect.objectContaining({ code: 'UNKNOWN_CHANNEL' }) })
  })

  it('valida a entrada antes de chamar o handler', async () => {
    const handlers = handlersReturning('ok')
    const invoke = createInvoker(handlers)
    const result = await invoke('profiles.get', { id: 'isto-nao-e-um-uuid' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION_ERROR')
      expect(result.error.details).toEqual([{ path: 'id', message: 'invalidId' }])
    }
    expect(handlers['profiles.get']).not.toHaveBeenCalled()
  })

  it('recusa flags reservadas nas opções de abertura', async () => {
    const invoke = createInvoker(handlersReturning('ok'))
    const result = await invoke('profiles.create', {
      name: 'Teste',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: {
        startupUrls: [],
        window: null,
        restoreTabs: false,
        extraArgs: ['--proxy-server=1.2.3.4:80'],
      },
    })
    expect(result.ok).toBe(false)
    if (!result.ok)
      expect(result.error.details).toEqual([{ path: 'launchOptions.extraArgs.0', message: 'reservedArg' }])
  })

  it('devolve os dados do handler em caso de sucesso', async () => {
    const invoke = createInvoker(handlersReturning({ count: 3 }))
    await expect(invoke('profiles.emptyTrash', undefined)).resolves.toEqual({ ok: true, data: { count: 3 } })
  })

  it('preserva o código de um AppError lançado pelo handler', async () => {
    const handlers = handlersReturning('ok')
    handlers['groups.delete'] = () => {
      throw new AppError('NOT_FOUND', 'sumiu', { entity: 'group' })
    }
    const invoke = createInvoker(handlers)
    const result = await invoke('groups.delete', { id: '7f1c2a4e-1b2c-4d3e-8f90-123456789abc' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'sumiu', details: { entity: 'group' } },
    })
  })

  it('transforma erro inesperado em INTERNAL e registra no log', async () => {
    const handlers = handlersReturning('ok')
    handlers['tags.list'] = () => {
      throw new Error('quebrou')
    }
    const logger = { error: vi.fn() }
    const invoke = createInvoker(handlers, logger)
    const result = await invoke('tags.list', undefined)
    expect(result).toEqual({ ok: false, error: { code: 'INTERNAL', message: 'quebrou' } })
    expect(logger.error).toHaveBeenCalledOnce()
  })
})
