import { mergeCookies } from '@shared/cookies/formats'
import { AppError } from '@shared/ipc/result'
import type { BrowserCookie } from '@shared/schemas/cookies'
import type { ExtensionSummary, ProfileExtensionState } from '@shared/schemas/extension'
import { fingerprintKey, type FingerprintConfig, type FingerprintUsage } from '@shared/schemas/fingerprint'
import type { Group, Tag } from '@shared/schemas/group-tag'
import type { NewProfile, Profile, ProfileScope } from '@shared/schemas/profile'
import type { ProxyCheckOutcome, ProxySummary } from '@shared/schemas/proxy'
import type {
  ExtensionConfigOutcome,
  ExtensionConfigValue,
  ExtensionConfigWrite,
  ExtensionPackage,
  ExtensionRepository,
  ExtensionRow,
  GroupPatch,
  GroupRepository,
  ProfilePatch,
  ProfileRepository,
  NewProxy,
  PendingCookieRepository,
  ProxyEndpoint,
  ProxyPatch,
  ProxyRepository,
  ProxySecrets,
  Repositories,
  SettingsRepository,
  TagPatch,
  TagRepository,
} from '../types'
import { byName, extensionSummary } from '../sqlite/extensions'
import type { MockSeed } from './seed'

/**
 * Repositórios em memória da Etapa 1. Todo valor entra e sai como cópia
 * (structuredClone), igual a um banco de verdade: quem chama nunca altera o
 * estado interno sem passar pelo repositório.
 */

const clone = <T>(value: T): T => structuredClone(value)

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0
}

interface LinkState {
  addedAt: number
  firstLoadedAt: number | null
  configRevision: number | null
  configAppliedAt: number | null
  configError: string | null
}

/**
 * Vínculos perfil ↔ extensão (a tabela profile_extensions do SQLite). Os dois
 * repositórios em memória compartilham estes dados, como as tabelas do banco.
 */
class ExtensionLinks {
  readonly byProfile = new Map<string, Map<string, LinkState>>()

  ids(profileId: string): string[] {
    const links = this.byProfile.get(profileId)
    if (!links) return []
    return [...links.entries()]
      .sort(([a, left], [b, right]) => left.addedAt - right.addedAt || a.localeCompare(b))
      .map(([extensionId]) => extensionId)
  }

  set(profileId: string, extensionIds: readonly string[], addedAt: number): void {
    const current = this.byProfile.get(profileId) ?? new Map<string, LinkState>()
    const next = new Map<string, LinkState>()
    for (const extensionId of new Set(extensionIds)) {
      next.set(
        extensionId,
        current.get(extensionId) ?? {
          addedAt,
          firstLoadedAt: null,
          configRevision: null,
          configAppliedAt: null,
          configError: null,
        },
      )
    }
    this.byProfile.set(profileId, next)
  }

  dropProfile(profileId: string): void {
    this.byProfile.delete(profileId)
  }

  dropExtension(extensionId: string): void {
    for (const links of this.byProfile.values()) links.delete(extensionId)
  }
}

/** Cookies pendentes em memória (fixtures dos testes); somem junto com o perfil. */
class MemoryPendingCookieRepository implements PendingCookieRepository {
  private readonly rows = new Map<string, { cookies: BrowserCookie[]; createdAt: number }>()

  status(profileId: string): { count: number; createdAt: number } | null {
    const row = this.rows.get(profileId)
    return row ? { count: row.cookies.length, createdAt: row.createdAt } : null
  }

  get(profileId: string): BrowserCookie[] | null {
    const row = this.rows.get(profileId)
    return row ? clone(row.cookies) : null
  }

  add(profileId: string, cookies: readonly BrowserCookie[], now: number): number {
    const merged = mergeCookies(this.rows.get(profileId)?.cookies ?? [], clone([...cookies]))
    this.rows.set(profileId, { cookies: merged, createdAt: now })
    return merged.length
  }

  clear(profileId: string): void {
    this.rows.delete(profileId)
  }
}

class MemoryProfileRepository implements ProfileRepository {
  private readonly rows = new Map<string, Profile>()
  /** Último número atribuído (igual à linha `profile_serial` do SQLite). */
  private lastSerial = 0
  /** Igual à tabela `fingerprint_history`: combinações gravadas, mesmo de perfis excluídos. */
  private readonly history = new Set<string>()

  constructor(
    seed: readonly Profile[],
    private readonly links: ExtensionLinks,
    private readonly pending: MemoryPendingCookieRepository,
  ) {
    for (const profile of seed) {
      this.rows.set(profile.id, clone(profile))
      this.links.set(profile.id, profile.extensionIds, profile.createdAt)
      this.lastSerial = Math.max(this.lastSerial, profile.serial)
      this.record(profile.fingerprint)
    }
  }

  private record(fingerprint: FingerprintConfig): void {
    const key = fingerprintKey(fingerprint)
    if (key) this.history.add(key)
  }

  fingerprintUsage(): FingerprintUsage {
    const inUse = new Map<string, number>()
    for (const row of this.rows.values()) {
      const key = fingerprintKey(row.fingerprint)
      if (key) inUse.set(key, (inUse.get(key) ?? 0) + 1)
    }
    return { inUse, used: new Set([...this.history, ...inUse.keys()]) }
  }

  /** A lista de extensões vem dos vínculos, igual ao SQLite. */
  private out(row: Profile): Profile {
    return { ...clone(row), extensionIds: this.links.ids(row.id) }
  }

  list(scope: ProfileScope): Profile[] {
    const all = [...this.rows.values()]
    const filtered =
      scope === 'all'
        ? all
        : all.filter((p) => (scope === 'trash' ? p.deletedAt !== null : p.deletedAt === null))
    return filtered.map((row) => this.out(row))
  }

  get(id: string): Profile | null {
    const row = this.rows.get(id)
    return row ? this.out(row) : null
  }

  getMany(ids: readonly string[]): Profile[] {
    const out: Profile[] = []
    for (const id of new Set(ids)) {
      const row = this.rows.get(id)
      if (row) out.push(this.out(row))
    }
    return out
  }

  insertMany(profiles: readonly NewProfile[]): Profile[] {
    for (const profile of profiles) {
      if (this.rows.has(profile.id)) throw new AppError('CONFLICT', `Perfil duplicado: ${profile.id}`)
    }
    return profiles.map((item) => {
      const profile: Profile = { ...clone(item), serial: ++this.lastSerial }
      this.rows.set(profile.id, profile)
      this.links.set(profile.id, profile.extensionIds, profile.createdAt)
      this.record(profile.fingerprint)
      return this.out(profile)
    })
  }

  update(id: string, patch: ProfilePatch): Profile {
    const row = this.rows.get(id)
    if (!row) throw new AppError('NOT_FOUND', `Perfil não encontrado: ${id}`)
    const next: Profile = { ...row, ...clone(patch), id: row.id, createdAt: row.createdAt }
    this.rows.set(id, next)
    if (patch.fingerprint) this.record(patch.fingerprint)
    if (patch.extensionIds) this.links.set(id, patch.extensionIds, patch.updatedAt ?? Date.now())
    return this.out(next)
  }

  updateMany(ids: readonly string[], patch: ProfilePatch): Profile[] {
    const out: Profile[] = []
    for (const id of new Set(ids)) {
      if (this.rows.has(id)) out.push(this.update(id, patch))
    }
    return out
  }

  deleteMany(ids: readonly string[]): number {
    let count = 0
    for (const id of new Set(ids)) {
      if (this.rows.delete(id)) {
        this.links.dropProfile(id)
        this.pending.clear(id)
        count++
      }
    }
    return count
  }

  clearGroup(groupId: string, updatedAt: number): Profile[] {
    const affected = [...this.rows.values()].filter((p) => p.groupId === groupId)
    return affected.map((p) => this.update(p.id, { groupId: null, updatedAt }))
  }

  clearTag(tagId: string, updatedAt: number): Profile[] {
    const affected = [...this.rows.values()].filter((p) => p.tagIds.includes(tagId))
    return affected.map((p) => this.update(p.id, { tagIds: p.tagIds.filter((t) => t !== tagId), updatedAt }))
  }
}

class MemoryGroupRepository implements GroupRepository {
  private readonly rows = new Map<string, Group>()

  constructor(seed: readonly Group[]) {
    for (const group of seed) this.rows.set(group.id, clone(group))
  }

  list(): Group[] {
    return [...this.rows.values()].map(clone)
  }

  get(id: string): Group | null {
    const row = this.rows.get(id)
    return row ? clone(row) : null
  }

  findByName(name: string): Group | null {
    const row = [...this.rows.values()].find((g) => sameName(g.name, name))
    return row ? clone(row) : null
  }

  insert(group: Group): void {
    if (this.rows.has(group.id)) throw new AppError('CONFLICT', `Grupo duplicado: ${group.id}`)
    this.rows.set(group.id, clone(group))
  }

  update(id: string, patch: GroupPatch): Group {
    const row = this.rows.get(id)
    if (!row) throw new AppError('NOT_FOUND', `Grupo não encontrado: ${id}`)
    const next: Group = { ...row, ...clone(patch), id: row.id, createdAt: row.createdAt }
    this.rows.set(id, next)
    return clone(next)
  }

  delete(id: string): boolean {
    return this.rows.delete(id)
  }
}

class MemoryTagRepository implements TagRepository {
  private readonly rows = new Map<string, Tag>()

  constructor(seed: readonly Tag[]) {
    for (const tag of seed) this.rows.set(tag.id, clone(tag))
  }

  list(): Tag[] {
    return [...this.rows.values()].map(clone)
  }

  get(id: string): Tag | null {
    const row = this.rows.get(id)
    return row ? clone(row) : null
  }

  findByName(name: string): Tag | null {
    const row = [...this.rows.values()].find((t) => sameName(t.name, name))
    return row ? clone(row) : null
  }

  insert(tag: Tag): void {
    if (this.rows.has(tag.id)) throw new AppError('CONFLICT', `Tag duplicada: ${tag.id}`)
    this.rows.set(tag.id, clone(tag))
  }

  update(id: string, patch: TagPatch): Tag {
    const row = this.rows.get(id)
    if (!row) throw new AppError('NOT_FOUND', `Tag não encontrada: ${id}`)
    const next: Tag = { ...row, ...clone(patch), id: row.id, createdAt: row.createdAt }
    this.rows.set(id, next)
    return clone(next)
  }

  delete(id: string): boolean {
    return this.rows.delete(id)
  }
}

interface MemoryProxyRow {
  summary: ProxySummary
  secrets: ProxySecrets
}

function changeIpHostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

class MemoryProxyRepository implements ProxyRepository {
  private readonly rows = new Map<string, MemoryProxyRow>()

  constructor(seed: readonly ProxySummary[]) {
    for (const proxy of seed) {
      this.rows.set(proxy.id, {
        summary: clone(proxy),
        secrets: { password: proxy.hasPassword ? 'senha-demo' : null, changeIpUrl: null },
      })
    }
  }

  list(): ProxySummary[] {
    return [...this.rows.values()].map((row) => clone(row.summary))
  }

  get(id: string): ProxySummary | null {
    const row = this.rows.get(id)
    return row ? clone(row.summary) : null
  }

  getMany(ids: readonly string[]): ProxySummary[] {
    return [...new Set(ids)].flatMap((id) => {
      const row = this.rows.get(id)
      return row ? [clone(row.summary)] : []
    })
  }

  secrets(id: string): ProxySecrets | null {
    const row = this.rows.get(id)
    return row ? { ...row.secrets } : null
  }

  findByEndpoint(endpoint: ProxyEndpoint): ProxySummary | null {
    const host = endpoint.host.toLowerCase()
    const row = [...this.rows.values()].find(
      ({ summary }) =>
        summary.type === endpoint.type &&
        summary.host === host &&
        summary.port === endpoint.port &&
        summary.username === endpoint.username,
    )
    return row ? clone(row.summary) : null
  }

  insertMany(rows: readonly NewProxy[]): ProxySummary[] {
    for (const row of rows) {
      if (this.findByEndpoint(row)) {
        throw new AppError('CONFLICT', 'Proxy duplicado', { reason: 'duplicateEndpoint', entity: 'proxy' })
      }
    }
    for (const row of rows) {
      this.rows.set(row.id, {
        summary: {
          id: row.id,
          name: row.name,
          type: row.type,
          host: row.host.toLowerCase(),
          port: row.port,
          username: row.username,
          hasPassword: Boolean(row.password),
          rotating: Boolean(row.changeIpUrl),
          changeIpHost: changeIpHostOf(row.changeIpUrl),
          notes: row.notes,
          checkStatus: 'unknown',
          checkedAt: null,
          latencyMs: null,
          exitIp: null,
          countryCode: null,
          countryName: null,
          region: null,
          city: null,
          timezone: null,
          latitude: null,
          longitude: null,
          lastError: null,
          lastErrorCode: null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
        secrets: { password: row.password || null, changeIpUrl: row.changeIpUrl || null },
      })
    }
    return this.getMany(rows.map((row) => row.id))
  }

  update(id: string, patch: ProxyPatch): ProxySummary {
    const row = this.rows.get(id)
    if (!row) throw new AppError('NOT_FOUND', `Proxy não encontrado: ${id}`, { entity: 'proxy', id })
    const next = { ...row.summary, updatedAt: patch.updatedAt }
    if (patch.name !== undefined) next.name = patch.name
    if (patch.type !== undefined) next.type = patch.type
    if (patch.host !== undefined) next.host = patch.host.toLowerCase()
    if (patch.port !== undefined) next.port = patch.port
    if (patch.username !== undefined) next.username = patch.username
    if (patch.notes !== undefined) next.notes = patch.notes
    if (patch.password !== undefined) {
      row.secrets.password = patch.password || null
      next.hasPassword = Boolean(patch.password)
    }
    if (patch.changeIpUrl !== undefined) {
      row.secrets.changeIpUrl = patch.changeIpUrl || null
      next.rotating = Boolean(patch.changeIpUrl)
      next.changeIpHost = changeIpHostOf(patch.changeIpUrl)
    }
    const current = row.summary
    const endpointChanged =
      next.type !== current.type ||
      next.host !== current.host ||
      next.port !== current.port ||
      next.username !== current.username
    if (endpointChanged || patch.password !== undefined) {
      // outro endereço ou credencial: a verificação anterior deixou de valer (igual ao SQLite)
      Object.assign(next, {
        checkStatus: 'unknown',
        checkedAt: null,
        latencyMs: null,
        lastError: null,
        lastErrorCode: null,
      })
      if (endpointChanged) {
        Object.assign(next, {
          exitIp: null,
          countryCode: null,
          countryName: null,
          region: null,
          city: null,
          timezone: null,
          latitude: null,
          longitude: null,
        })
      }
    }
    row.summary = next
    return clone(next)
  }

  saveCheck(id: string, outcome: ProxyCheckOutcome): ProxySummary {
    const row = this.rows.get(id)
    if (!row) throw new AppError('NOT_FOUND', `Proxy não encontrado: ${id}`, { entity: 'proxy', id })
    const next: ProxySummary = {
      ...row.summary,
      checkStatus: outcome.status,
      checkedAt: outcome.checkedAt,
      lastError: outcome.error?.message ?? null,
      lastErrorCode: outcome.error?.code ?? null,
      latencyMs: outcome.status === 'online' ? outcome.latencyMs : null,
    }
    // Mesmo critério do SQLite: local medido quando há IP de saída (online ou IP real).
    if (outcome.status === 'online' || outcome.exitIp !== null) {
      Object.assign(next, {
        exitIp: outcome.exitIp,
        countryCode: outcome.countryCode,
        countryName: outcome.countryName,
        region: outcome.region,
        city: outcome.city,
        timezone: outcome.timezone,
        latitude: outcome.latitude,
        longitude: outcome.longitude,
      })
    }
    row.summary = next
    return clone(next)
  }

  deleteMany(ids: readonly string[]): number {
    let count = 0
    for (const id of new Set(ids)) if (this.rows.delete(id)) count++
    return count
  }
}

interface MemoryExtension {
  row: ExtensionRow
  /** Em memória o JSON fica em claro (o SQLite cifra com o cofre do sistema). */
  configJson: string | null
}

class MemoryExtensionRepository implements ExtensionRepository {
  private readonly rows = new Map<string, MemoryExtension>()
  /** A revisão continua contando depois de remover a configuração (igual ao SQLite). */
  private readonly revisions = new Map<string, number>()

  constructor(private readonly links: ExtensionLinks) {}

  private count(id: string): number {
    let count = 0
    for (const links of this.links.byProfile.values()) if (links.has(id)) count++
    return count
  }

  list(): ExtensionSummary[] {
    return [...this.rows.values()]
      .map((entry) => entry.row)
      .sort(byName)
      .map((row) => extensionSummary(clone(row), this.count(row.id)))
  }

  get(id: string): ExtensionSummary | null {
    const entry = this.rows.get(id)
    return entry ? extensionSummary(clone(entry.row), this.count(id)) : null
  }

  getMany(ids: readonly string[]): ExtensionSummary[] {
    return [...new Set(ids)].map((id) => this.get(id)).filter((e): e is ExtensionSummary => e !== null)
  }

  row(id: string): ExtensionRow | null {
    const entry = this.rows.get(id)
    return entry ? clone(entry.row) : null
  }

  savePackage(
    pkg: ExtensionPackage,
    now: number,
  ): { summary: ExtensionSummary; previous: ExtensionRow | null } {
    const current = this.rows.get(pkg.id)
    const previous = current ? clone(current.row) : null
    const row: ExtensionRow = current
      ? { ...current.row, ...clone(pkg), updatedAt: now }
      : { ...clone(pkg), isDefault: false, applyMode: 'always', config: null, createdAt: now, updatedAt: now }
    this.rows.set(pkg.id, { row, configJson: current?.configJson ?? null })
    return { summary: this.get(pkg.id)!, previous }
  }

  setDefault(ids: readonly string[], isDefault: boolean, now: number): ExtensionSummary[] {
    for (const id of new Set(ids)) {
      const entry = this.rows.get(id)
      if (entry) entry.row = { ...entry.row, isDefault, updatedAt: now }
    }
    return this.getMany(ids)
  }

  defaultIds(): string[] {
    return [...this.rows.values()]
      .map((entry) => entry.row)
      .filter((row) => row.isDefault)
      .sort(byName)
      .map((row) => row.id)
  }

  setPreferences(
    id: string,
    mode: ExtensionRow['applyMode'],
    isDefault: boolean,
    now: number,
  ): ExtensionSummary {
    const entry = this.rows.get(id)
    if (!entry) throw new AppError('NOT_FOUND', `Extensão não encontrada: ${id}`)
    entry.row = {
      ...entry.row,
      applyMode: mode,
      isDefault,
      updatedAt: now,
      config: entry.row.config ? { ...entry.row.config, mode } : null,
    }
    return this.get(id)!
  }

  config(id: string): ExtensionConfigValue | null {
    const entry = this.rows.get(id)
    if (!entry?.configJson || !entry.row.config) return null
    const { area, mode, revision, updatedAt } = entry.row.config
    return { area, mode, json: entry.configJson, revision, updatedAt }
  }

  setConfig(
    id: string,
    config: ExtensionConfigWrite | null,
    reapply: boolean,
    now: number,
  ): ExtensionSummary {
    const entry = this.rows.get(id)
    if (!entry) throw new AppError('NOT_FOUND', `Extensão não encontrada: ${id}`, { entity: 'extension', id })
    const revision = (this.revisions.get(id) ?? 0) + 1
    this.revisions.set(id, revision)
    entry.configJson = config?.json ?? null
    entry.row = {
      ...entry.row,
      applyMode: config?.mode ?? entry.row.applyMode,
      config: config
        ? { area: config.area, mode: config.mode, keys: config.keys, revision, updatedAt: now }
        : null,
      updatedAt: now,
    }
    if (reapply) {
      for (const links of this.links.byProfile.values()) {
        const link = links.get(id)
        if (link) Object.assign(link, { configRevision: null, configAppliedAt: null, configError: null })
      }
    }
    return this.get(id)!
  }

  deleteMany(ids: readonly string[]): number {
    let count = 0
    for (const id of new Set(ids)) {
      if (this.rows.delete(id)) {
        this.links.dropExtension(id)
        count++
      }
    }
    return count
  }

  profileIdsUsing(ids: readonly string[]): string[] {
    const wanted = new Set(ids)
    return [...this.links.byProfile.entries()]
      .filter(([, links]) => [...links.keys()].some((id) => wanted.has(id)))
      .map(([profileId]) => profileId)
  }

  profileState(profileId: string): ProfileExtensionState[] {
    const links = this.links.byProfile.get(profileId)
    if (!links) return []
    return this.links
      .ids(profileId)
      .map((extensionId) => ({ extensionId, ...clone(links.get(extensionId)!) }))
  }

  markLoaded(profileId: string, extensionIds: readonly string[], at: number): void {
    const links = this.links.byProfile.get(profileId)
    for (const extensionId of extensionIds) {
      const link = links?.get(extensionId)
      if (link && link.firstLoadedAt === null) link.firstLoadedAt = at
    }
  }

  markConfigResult(profileId: string, extensionId: string, outcome: ExtensionConfigOutcome): void {
    const link = this.links.byProfile.get(profileId)?.get(extensionId)
    if (!link) return
    if ('revision' in outcome)
      Object.assign(link, {
        configRevision: outcome.revision,
        configAppliedAt: outcome.at,
        configError: null,
      })
    else link.configError = outcome.error
  }

  resetConfig(profileId: string, extensionIds: readonly string[]): ProfileExtensionState[] {
    const links = this.links.byProfile.get(profileId)
    for (const extensionId of extensionIds) {
      const link = links?.get(extensionId)
      if (link) Object.assign(link, { configRevision: null, configAppliedAt: null, configError: null })
    }
    return this.profileState(profileId)
  }

  directories(): string[] {
    return [...this.rows.values()].map((entry) => `${entry.row.id}/${entry.row.dirName}`)
  }
}

export function createMemoryRepositories(seed: MockSeed, settings: SettingsRepository): Repositories {
  const links = new ExtensionLinks()
  const pendingCookies = new MemoryPendingCookieRepository()
  return {
    transaction: (action) => action(),
    profiles: new MemoryProfileRepository(seed.profiles, links, pendingCookies),
    groups: new MemoryGroupRepository(seed.groups),
    tags: new MemoryTagRepository(seed.tags),
    proxies: new MemoryProxyRepository(seed.proxies),
    extensions: new MemoryExtensionRepository(links),
    settings,
    pendingCookies,
  }
}
