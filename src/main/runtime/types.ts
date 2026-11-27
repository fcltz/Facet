import type { RuntimeStatusEvent } from '@shared/ipc/events'
import type { RuntimeStatus } from '@shared/schemas/profile'
import type { CdpClient } from '../browser/cdp/client'
import type { OfflineBrowser } from '../browser/engine'

/**
 * Ciclo de vida dos perfis abertos. A Etapa 1 usa uma simulação; na Etapa 2 o
 * launcher real do Brave implementa esta mesma interface e emite os mesmos
 * eventos, então serviços e UI não mudam.
 */
export interface ProfileRuntime {
  status(profileId: string): RuntimeStatus
  /** Perfis que não estão parados (iniciando, rodando, parando ou com erro). */
  snapshot(): RuntimeStatusEvent[]
  isActive(profileId: string): boolean
  hasActive(): boolean
  /** Resolve quando o perfil está rodando; rejeita com AppError se falhar. */
  start(profileId: string): Promise<void>
  /** Resolve quando o perfil está parado. */
  stop(profileId: string): Promise<void>
  stopAll(): Promise<void>
  /** Serializa alterações de disco com abrir/parar e confirma que a pasta está livre. */
  runStopped?<T>(profileId: string, action: () => Promise<T> | T): Promise<T>
  /**
   * Como `runStopped`, mas sem fechar nem cancelar nada: com o perfil ativo, falha com
   * PROFILE_RUNNING. Enquanto `action` roda, o perfil não abre.
   */
  runIdle?<T>(profileId: string, action: () => Promise<T> | T): Promise<T>
  /**
   * Só dentro de `runStopped`/`runIdle`: abre a pasta do perfil sem janela e sem rede.
   * null = o perfil nunca foi aberto (não há pasta).
   */
  openOffline?(profileId: string, signal?: AbortSignal): Promise<OfflineBrowser | null>
  /**
   * Impede novas aberturas (mudança da pasta dos perfis, restauração de backup). Falha com
   * PROFILE_RUNNING se houver perfil ativo. Devolve a função que libera.
   */
  blockStarts?(reason: string): () => void
  /** Conexão CDP de um perfil rodando (null se não estiver aberto). */
  client?(profileId: string): CdpClient | null
  /** Nome novo com o perfil aberto: atualiza grupo de abas, dica do ícone e barra de tarefas. */
  refreshIdentity?(profileId: string): void
  onStatus(listener: (event: RuntimeStatusEvent) => void): () => void
}
