import type { BrowsersInfo } from '../schemas/browser'
import type { CookiesAppliedEvent } from '../schemas/cookies'
import type { ExtensionSummary } from '../schemas/extension'
import type { JobProgressEvent } from '../schemas/jobs'
import type { ProfileListItem, RuntimeStatus } from '../schemas/profile'
import type { ProxyCheckProgress, ProxySummary } from '../schemas/proxy'
import type { AppSettings } from '../schemas/settings'
import type { EventChannel } from './channels'
import type { AppErrorPayload } from './result'

export interface RuntimeStatusEvent {
  profileId: string
  status: RuntimeStatus
  error: AppErrorPayload | null
  at: number
  /** Reconexão não representa uma nova abertura. */
  recovered?: boolean
}

/** Mudanças em perfis, emitidas pelo processo principal após qualquer escrita. */
export interface ProfilesChangedEvent {
  upserted: ProfileListItem[]
  removedIds: string[]
}

export interface CatalogChangedEvent {
  entity: 'groups' | 'tags' | 'proxies'
}

/** Mudanças em proxies (cadastro, importação, verificação, troca de IP). */
export interface ProxiesChangedEvent {
  upserted: ProxySummary[]
  removedIds: string[]
}

/** Falhas do proxy remoto vistas pelo proxy local de um perfil aberto. */
export interface ProxyHealthEvent {
  profileId: string
  failures: number
  lastError: string | null
  at: number
}

/** Mudanças na biblioteca de extensões (importação, atualização, padrão, autoconfiguração). */
/** Tráfego com a proxy remota de um perfil aberto (uma amostra por segundo). */
export interface RuntimeTrafficEvent {
  profileId: string
  /** Envio + recebimento por segundo desde a amostra anterior. */
  bytesPerSecond: number
  /** Total desde que o perfil abriu (o que o provedor da proxy cobra). */
  total: number
  at: number
}

export interface ExtensionsChangedEvent {
  upserted: ExtensionSummary[]
  removedIds: string[]
}

/** Resultado da autoconfiguração de uma extensão num perfil aberto. */
export interface ExtensionConfigResultEvent {
  profileId: string
  extensionId: string
  ok: boolean
  error: AppErrorPayload | null
  at: number
}

export interface EventPayloads {
  'fingerprint.changed': { profileId: string }
  'runtime.statusChanged': RuntimeStatusEvent
  'runtime.proxyHealth': ProxyHealthEvent
  'runtime.traffic': RuntimeTrafficEvent
  'profiles.changed': ProfilesChangedEvent
  'proxies.changed': ProxiesChangedEvent
  'proxies.checkProgress': ProxyCheckProgress
  'extensions.changed': ExtensionsChangedEvent
  'extensions.configResult': ExtensionConfigResultEvent
  'catalog.changed': CatalogChangedEvent
  'settings.changed': AppSettings
  /** Navegadores encontrados ou sondados de novo (início do app, Configurações). */
  'browsers.changed': BrowsersInfo
  'jobs.progress': JobProgressEvent
  'cookies.applied': CookiesAppliedEvent
}

/** Falha na compilação se algum canal de evento ficar sem payload tipado. */
export type EventPayloadMap = { [E in EventChannel]: EventPayloads[E] }

export type EmitFn = <E extends EventChannel>(event: E, payload: EventPayloads[E]) => void
