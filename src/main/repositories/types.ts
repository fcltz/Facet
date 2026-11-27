import type { BrowserCookie } from '@shared/schemas/cookies'
import type {
  ExtensionConfigInfo,
  ExtensionConfigMode,
  ExtensionSource,
  ExtensionStorageArea,
  ExtensionSummary,
  ProfileExtensionState,
} from '@shared/schemas/extension'
import type { FingerprintUsage } from '@shared/schemas/fingerprint'
import type { Group, Tag } from '@shared/schemas/group-tag'
import type { NewProfile, Profile, ProfileScope } from '@shared/schemas/profile'
import type { ProxyCheckOutcome, ProxySummary, ProxyType } from '@shared/schemas/proxy'
import type { AppSettings } from '@shared/schemas/settings'

/**
 * Contratos de acesso a dados. A Etapa 1 usa implementações em memória; a
 * Etapa 2 troca por SQLite (Drizzle) sem que serviços, IPC ou UI mudem.
 * Os métodos são síncronos porque o better-sqlite3 é síncrono por natureza.
 */

/** O número sequencial não muda depois de atribuído. */
export type ProfilePatch = Partial<Omit<Profile, 'id' | 'serial' | 'createdAt'>>

export interface ProfileRepository {
  list(scope: ProfileScope): Profile[]
  get(id: string): Profile | null
  getMany(ids: readonly string[]): Profile[]
  /**
   * Grava numa transação e atribui os próximos números sequenciais, na ordem recebida.
   * Os números nunca são reaproveitados, nem depois da exclusão definitiva.
   */
  insertMany(profiles: readonly NewProfile[]): Profile[]
  /** Lança AppError NOT_FOUND se o perfil não existir. */
  update(id: string, patch: ProfilePatch): Profile
  updateMany(ids: readonly string[], patch: ProfilePatch): Profile[]
  deleteMany(ids: readonly string[]): number
  /** Remove a referência a um grupo excluído e devolve os perfis alterados. */
  clearGroup(groupId: string, updatedAt: number): Profile[]
  /** Remove uma tag excluída de todos os perfis e devolve os perfis alterados. */
  clearTag(tagId: string, updatedAt: number): Profile[]
  /**
   * Hardware emulado dos perfis existentes (inclusive na lixeira) e de todo perfil já gravado:
   * gravar um perfil registra a combinação dele, que fica registrada após a exclusão.
   */
  fingerprintUsage(): FingerprintUsage
}

export type GroupPatch = Partial<Omit<Group, 'id' | 'createdAt'>>

export interface GroupRepository {
  list(): Group[]
  get(id: string): Group | null
  findByName(name: string): Group | null
  insert(group: Group): void
  update(id: string, patch: GroupPatch): Group
  delete(id: string): boolean
}

export type TagPatch = Partial<Omit<Tag, 'id' | 'createdAt'>>

export interface TagRepository {
  list(): Tag[]
  get(id: string): Tag | null
  findByName(name: string): Tag | null
  insert(tag: Tag): void
  update(id: string, patch: TagPatch): Tag
  delete(id: string): boolean
}

export interface ProxySecrets {
  password: string | null
  changeIpUrl: string | null
}

export interface NewProxy {
  id: string
  name: string | null
  type: ProxyType
  host: string
  port: number
  username: string
  password: string | null
  changeIpUrl: string | null
  notes: string
  createdAt: number
  updatedAt: number
}

/** `undefined` = manter; segredos com `null` = remover. Mudar o endereço zera a verificação. */
export interface ProxyPatch {
  name?: string | null
  type?: ProxyType
  host?: string
  port?: number
  username?: string
  notes?: string
  password?: string | null
  changeIpUrl?: string | null
  updatedAt: number
}

export interface ProxyEndpoint {
  type: ProxyType
  host: string
  port: number
  username: string
}

export interface ProxyRepository {
  list(): ProxySummary[]
  get(id: string): ProxySummary | null
  getMany(ids: readonly string[]): ProxySummary[]
  /** Segredos decifrados: nunca devolver ao renderer. */
  secrets(id: string): ProxySecrets | null
  findByEndpoint(endpoint: ProxyEndpoint): ProxySummary | null
  /** Lança AppError CONFLICT (duplicateEndpoint) se o endereço já existir. */
  insertMany(rows: readonly NewProxy[]): ProxySummary[]
  update(id: string, patch: ProxyPatch): ProxySummary
  /** Offline mantém a última geolocalização conhecida; online grava IP, geo e latência. */
  saveCheck(id: string, outcome: ProxyCheckOutcome): ProxySummary
  deleteMany(ids: readonly string[]): number
}

/** Pacote já instalado na pasta final (extensions/<id>/<dirName>/). */
export interface ExtensionPackage {
  id: string
  name: string
  version: string
  description: string
  manifestVersion: number
  source: ExtensionSource
  /** SPKI em base64, gravado como `key` no manifest instalado. */
  publicKey: string
  dirName: string
  icon: string | null
  permissions: string[]
  sizeBytes: number
}

/** Linha completa da biblioteca, sem o JSON da autoconfiguração. */
export interface ExtensionRow extends ExtensionPackage {
  isDefault: boolean
  applyMode: ExtensionConfigMode
  config: ExtensionConfigInfo | null
  createdAt: number
  updatedAt: number
}

/** Autoconfiguração decifrada: só sai do processo principal no diálogo de edição. */
export interface ExtensionConfigValue {
  area: ExtensionStorageArea
  mode: ExtensionConfigMode
  json: string
  revision: number
  updatedAt: number
}

export interface ExtensionConfigWrite {
  area: ExtensionStorageArea
  mode: ExtensionConfigMode
  json: string
  keys: number
}

export type ExtensionConfigOutcome = { revision: number; at: number } | { error: string; at: number }

export interface ExtensionRepository {
  list(): ExtensionSummary[]
  get(id: string): ExtensionSummary | null
  getMany(ids: readonly string[]): ExtensionSummary[]
  /** Pasta e chave pública (uso interno do processo principal). */
  row(id: string): ExtensionRow | null
  /** Insere ou troca os arquivos de uma extensão; mantém padrão, autoconfiguração e perfis. */
  savePackage(
    pkg: ExtensionPackage,
    now: number,
  ): { summary: ExtensionSummary; previous: ExtensionRow | null }
  setDefault(ids: readonly string[], isDefault: boolean, now: number): ExtensionSummary[]
  setPreferences(id: string, mode: ExtensionConfigMode, isDefault: boolean, now: number): ExtensionSummary
  /** Extensões marcadas como padrão (entram nos perfis novos). */
  defaultIds(): string[]
  /** Decifra a autoconfiguração; lança SECRET_UNAVAILABLE se o cofre não abrir. */
  config(id: string): ExtensionConfigValue | null
  /**
   * `null` remove. Cada gravação aumenta a revisão; `reapply` faz os perfis que já
   * receberam a configuração recebê-la de novo. Lança NOT_FOUND.
   */
  setConfig(id: string, config: ExtensionConfigWrite | null, reapply: boolean, now: number): ExtensionSummary
  deleteMany(ids: readonly string[]): number
  /** Perfis (inclusive na lixeira) que usam alguma das extensões. */
  profileIdsUsing(ids: readonly string[]): string[]
  profileState(profileId: string): ProfileExtensionState[]
  /** Registra a 1ª carga da extensão no perfil (mantém a data anterior, se houver). */
  markLoaded(profileId: string, extensionIds: readonly string[], at: number): void
  markConfigResult(profileId: string, extensionId: string, outcome: ExtensionConfigOutcome): void
  /** Faz a configuração ser aplicada de novo na próxima abertura. */
  resetConfig(profileId: string, extensionIds: readonly string[]): ProfileExtensionState[]
  /** Pastas usadas pela biblioteca, no formato `<id>/<dirName>`. */
  directories(): string[]
}

export interface SettingsRepository {
  load(): AppSettings
  save(settings: AppSettings): void
}

/** Cookies importados com o perfil fechado, à espera da próxima abertura. */
export interface PendingCookieRepository {
  /** Sem decifrar: quantos e desde quando. */
  status(profileId: string): { count: number; createdAt: number } | null
  /** Decifra; lança SECRET_UNAVAILABLE se o cofre não abrir. */
  get(profileId: string): BrowserCookie[] | null
  /** Soma aos pendentes (mesma identidade: vale o novo) e devolve o total. */
  add(profileId: string, cookies: readonly BrowserCookie[], now: number): number
  clear(profileId: string): void
}

export interface Repositories {
  transaction<T>(action: () => T): T
  profiles: ProfileRepository
  groups: GroupRepository
  tags: TagRepository
  proxies: ProxyRepository
  extensions: ExtensionRepository
  settings: SettingsRepository
  pendingCookies: PendingCookieRepository
}
