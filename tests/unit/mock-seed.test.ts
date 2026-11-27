import { describe, expect, it } from 'vitest'
import { createMockSeed, SeededRandom } from '@main/repositories/mock/seed'
import { idSchema } from '@shared/schemas/common'
import { fingerprintSchema } from '@shared/schemas/fingerprint'
import { launchOptionsSchema } from '@shared/schemas/profile'

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)

describe('dados de demonstração', () => {
  it('são determinísticos: mesma semente, mesmos dados', () => {
    expect(createMockSeed({ now: NOW })).toEqual(createMockSeed({ now: NOW }))
    expect(createMockSeed({ now: NOW, seed: 1 })).not.toEqual(createMockSeed({ now: NOW, seed: 2 }))
  })

  it('têm as quantidades esperadas', () => {
    const seed = createMockSeed({ now: NOW })
    expect(seed.groups).toHaveLength(6)
    expect(seed.tags).toHaveLength(10)
    expect(seed.proxies).toHaveLength(15)
    expect(seed.profiles.filter((p) => p.deletedAt === null)).toHaveLength(120)
    expect(seed.profiles.filter((p) => p.deletedAt !== null)).toHaveLength(4)
  })

  it('não têm referências quebradas', () => {
    const seed = createMockSeed({ now: NOW })
    const groupIds = new Set(seed.groups.map((g) => g.id))
    const tagIds = new Set(seed.tags.map((t) => t.id))
    const proxyIds = new Set(seed.proxies.map((p) => p.id))
    for (const profile of seed.profiles) {
      if (profile.groupId) expect(groupIds.has(profile.groupId)).toBe(true)
      if (profile.proxyId) expect(proxyIds.has(profile.proxyId)).toBe(true)
      for (const tagId of profile.tagIds) expect(tagIds.has(tagId)).toBe(true)
    }
  })

  it('usam IDs válidos e JSON que passa nos schemas', () => {
    const seed = createMockSeed({ now: NOW })
    const ids = [...seed.groups, ...seed.tags, ...seed.proxies, ...seed.profiles].map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(idSchema.safeParse(id).success, id).toBe(true)
    for (const profile of seed.profiles) {
      expect(fingerprintSchema.safeParse(profile.fingerprint).success, profile.name).toBe(true)
      expect(launchOptionsSchema.safeParse(profile.launchOptions).success, profile.name).toBe(true)
      expect(profile.userAgent).toBe(profile.fingerprint.userAgent)
    }
  })

  it('datas são coerentes (criação ≤ última abertura ≤ agora)', () => {
    const seed = createMockSeed({ now: NOW })
    for (const profile of seed.profiles) {
      expect(profile.createdAt).toBeLessThanOrEqual(NOW)
      if (profile.lastOpenedAt !== null) {
        expect(profile.lastOpenedAt).toBeGreaterThanOrEqual(profile.createdAt)
        expect(profile.lastOpenedAt).toBeLessThanOrEqual(NOW)
      }
    }
  })

  it('usam só IPs de documentação (RFC 5737) e hosts .example', () => {
    const seed = createMockSeed({ now: NOW })
    for (const proxy of seed.proxies) {
      expect(proxy.host.endsWith('.example')).toBe(true)
      if (proxy.exitIp) expect(proxy.exitIp).toMatch(/^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/)
    }
  })

  it('SeededRandom gera UUID v4 válido', () => {
    const rng = new SeededRandom(42)
    for (let i = 0; i < 50; i++)
      expect(rng.uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
