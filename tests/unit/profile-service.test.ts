import { describe, expect, it, vi } from 'vitest'
import { silentLogger } from '@main/logger'
import { createMemoryRepositories } from '@main/repositories/mock/memory'
import { createMockSeed } from '@main/repositories/mock/seed'
import type { SettingsRepository } from '@main/repositories/types'
import { MockRuntime } from '@main/runtime/mock-runtime'
import { GroupService } from '@main/services/group-tag.service'
import { cloneName, ProfileService } from '@main/services/profile.service'
import { TrashService } from '@main/services/trash.service'
import { AppError } from '@shared/ipc/result'
import { fingerprintKey, fingerprintSchema } from '@shared/schemas/fingerprint'
import {
  DEFAULT_LAUNCH_OPTIONS,
  formatSerial,
  profileLabel,
  sequentialNames,
  type ProfileCreateInput,
} from '@shared/schemas/profile'
import { DEFAULT_SETTINGS } from '@shared/schemas/settings'

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)
const MISSING_ID = '7f1c2a4e-1b2c-4d3e-8f90-123456789abc'

function setup() {
  const settings: SettingsRepository = { load: () => ({ ...DEFAULT_SETTINGS }), save: () => undefined }
  const seed = createMockSeed({ now: NOW, activeProfiles: 6, trashedProfiles: 1 })
  const repos = createMemoryRepositories(seed, settings)
  const runtime = new MockRuntime({ startDelayMs: 1, stopDelayMs: 1, now: () => NOW })
  const emit = vi.fn()
  let counter = 0
  const newId = (): string => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
  const profiles = new ProfileService({
    repos,
    runtime,
    emit,
    now: () => NOW,
    newId,
    hostTimezone: 'America/Sao_Paulo',
    engineMajor: 158,
    language: () => 'pt-BR',
    logger: silentLogger,
  })
  const trash = new TrashService({ repos, runtime, emit, now: () => NOW })
  const groups = new GroupService({ repos, emit, now: () => NOW, newId })
  return { seed, repos, runtime, emit, profiles, trash, groups }
}

function input(overrides: Partial<ProfileCreateInput> = {}): ProfileCreateInput {
  return {
    name: 'Loja Teste',
    os: 'windows',
    groupId: null,
    proxyId: null,
    tagIds: [],
    color: null,
    notes: '',
    launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
    ...overrides,
  }
}

function expectAppError(fn: () => unknown, code: AppError['code']): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
    return
  }
  throw new Error(`esperava AppError ${code}`)
}

describe('ProfileService', () => {
  it('cria perfil com fingerprint coerente com o sistema e emite o evento', () => {
    const { profiles, emit } = setup()
    const profile = profiles.create(input({ os: 'macos' }))
    expect(() => fingerprintSchema.parse(profile.fingerprint)).not.toThrow()
    expect(profile.fingerprint.navigator.platform).toBe('MacIntel')
    expect(profile.userAgent).toContain('Macintosh')
    expect(profile.userAgent).toContain('Chrome/158.0.0.0')
    expect(profile.fingerprint.mode).toBe('emulated')
    expect([4, 8]).toContain(profile.fingerprint.navigator.deviceMemory)
    expect(emit).toHaveBeenCalledWith(
      'profiles.changed',
      expect.objectContaining({
        upserted: [expect.objectContaining({ id: profile.id, name: 'Loja Teste' })],
      }),
    )
  })

  it('perfil novo vem em Emulação também no sistema desta máquina, com hardware sorteado', () => {
    const { profiles } = setup()
    for (const os of ['windows', 'macos', 'linux'] as const) {
      const profile = profiles.create(input({ name: `Novo ${os}`, os }))
      expect(profile.fingerprint.mode).toBe('emulated')
      expect(profile.fingerprint.os).toBe(os)
      expect(fingerprintKey(profile.fingerprint)).not.toBeNull()
    }
  })

  it('perfis novos (um a um, em massa e cópias) nunca repetem o hardware de outro, nem de um excluído', async () => {
    const { profiles, trash, repos } = setup()
    const keys = new Set<string>()
    const remember = (fingerprint: Parameters<typeof fingerprintKey>[0]): void => {
      const key = fingerprintKey(fingerprint)!
      expect(keys.has(key), key).toBe(false)
      keys.add(key)
    }
    const single = profiles.create(input({ name: 'Único' }))
    remember(single.fingerprint)
    const bulk = profiles.bulkCreate({
      count: 40,
      namePrefix: 'Lote',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
    })
    for (const item of bulk) remember(repos.profiles.get(item.id)!.fingerprint)
    remember(profiles.clone(single.id).fingerprint)
    // excluído de vez: a combinação dele não volta para um perfil novo
    await trash.trash([single.id])
    await trash.deletePermanently([single.id])
    expect(repos.profiles.fingerprintUsage().used.has(fingerprintKey(single.fingerprint)!)).toBe(true)
    remember(profiles.create(input({ name: 'Depois' })).fingerprint)
  })

  it('cria em massa com a página inicial informada (vazio = a página das Configurações)', () => {
    const { profiles, repos } = setup()
    const base = { count: 2, os: 'linux' as const, groupId: null, proxyId: null, tagIds: [] }
    const withPage = profiles.bulkCreate({
      ...base,
      namePrefix: 'Com',
      startupUrls: ['https://example.com/'],
    })
    const withoutPage = profiles.bulkCreate({ ...base, namePrefix: 'Sem' })
    for (const item of withPage)
      expect(repos.profiles.get(item.id)!.launchOptions.startupUrls).toEqual(['https://example.com/'])
    for (const item of withoutPage) expect(repos.profiles.get(item.id)!.launchOptions.startupUrls).toEqual([])
    // cada perfil tem a própria lista (alterar um não mexe no outro)
    const [first, second] = withPage
    profiles.update(first!.id, {
      launchOptions: { ...repos.profiles.get(first!.id)!.launchOptions, startupUrls: [] },
    })
    expect(repos.profiles.get(second!.id)!.launchOptions.startupUrls).toEqual(['https://example.com/'])
  })

  it('usa o fuso horário do proxy no fingerprint', () => {
    const { profiles, seed } = setup()
    const proxy = seed.proxies.find((p) => p.timezone && p.timezone !== 'America/Sao_Paulo')
    expect(proxy).toBeDefined()
    const profile = profiles.create(input({ proxyId: proxy?.id ?? null }))
    expect(profile.fingerprint.timezone).toEqual({ mode: 'auto', id: proxy?.timezone })
  })

  it('recusa grupo, tag ou proxy inexistente', () => {
    const { profiles } = setup()
    expectAppError(() => profiles.create(input({ groupId: MISSING_ID })), 'NOT_FOUND')
    expectAppError(() => profiles.create(input({ tagIds: [MISSING_ID] })), 'NOT_FOUND')
    expectAppError(() => profiles.create(input({ proxyId: MISSING_ID })), 'NOT_FOUND')
  })

  it('clona sem repetir nome e com fingerprint próprio', () => {
    const { profiles, seed } = setup()
    const tag = seed.tags[0]
    const original = profiles.create(input({ tagIds: tag ? [tag.id] : [] }))
    const first = profiles.clone(original.id)
    const second = profiles.clone(original.id)
    expect(first.name).toBe('Loja Teste (cópia)')
    expect(second.name).toBe('Loja Teste (cópia 2)')
    expect(first.id).not.toBe(original.id)
    expect(first.tagIds).toEqual(original.tagIds)
    expect(first.openCount).toBe(0)
    expect(first.fingerprint).not.toBe(original.fingerprint)
  })

  it('perfil novo recebe as extensões padrão; clone copia a lista; ID inexistente é recusado', () => {
    const { profiles, repos } = setup()
    const extension = (id: string, name: string) =>
      repos.extensions.savePackage(
        {
          id,
          name,
          version: '1.0',
          description: '',
          manifestVersion: 3,
          source: 'zip',
          publicKey: 'k',
          dirName: '00000000',
          icon: null,
          permissions: [],
          sizeBytes: 1,
        },
        NOW,
      )
    const standard = 'a'.repeat(32)
    const extra = 'b'.repeat(32)
    extension(standard, 'Padrão')
    extension(extra, 'Extra')
    repos.extensions.setDefault([standard], true, NOW)
    expect(profiles.create(input()).extensionIds).toEqual([standard])
    const custom = profiles.create(input({ name: 'Escolhidas', extensionIds: [extra, extra] }))
    expect(custom.extensionIds).toEqual([extra])
    expect(profiles.clone(custom.id).extensionIds).toEqual([extra])
    expect(profiles.update(custom.id, { extensionIds: [] }).extensionIds).toEqual([])
    expectAppError(() => profiles.create(input({ extensionIds: ['c'.repeat(32)] })), 'NOT_FOUND')
  })

  it('nome de clone parte do nome original, mesmo clonando uma cópia', () => {
    expect(cloneName('Loja (cópia)', new Set(['Loja (cópia)']), 'pt-BR')).toBe('Loja (cópia 2)')
    expect(cloneName('Shop', new Set(), 'en')).toBe('Shop (copy)')
  })

  it('cria em massa continuando a numeração existente', () => {
    const { profiles } = setup()
    const first = profiles.bulkCreate({
      count: 3,
      namePrefix: 'Perfil',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
    })
    const second = profiles.bulkCreate({
      count: 2,
      namePrefix: 'Perfil',
      os: 'linux',
      groupId: null,
      proxyId: null,
      tagIds: [],
    })
    expect(first.map((p) => p.name)).toEqual(['Perfil 01', 'Perfil 02', 'Perfil 03'])
    expect(second.map((p) => p.name)).toEqual(['Perfil 04', 'Perfil 05'])
    expect(new Set([...first, ...second].map((p) => p.id)).size).toBe(5)
  })

  it('sequentialNames ignora nomes de outros prefixos e ajusta os zeros', () => {
    expect(sequentialNames('Perfil', 3, ['Perfil 07', 'Outro 99', 'Perfil x'])).toEqual([
      'Perfil 08',
      'Perfil 09',
      'Perfil 10',
    ])
    expect(sequentialNames('Ads', 1, ['Ads 099'])).toEqual(['Ads 100'])
  })

  it('trocar o sistema gera um fingerprint novo para o novo sistema', () => {
    const { profiles } = setup()
    const profile = profiles.create(input({ os: 'windows' }))
    const updated = profiles.update(profile.id, { os: 'linux' })
    expect(updated.fingerprint.os).toBe('linux')
    expect(updated.userAgent).toContain('X11; Linux x86_64')
    const renamed = profiles.update(profile.id, { name: 'Outro nome' })
    expect(renamed.fingerprint).toEqual(updated.fingerprint)
  })

  it('abrir registra a última abertura e o contador', async () => {
    const { profiles, repos, runtime } = setup()
    const profile = profiles.create(input())
    const result = await profiles.start([profile.id])
    expect(result).toEqual({ done: [profile.id], failed: [] })
    expect(runtime.status(profile.id)).toBe('running')
    expect(repos.profiles.get(profile.id)).toMatchObject({ lastOpenedAt: NOW, openCount: 1 })
    await profiles.stop([profile.id])
    expect(runtime.status(profile.id)).toBe('stopped')
  })

  it('atribuir proxy a perfil aberto informa que é preciso reiniciar', async () => {
    const { profiles, seed } = setup()
    const profile = profiles.create(input())
    await profiles.start([profile.id])
    const proxy = seed.proxies[0]
    const result = profiles.assignProxy([profile.id], proxy?.id ?? null)
    expect(result.runningIds).toEqual([profile.id])
    expect(result.updated[0]?.proxyId).toBe(proxy?.id)
  })
})

describe('TrashService', () => {
  it('fecha o perfil aberto, manda para a lixeira e restaura', async () => {
    const { profiles, trash, repos, runtime } = setup()
    const profile = profiles.create(input())
    await profiles.start([profile.id])
    await expect(trash.trash([profile.id])).resolves.toEqual({ count: 1 })
    expect(runtime.status(profile.id)).toBe('stopped')
    expect(repos.profiles.get(profile.id)?.deletedAt).toBe(NOW)
    expect(trash.restore([profile.id])).toEqual({ count: 1 })
    expect(repos.profiles.get(profile.id)?.deletedAt).toBeNull()
  })

  it('excluir definitivamente só remove o que está na lixeira', async () => {
    const { profiles, trash, repos } = setup()
    const profile = profiles.create(input())
    expect(await trash.deletePermanently([profile.id])).toEqual({ count: 0 })
    await trash.trash([profile.id])
    expect(await trash.deletePermanently([profile.id])).toEqual({ count: 1 })
    expect(repos.profiles.get(profile.id)).toBeNull()
  })

  it('numera os perfis em sequência (criar, em massa, clonar) sem reaproveitar números excluídos', async () => {
    const { seed, profiles, trash, repos } = setup()
    // seed: 1, 2, 3… pela ordem de criação, como a migration 0006
    const seeded = [...seed.profiles].sort((a, b) => a.createdAt - b.createdAt)
    expect(seeded.map((p) => p.serial)).toEqual(seeded.map((_, index) => index + 1))
    const last = seeded.length

    const created = profiles.create(input({ name: 'Numerado' }))
    expect(created.serial).toBe(last + 1)
    const bulk = profiles.bulkCreate({
      count: 3,
      namePrefix: 'Lote',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
    })
    expect(bulk.map((p) => [p.name, p.serial])).toEqual([
      ['Lote 01', last + 2],
      ['Lote 02', last + 3],
      ['Lote 03', last + 4],
    ])
    const copy = profiles.clone(created.id)
    expect(copy.serial).toBe(last + 5)
    expect(repos.profiles.get(created.id)?.serial).toBe(last + 1)

    // o maior número sai de vez: o próximo perfil não o reaproveita
    await trash.trash([copy.id])
    await trash.deletePermanently([copy.id])
    expect(profiles.create(input({ name: 'Depois da exclusão' })).serial).toBe(last + 6)
    // editar não muda o número
    expect(profiles.update(created.id, { name: 'Renomeado' }).serial).toBe(last + 1)
  })

  it('formata o número com dois dígitos e monta o rótulo "01 · Nome"', () => {
    expect([1, 9, 10, 99, 100, 1234].map(formatSerial)).toEqual(['01', '09', '10', '99', '100', '1234'])
    expect(profileLabel({ serial: 2, name: 'Loja' })).toBe('02 · Loja')
  })

  it('esvaziar a lixeira remove todos os perfis excluídos', async () => {
    const { trash, repos } = setup()
    const before = repos.profiles.list('trash').length
    expect(before).toBeGreaterThan(0)
    expect(await trash.emptyTrash()).toEqual({ count: before })
    expect(repos.profiles.list('trash')).toHaveLength(0)
  })
})

describe('GroupService', () => {
  it('excluir um grupo deixa os perfis sem grupo', () => {
    const { profiles, groups, repos } = setup()
    const group = groups.create({ name: 'Novo grupo', color: '#5B5BF7' })
    const profile = profiles.create(input({ groupId: group.id }))
    expect(groups.delete(group.id)).toEqual({ affectedProfiles: 1 })
    expect(repos.profiles.get(profile.id)?.groupId).toBeNull()
  })

  it('recusa nome duplicado sem diferenciar maiúsculas', () => {
    const { groups } = setup()
    expectAppError(() => groups.create({ name: 'qa', color: '#5B5BF7' }), 'CONFLICT')
  })
})
