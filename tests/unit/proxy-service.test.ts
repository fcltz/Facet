import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '@main/logger'
import { CheckLimiter, type ProxyChecker } from '@main/proxy/checker'
import type { ForwarderPool } from '@main/proxy/pool'
import type { rotateIp } from '@main/proxy/rotate'
import type { UpstreamProxy } from '@main/proxy/upstream'
import { createMemoryRepositories } from '@main/repositories/mock/memory'
import type { SettingsRepository } from '@main/repositories/types'
import { MockRuntime } from '@main/runtime/mock-runtime'
import { ProfileService } from '@main/services/profile.service'
import { ProxyService } from '@main/services/proxy.service'
import { AppError } from '@shared/ipc/result'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import { proxyCreateSchema, type ProxyCheckOutcome, type ProxyCreateInput } from '@shared/schemas/proxy'
import { DEFAULT_SETTINGS } from '@shared/schemas/settings'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const HOST = { timezone: 'America/Sao_Paulo', languages: ['pt-BR', 'pt', 'en-US', 'en'] }

function online(
  ip: string,
  countryCode: string,
  timezone: string,
  lat: number,
  lon: number,
): ProxyCheckOutcome {
  return {
    status: 'online',
    latencyMs: 42,
    exitIp: ip,
    countryCode,
    countryName: null,
    region: null,
    city: 'Cidade',
    timezone,
    latitude: lat,
    longitude: lon,
    error: null,
    checkedAt: NOW,
  }
}

const TOKYO = online('198.51.100.20', 'JP', 'Asia/Tokyo', 35.68, 139.69)
const SAO_PAULO = online('203.0.113.7', 'BR', 'America/Sao_Paulo', -23.55, -46.63)

function setup(
  options: { check?: (proxy: UpstreamProxy, signal?: AbortSignal) => Promise<ProxyCheckOutcome> } = {},
) {
  const settings: SettingsRepository = { load: () => ({ ...DEFAULT_SETTINGS }), save: () => undefined }
  const repos = createMemoryRepositories({ groups: [], tags: [], proxies: [], profiles: [] }, settings)
  const runtime = new MockRuntime({ startDelayMs: 1, stopDelayMs: 1, now: () => NOW })
  const emit = vi.fn()
  let counter = 0
  const newId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
  const check = vi.fn(options.check ?? (async () => TOKYO))
  const checker = { check, preflight: vi.fn() } as unknown as ProxyChecker
  const closeConnectionsForProxy = vi.fn((): string[] => ['perfil-aberto'])
  const pool = { closeConnectionsForProxy } as unknown as ForwarderPool
  const rotate = vi.fn<typeof rotateIp>(async () => ({ outcome: TOKYO, changed: true }))
  const proxies = new ProxyService({
    repos,
    checker,
    limiter: new CheckLimiter(8),
    pool,
    emit,
    now: () => NOW,
    newId,
    hostLocale: () => HOST,
    logger: silentLogger,
    rotate,
  })
  const requestProxyCheck = vi.fn()
  const profiles = new ProfileService({
    repos,
    runtime,
    emit,
    now: () => NOW,
    newId,
    hostTimezone: HOST.timezone,
    engineMajor: 158,
    language: () => 'pt-BR',
    logger: silentLogger,
    hostLocale: () => HOST,
    requestProxyCheck,
  })
  const createProxy = (input: Partial<ProxyCreateInput> = {}) =>
    proxies.create(
      proxyCreateSchema.parse({
        name: '',
        type: 'http',
        host: '1.2.3.4',
        port: 8080,
        username: '',
        password: '',
        changeIpUrl: '',
        notes: '',
        ...input,
      }),
    )
  const createProfile = (proxyId: string | null = null) =>
    profiles.create({
      name: `Perfil ${++counter}`,
      os: 'windows',
      groupId: null,
      proxyId,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
    })
  return {
    repos,
    emit,
    proxies,
    profiles,
    check,
    rotate,
    closeConnectionsForProxy,
    requestProxyCheck,
    createProxy,
    createProfile,
  }
}

function appError(fn: () => unknown): AppError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return error as AppError
  }
  throw new Error('esperava AppError')
}

describe('ProxyService', () => {
  it('guarda senha e URL de troca só no processo principal: o resumo e os eventos não as contêm', () => {
    const { repos, emit, createProxy } = setup()
    const proxy = createProxy({
      host: 'Proxy.Example.com',
      username: 'user',
      password: 'segredo-1',
      changeIpUrl: 'https://api.provider.example/rotate?key=chave-2',
    })
    expect(proxy).toMatchObject({ host: 'proxy.example.com', hasPassword: true, rotating: true })
    expect(proxy.changeIpHost).toBe('api.provider.example')
    const everything = JSON.stringify([proxy, emit.mock.calls])
    expect(everything).not.toContain('segredo-1')
    expect(everything).not.toContain('chave-2')
    expect(repos.proxies.secrets(proxy.id)).toEqual({
      password: 'segredo-1',
      changeIpUrl: 'https://api.provider.example/rotate?key=chave-2',
    })
  })

  it('recusa endereço duplicado e senha sem usuário', () => {
    const { createProxy } = setup()
    createProxy({ username: 'a' })
    const duplicate = appError(() => createProxy({ username: 'a' }))
    expect(duplicate.code).toBe('CONFLICT')
    expect(duplicate.details).toMatchObject({ reason: 'duplicateEndpoint' })
    expect(appError(() => createProxy({ host: '5.6.7.8', password: 'x' })).code).toBe('VALIDATION_ERROR')
  })

  it('mudar endereço ou senha zera a verificação; mudar só o nome não', async () => {
    const { proxies, createProxy } = setup()
    const proxy = createProxy()
    await proxies.check([proxy.id])
    expect(proxies.update(proxy.id, { name: 'Novo nome' })).toMatchObject({
      checkStatus: 'online',
      exitIp: TOKYO.exitIp,
    })
    expect(proxies.update(proxy.id, { username: 'u', password: { mode: 'set', value: 'p' } })).toMatchObject({
      checkStatus: 'unknown',
      exitIp: null,
      hasPassword: true,
    })
  })

  it('excluir proxy em uso exige confirmação e devolve os perfis à conexão direta desta máquina', async () => {
    const { repos, emit, proxies, profiles, createProxy, createProfile } = setup()
    const proxy = createProxy()
    await proxies.check([proxy.id])
    const profile = createProfile(proxy.id)
    expect(profile.fingerprint.timezone.id).toBe('Asia/Tokyo')
    const refused = appError(() => proxies.delete([proxy.id], false))
    expect(refused.code).toBe('PROXY_IN_USE')
    expect(refused.details).toEqual({ profiles: 1 })
    expect(repos.proxies.get(proxy.id)).not.toBeNull()

    expect(proxies.delete([proxy.id], true)).toEqual({ count: 1, detachedProfiles: 1 })
    const detached = profiles.get(profile.id)
    expect(detached.proxyId).toBeNull()
    expect(detached.fingerprint.timezone.id).toBe(HOST.timezone)
    expect(detached.fingerprint.languages.list).toEqual(HOST.languages)
    expect(emit).toHaveBeenCalledWith('proxies.changed', { upserted: [], removedIds: [proxy.id] })
  })

  it('importação: prévia linha a linha e grava só os proxies novos', () => {
    const { proxies, createProxy } = setup()
    createProxy({ host: '1.2.3.4', port: 80 })
    const text = ['1.2.3.4:80', '5.6.7.8:3128:user:pass', '5.6.7.8:3128:user:pass', 'não é proxy'].join('\n')
    const preview = proxies.parseImport(text, 'http')
    expect(preview.lines.map((line) => [line.status, line.error])).toEqual([
      ['duplicate', 'alreadyExists'],
      ['ok', null],
      ['duplicate', 'duplicateInList'],
      ['invalid', 'invalidFormat'],
    ])
    expect(preview).toMatchObject({ valid: 1, duplicates: 2, invalid: 1, truncated: false })
    expect(JSON.stringify(preview)).not.toContain('pass')

    const result = proxies.import(text, 'http', false)
    expect(result).toMatchObject({ invalid: 1, duplicates: 2 })
    expect(result.created).toHaveLength(1)
    expect(result.created[0]).toMatchObject({
      host: '5.6.7.8',
      port: 3128,
      username: 'user',
      hasPassword: true,
    })
    expect(proxies.list()).toHaveLength(2)
  })

  it('verificação grava a geolocalização, sincroniza os perfis automáticos e emite o progresso', async () => {
    const { repos, emit, proxies, profiles, createProxy, createProfile, requestProxyCheck } = setup()
    const proxy = createProxy()
    const profile = createProfile()
    profiles.assignProxy([profile.id], proxy.id)
    // proxy nunca verificado: a atribuição pede uma verificação em segundo plano
    expect(requestProxyCheck).toHaveBeenCalledWith(proxy.id)

    const [result] = await proxies.check([proxy.id])
    expect(result?.outcome.status).toBe('online')
    expect(repos.proxies.get(proxy.id)).toMatchObject({
      checkStatus: 'online',
      countryCode: 'JP',
      exitIp: TOKYO.exitIp,
    })
    const synced = profiles.get(profile.id).fingerprint
    expect(synced.timezone.id).toBe('Asia/Tokyo')
    expect(synced.languages.list).toEqual(['ja-JP', 'ja', 'en-US', 'en'])
    expect(synced.geolocation).toMatchObject({ latitude: 35.68, longitude: 139.69 })
    const progress = emit.mock.calls.filter(([event]) => event === 'proxies.checkProgress').map(([, p]) => p)
    expect(progress.at(-1)).toEqual({ running: false, total: 1, done: 1, online: 1, offline: 0 })
  })

  it('proxy que sai pelo IP real: grava offline com IP e local, sem sincronizar os perfis', async () => {
    const leak: ProxyCheckOutcome = {
      ...SAO_PAULO,
      status: 'offline',
      latencyMs: null,
      error: {
        code: 'PROXY_REAL_IP',
        message: 'O proxy está saindo pelo IP real desta conexão',
        details: { ip: SAO_PAULO.exitIp, reason: 'realIp' },
      },
    }
    const timeout: ProxyCheckOutcome = {
      ...leak,
      exitIp: null,
      countryCode: null,
      city: null,
      timezone: null,
      latitude: null,
      longitude: null,
      error: { code: 'PROXY_TIMEOUT', message: 'O proxy não respondeu a tempo' },
    }
    let next = leak
    const { repos, emit, proxies, profiles, createProxy, createProfile } = setup({ check: async () => next })
    const proxy = createProxy()
    const profile = createProfile()
    profiles.assignProxy([profile.id], proxy.id)
    const before = profiles.get(profile.id).fingerprint

    const [result] = await proxies.check([proxy.id])
    expect(result?.outcome.error?.code).toBe('PROXY_REAL_IP')
    expect(repos.proxies.get(proxy.id)).toMatchObject({
      checkStatus: 'offline',
      lastErrorCode: 'PROXY_REAL_IP',
      exitIp: SAO_PAULO.exitIp,
      countryCode: 'BR',
      timezone: 'America/Sao_Paulo',
      latencyMs: null,
    })
    expect(profiles.get(profile.id).fingerprint).toEqual(before)
    const progress = emit.mock.calls.filter(([event]) => event === 'proxies.checkProgress').map(([, p]) => p)
    expect(progress.at(-1)).toEqual({ running: false, total: 1, done: 1, online: 0, offline: 1 })

    // falha comum (sem IP medido) mantém o último IP e local conhecidos
    next = timeout
    await proxies.check([proxy.id])
    expect(repos.proxies.get(proxy.id)).toMatchObject({
      checkStatus: 'offline',
      lastErrorCode: 'PROXY_TIMEOUT',
      exitIp: SAO_PAULO.exitIp,
      countryCode: 'BR',
    })
  })

  it('cancelar a verificação não grava resultado', async () => {
    const { repos, proxies, createProxy } = setup({
      check: (_proxy, signal) =>
        new Promise<ProxyCheckOutcome>((_done, fail) =>
          signal?.addEventListener('abort', () => fail(new AppError('CANCELLED', 'cancelado')), {
            once: true,
          }),
        ),
    })
    const proxy = createProxy()
    const running = proxies.check([proxy.id])
    await vi.waitFor(() => expect(proxies['progress'].total).toBe(1))
    proxies.cancelCheck()
    const [result] = await running
    expect(result?.outcome.error?.code).toBe('CANCELLED')
    expect(repos.proxies.get(proxy.id)?.checkStatus).toBe('unknown')
  })

  it('testar conexão usa a senha guardada quando o formulário não a troca', async () => {
    const { proxies, check, createProxy } = setup()
    const proxy = createProxy({ username: 'user', password: 'guardada' })
    const base = { id: proxy.id, type: 'http' as const, host: '1.2.3.4', port: 8080, username: 'user' }
    await proxies.testDraft({ ...base, password: { mode: 'keep' } })
    await proxies.testDraft({ ...base, password: { mode: 'set', value: 'nova' } })
    await proxies.testDraft({ ...base, id: null, username: '', password: { mode: 'keep' } })
    expect(check.mock.calls.map(([upstream]) => upstream.password)).toEqual(['guardada', 'nova', null])
  })

  it('trocar IP chama a URL decifrada, grava o IP novo e derruba as conexões abertas', async () => {
    const { proxies, rotate, closeConnectionsForProxy, createProxy } = setup({ check: async () => SAO_PAULO })
    const proxy = createProxy({ changeIpUrl: 'https://api.provider.example/rotate?key=k1' })
    await proxies.check([proxy.id])
    const result = await proxies.rotate(proxy.id)
    expect(rotate).toHaveBeenCalledWith(
      expect.objectContaining({
        changeIpUrl: 'https://api.provider.example/rotate?key=k1',
        previousIp: SAO_PAULO.exitIp,
      }),
    )
    expect(result).toMatchObject({
      previousIp: SAO_PAULO.exitIp,
      currentIp: TOKYO.exitIp,
      changed: true,
      countryChanged: true,
      runningProfileIds: ['perfil-aberto'],
    })
    expect(result.proxy).toMatchObject({ exitIp: TOKYO.exitIp, countryCode: 'JP' })
    expect(closeConnectionsForProxy).toHaveBeenCalledWith(proxy.id)

    const plain = createProxy({ host: '9.9.9.9' })
    await expect(proxies.rotate(plain.id)).rejects.toMatchObject({ code: 'PROXY_ROTATE_FAILED' })
  })

  it('o proxy do perfil aberto é lido com a senha decifrada; proxy excluído vira PROXY_UNAVAILABLE', () => {
    const { proxies, createProxy } = setup()
    const proxy = createProxy({ username: 'user', password: 'p@ss' })
    expect(proxies.upstream(proxy.id)).toEqual({
      type: 'http',
      host: '1.2.3.4',
      port: 8080,
      username: 'user',
      password: 'p@ss',
    })
    proxies.delete([proxy.id], false)
    expect(appError(() => proxies.upstream(proxy.id)).code).toBe('PROXY_UNAVAILABLE')
  })

  it('a senha salva vai só para o formulário de edição; as listas continuam sem ela', () => {
    const { proxies, createProxy } = setup()
    const withPassword = createProxy({ username: 'user', password: 'p@ss:w/rd' })
    const without = createProxy({ host: '5.6.7.8' })
    expect(proxies.password(withPassword.id)).toEqual({ password: 'p@ss:w/rd' })
    expect(proxies.password(without.id)).toEqual({ password: null })
    expect(JSON.stringify([proxies.list(), proxies.get(withPassword.id)])).not.toContain('p@ss:w/rd')
    // trocar e remover a senha pelo campo
    proxies.update(withPassword.id, { password: { mode: 'set', value: 'nova' } })
    expect(proxies.password(withPassword.id)).toEqual({ password: 'nova' })
    proxies.update(withPassword.id, { password: { mode: 'clear' } })
    expect(proxies.password(withPassword.id)).toEqual({ password: null })
    expect(proxies.get(withPassword.id).hasPassword).toBe(false)
    expect(appError(() => proxies.password('00000000-0000-4000-8000-999999999999')).code).toBe('NOT_FOUND')
  })
})
