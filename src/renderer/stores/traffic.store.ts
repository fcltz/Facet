import { create } from 'zustand'
import type { RuntimeTrafficEvent } from '@shared/ipc/events'

/** Amostras guardadas por perfil (uma por segundo: o gráfico mostra o último minuto). */
export const TRAFFIC_SAMPLES = 60

export interface ProfileTraffic {
  /** Bytes por segundo, da mais antiga para a mais recente. */
  samples: number[]
  bytesPerSecond: number
  /** Total trocado com a proxy remota desde que o perfil abriu. */
  total: number
}

interface TrafficState {
  byProfile: Record<string, ProfileTraffic>
  apply: (event: RuntimeTrafficEvent) => void
  clear: (profileId: string) => void
}

/** Tráfego dos perfis abertos com proxy, vindo do proxy local de cada um. */
export const useTrafficStore = create<TrafficState>((set) => ({
  byProfile: {},
  apply: (event) =>
    set((state) => {
      const previous = state.byProfile[event.profileId]?.samples ?? []
      const samples = [...previous, event.bytesPerSecond].slice(-TRAFFIC_SAMPLES)
      return {
        byProfile: {
          ...state.byProfile,
          [event.profileId]: { samples, bytesPerSecond: event.bytesPerSecond, total: event.total },
        },
      }
    }),
  clear: (profileId) =>
    set((state) => {
      if (!(profileId in state.byProfile)) return state
      const { [profileId]: _removed, ...rest } = state.byProfile
      return { byProfile: rest }
    }),
}))
