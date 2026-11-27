import { beforeEach, describe, expect, it } from 'vitest'
import { bytesText as formatBytes, rateText as formatRate } from '../../src/renderer/lib/bytes'
import { TRAFFIC_SAMPLES, useTrafficStore } from '../../src/renderer/stores/traffic.store'

describe('tráfego dos perfis abertos (coluna Proxy)', () => {
  beforeEach(() => useTrafficStore.setState({ byProfile: {} }))

  it('formata bytes e taxa em base 1024, no idioma da interface', () => {
    expect(formatBytes(0, 'pt-BR')).toBe('0 B')
    expect(formatBytes(1536, 'pt-BR')).toBe('1,5 KB')
    expect(formatBytes(391_782, 'en')).toBe('383 KB')
    expect(formatBytes(7_130_316, 'pt-BR')).toBe('6,8 MB')
    expect(formatRate(391_782, 'en')).toBe('383 KB/s')
    expect(formatRate(-5, 'en')).toBe('0 B/s')
  })

  it('guarda o último minuto por perfil e esquece o perfil que fechou', () => {
    const { apply, clear } = useTrafficStore.getState()
    for (let second = 1; second <= TRAFFIC_SAMPLES + 5; second++)
      apply({ profileId: 'a', bytesPerSecond: second, total: second * 10, at: second })
    apply({ profileId: 'b', bytesPerSecond: 7, total: 7, at: 1 })
    const a = useTrafficStore.getState().byProfile.a!
    expect(a.samples).toHaveLength(TRAFFIC_SAMPLES)
    expect(a.samples[0]).toBe(6)
    expect(a.samples.at(-1)).toBe(TRAFFIC_SAMPLES + 5)
    expect(a).toMatchObject({ bytesPerSecond: TRAFFIC_SAMPLES + 5, total: (TRAFFIC_SAMPLES + 5) * 10 })
    clear('a')
    expect(Object.keys(useTrafficStore.getState().byProfile)).toEqual(['b'])
    // limpar um perfil sem tráfego não muda o estado
    const before = useTrafficStore.getState()
    clear('nenhum')
    expect(useTrafficStore.getState()).toBe(before)
  })
})
