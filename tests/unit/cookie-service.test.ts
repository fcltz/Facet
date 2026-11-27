import { describe, expect, it, vi } from 'vitest'
import { AppError } from '@shared/ipc/result'
import type { BrowserCookie } from '@shared/schemas/cookies'
import { DEFAULT_LAUNCH_OPTIONS, type Profile } from '@shared/schemas/profile'
import { createDefaultFingerprint } from '@shared/schemas/fingerprint'
import { DEFAULT_SETTINGS } from '@shared/schemas/settings'
import type { CdpClient } from '@main/browser/cdp/client'
import { writeCookies } from '@main/cookies/cdp'
import { silentLogger } from '@main/logger'
import { createMemoryRepositories } from '@main/repositories/mock/memory'
import { MockRuntime } from '@main/runtime/mock-runtime'
import { CookieService, PendingCookieApplier } from '@main/services/cookie.service'

const NOW = Date.UTC(2026, 10, 26)
const FUTURE = NOW / 1000 + 86400

const cookie = (name: string, patch: Partial<BrowserCookie> = {}): BrowserCookie => ({
  name,
  value: 'v',
  domain: '.example.com',
  path: '/',
  expires: FUTURE,
  httpOnly: false,
  secure: false,
  sameSite: null,
  partitionKey: null,
  ...patch,
})

function profile(id: string): Profile {
  const fingerprint = createDefaultFingerprint({ os: 'windows', engineMajor: 158, timezone: 'UTC' })
  return {
    id,
    serial: 1,
    name: 'Perfil',
    browser: 'brave',
    groupId: null,
    proxyId: null,
    tagIds: [],
    extensionIds: [],
    color: null,
    notes: '',
    os: 'windows',
    userAgent: fingerprint.userAgent,
    fingerprint,
    launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
    lastOpenedAt: null,
    lastClosedAt: null,
    openCount: 0,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

const ID = '11111111-1111-4111-8111-111111111111'

function setup() {
  const settings = { load: () => ({ ...DEFAULT_SETTINGS }), save: vi.fn() }
  const repos = createMemoryRepositories(
    { groups: [], tags: [], proxies: [], profiles: [profile(ID)] },
    settings,
  )
  const runtime = new MockRuntime({ startDelayMs: 1, stopDelayMs: 1 })
  const service = new CookieService({ repos, runtime, now: () => NOW, logger: silentLogger })
  return { repos, runtime, service }
}

describe('gravação via CDP', () => {
  it('refaz um a um o lote recusado e aponta o cookie que o Brave rejeitou', async () => {
    const calls: number[] = []
    const client = {
      send: vi.fn(async (_method: string, params: { cookies: { name: string }[] }) => {
        calls.push(params.cookies.length)
        if (params.cookies.some((item) => item.name === 'bad'))
          throw new AppError('BROWSER_START_FAILED', 'Invalid cookie fields')
        return {}
      }),
    } as unknown as CdpClient
    const result = await writeCookies(client, [cookie('a'), cookie('bad'), cookie('c')])
    expect(result.imported).toBe(2)
    expect(result.failed).toEqual([{ name: 'bad', domain: '.example.com', reason: 'Invalid cookie fields' }])
    expect(calls).toEqual([3, 1, 1, 1])
  })

  it('conexão perdida interrompe a gravação', async () => {
    const client = {
      send: vi.fn(async () => {
        throw new AppError('BROWSER_DISCONNECTED', 'Conexão CDP perdida')
      }),
    } as unknown as CdpClient
    await expect(writeCookies(client, [cookie('a')])).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' })
  })
})

describe('serviço de cookies', () => {
  it('perfil fechado: importação fica pendente, acumula e descarta inválidos e vencidos', async () => {
    const { service } = setup()
    const first = await service.import(ID, [
      cookie('a'),
      cookie('__Secure-x'),
      cookie('old', { expires: NOW / 1000 - 5 }),
    ])
    expect(first).toEqual({
      applied: 'pending',
      imported: 1,
      failed: [{ name: '__Secure-x', domain: '.example.com', reason: 'securePrefix' }],
      pending: 1,
    })
    const second = await service.import(ID, [cookie('a', { value: 'novo' }), cookie('b')])
    expect(second.pending).toBe(2)
    expect(service.status(ID)).toEqual({ pending: 2, pendingAt: NOW, running: false })
    // Sem navegador (simulação): a exportação traz os pendentes, com o valor novo.
    const exported = await service.export(ID, 'json')
    expect(exported.count).toBe(2)
    expect(JSON.parse(exported.text)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'a', value: 'novo' })]),
    )
    expect(service.clearPending(ID).pending).toBe(0)
  })

  it('perfil inexistente ou na lixeira', async () => {
    const { repos, service } = setup()
    await expect(service.import('22222222-2222-4222-8222-222222222222', [cookie('a')])).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    )
    repos.profiles.update(ID, { deletedAt: NOW })
    await expect(service.import(ID, [cookie('a')])).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})

describe('aplicação dos pendentes na abertura', () => {
  it('grava, limpa os pendentes e avisa o resultado', async () => {
    const { repos } = setup()
    repos.pendingCookies.add(ID, [cookie('a'), cookie('b')], NOW)
    const emit = vi.fn()
    const client = { send: vi.fn(async () => ({})) } as unknown as CdpClient
    await new PendingCookieApplier({
      repo: repos.pendingCookies,
      emit,
      logger: silentLogger,
      now: () => NOW,
    }).applyPending(ID, client, new AbortController().signal)
    expect(client.send).toHaveBeenCalledWith(
      'Storage.setCookies',
      expect.objectContaining({ cookies: expect.any(Array) }),
      undefined,
      15000,
    )
    expect(repos.pendingCookies.status(ID)).toBeNull()
    expect(emit).toHaveBeenCalledWith('cookies.applied', {
      profileId: ID,
      imported: 2,
      failed: 0,
      error: null,
    })
  })

  it('falha na gravação mantém os pendentes para a próxima abertura', async () => {
    const { repos } = setup()
    repos.pendingCookies.add(ID, [cookie('a')], NOW)
    const emit = vi.fn()
    const client = {
      send: vi.fn(async () => {
        throw new AppError('BROWSER_DISCONNECTED', 'Conexão CDP perdida')
      }),
    } as unknown as CdpClient
    await new PendingCookieApplier({
      repo: repos.pendingCookies,
      emit,
      logger: silentLogger,
      now: () => NOW,
    }).applyPending(ID, client, new AbortController().signal)
    expect(repos.pendingCookies.status(ID)?.count).toBe(1)
    expect(emit).toHaveBeenCalledWith(
      'cookies.applied',
      expect.objectContaining({ imported: 0, error: 'Conexão CDP perdida' }),
    )
  })
})
