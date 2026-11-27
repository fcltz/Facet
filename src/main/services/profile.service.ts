import { DEFAULT_BROWSER, type BrowserKind } from '@shared/constants'
import type { EmitFn, RuntimeStatusEvent } from '@shared/ipc/events'
import { AppError, type AppErrorPayload } from '@shared/ipc/result'
import type { OsName } from '@shared/schemas/common'
import {
  createDefaultFingerprint,
  type FingerprintCapabilities,
  type FingerprintConfig,
  type FingerprintUsage,
} from '@shared/schemas/fingerprint'
import { canonicalFingerprint, generateFingerprint, trackFingerprint } from '../browser/fingerprint/generator'
import { previewFor } from './fingerprint.service'
import {
  DEFAULT_LAUNCH_OPTIONS,
  sequentialNames,
  toListItem,
  type AssignProxyResult,
  type BulkCreateInput,
  type NewProfile,
  type Profile,
  type ProfileCreateInput,
  type ProfileListItem,
  type ProfilePatchInput,
  type ProfileScope,
  type RuntimeActionResult,
} from '@shared/schemas/profile'
import type { Language } from '@shared/schemas/settings'
import type { Logger } from '../logger'
import type { ProfilePatch, Repositories } from '../repositories/types'
import type { ProfileRuntime } from '../runtime/types'
import { syncFingerprint, type HostLocale } from './geo-sync'

export interface ProfileServiceDeps {
  repos: Repositories
  runtime: ProfileRuntime
  emit: EmitFn
  now: () => number
  newId: () => string
  hostTimezone: string
  /** Versão principal do motor (Chromium) usada no User-Agent. */
  engineMajor: number
  language: () => Language
  logger: Logger
  /** Fuso e idiomas desta máquina (perfis sem proxy em modo "auto"). */
  hostLocale?: () => HostLocale
  /** Pede verificação em segundo plano de um proxy ainda sem geolocalização. */
  requestProxyCheck?: (proxyId: string) => void
  /** Versão, marcas e sufixo do User-Agent do navegador sondado (ausente = pré-visualização). */
  capabilities?: (browser: BrowserKind) => FingerprintCapabilities | undefined
  /** Navegador dos perfis criados sem escolher um (Configurações). */
  defaultBrowser?: () => BrowserKind
}

const COPY_SUFFIX: Record<Language, string> = { 'pt-BR': 'cópia', en: 'copy', es: 'copia' }
const COPY_PATTERN = /^(.*) \((?:cópia|copy|copia)(?: \d+)?\)$/

/** "Loja 01" → "Loja 01 (cópia)" → "Loja 01 (cópia 2)"… sem repetir nomes existentes. */
export function cloneName(name: string, existing: ReadonlySet<string>, language: Language): string {
  const root = COPY_PATTERN.exec(name)?.[1] ?? name
  const suffix = COPY_SUFFIX[language]
  let candidate = `${root} (${suffix})`
  for (let n = 2; existing.has(candidate); n++) candidate = `${root} (${suffix} ${n})`
  return candidate
}

function compact<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

function toErrorPayload(reason: unknown): AppErrorPayload {
  if (reason instanceof AppError) return reason.toPayload()
  return { code: 'INTERNAL', message: reason instanceof Error ? reason.message : String(reason) }
}

export class ProfileService {
  constructor(private readonly deps: ProfileServiceDeps) {
    deps.runtime.onStatus((event) => this.handleRuntimeStatus(event))
  }

  list(scope: ProfileScope): ProfileListItem[] {
    return this.deps.repos.profiles.list(scope).map(toListItem)
  }

  get(id: string): Profile {
    const profile = this.deps.repos.profiles.get(id)
    if (!profile) throw new AppError('NOT_FOUND', `Perfil não encontrado: ${id}`, { entity: 'profile', id })
    return profile
  }

  create(input: ProfileCreateInput): Profile {
    // sem lista explícita, o perfil novo recebe as extensões marcadas como padrão
    const extensionIds = unique(input.extensionIds ?? this.deps.repos.extensions.defaultIds())
    this.assertReferences({ ...input, extensionIds })
    const now = this.deps.now()
    const browser = input.browser ?? this.defaultBrowser()
    const fingerprint = input.fingerprint
      ? this.normalize(input.fingerprint, input.proxyId, browser)
      : this.defaultFingerprint(input.os, input.proxyId, this.deps.repos.profiles.fingerprintUsage(), browser)
    const draft: NewProfile = {
      id: this.deps.newId(),
      name: input.name,
      browser,
      groupId: input.groupId,
      proxyId: input.proxyId,
      tagIds: unique(input.tagIds),
      extensionIds,
      color: input.color,
      notes: input.notes,
      os: fingerprint.os,
      userAgent: fingerprint.userAgent,
      fingerprint,
      launchOptions: input.launchOptions,
      lastOpenedAt: null,
      lastClosedAt: null,
      openCount: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    const [profile] = this.deps.repos.profiles.insertMany([draft])
    this.emitUpserted([profile!])
    return profile!
  }

  bulkCreate(input: BulkCreateInput): ProfileListItem[] {
    this.assertReferences(input)
    const existing = this.deps.repos.profiles.list('active').map((p) => p.name)
    const names = sequentialNames(input.namePrefix, input.count, existing)
    const now = this.deps.now()
    const extensionIds = this.deps.repos.extensions.defaultIds()
    // Cada perfil do lote recebe uma combinação de hardware diferente das já usadas e das do lote.
    const usage = this.deps.repos.profiles.fingerprintUsage()
    const startupUrls = input.startupUrls ?? []
    const browser = input.browser ?? this.defaultBrowser()
    const drafts = names.map((name): NewProfile => {
      const fingerprint = this.defaultFingerprint(input.os, input.proxyId, usage, browser)
      trackFingerprint(usage, fingerprint)
      return {
        id: this.deps.newId(),
        name,
        browser,
        groupId: input.groupId,
        proxyId: input.proxyId,
        tagIds: unique(input.tagIds),
        extensionIds: [...extensionIds],
        color: null,
        notes: '',
        os: fingerprint.os,
        userAgent: fingerprint.userAgent,
        fingerprint,
        launchOptions: { ...structuredClone(DEFAULT_LAUNCH_OPTIONS), startupUrls: [...startupUrls] },
        lastOpenedAt: null,
        lastClosedAt: null,
        openCount: 0,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      }
    })
    // números seguidos, na ordem dos nomes ("Perfil 08" recebe o número antes de "Perfil 09")
    const profiles = this.deps.repos.profiles.insertMany(drafts)
    this.emitUpserted(profiles)
    this.deps.logger.info(`Criados ${profiles.length} perfis em massa (prefixo "${input.namePrefix}")`)
    return profiles.map(toListItem)
  }

  update(id: string, rawPatch: ProfilePatchInput): Profile {
    const current = this.requireActive(id)
    const patch = compact(rawPatch)
    this.assertReferences(patch)
    const next: ProfilePatch = { ...patch, updatedAt: this.deps.now() }
    if (patch.tagIds) next.tagIds = unique(patch.tagIds)
    if (patch.extensionIds) next.extensionIds = unique(patch.extensionIds)
    // Navegador trocado: marcas das Client Hints e User-Agent passam a ser as do novo.
    const browser = patch.browser ?? current.browser
    if (
      patch.fingerprint ||
      patch.os !== undefined ||
      patch.proxyId !== undefined ||
      (patch.browser !== undefined && patch.browser !== current.browser)
    ) {
      let fingerprint = structuredClone(patch.fingerprint ?? current.fingerprint)
      if (!patch.fingerprint && patch.os && patch.os !== current.os)
        fingerprint = generateFingerprint(patch.os, this.capabilities(browser), {
          base: fingerprint,
          usage: this.deps.repos.profiles.fingerprintUsage(),
        })
      next.fingerprint = this.normalize(
        fingerprint,
        patch.proxyId !== undefined ? patch.proxyId : current.proxyId,
        browser,
      )
      next.userAgent = next.fingerprint.userAgent
      next.os = next.fingerprint.os
    }
    const updated = this.deps.repos.profiles.update(id, next)
    this.emitUpserted([updated])
    // Perfil aberto: grupo de abas, dica do ícone e barra de tarefas mostram o nome novo na hora.
    if (patch.name !== undefined && patch.name !== current.name) this.deps.runtime.refreshIdentity?.(id)
    return updated
  }

  clone(id: string): Profile {
    const source = this.requireActive(id)
    const names = new Set(this.deps.repos.profiles.list('active').map((p) => p.name))
    const now = this.deps.now()
    // A cópia herda a configuração, com hardware emulado próprio; dados de navegação não são copiados.
    const fingerprint =
      source.fingerprint.mode === 'emulated'
        ? this.normalize(
            generateFingerprint(source.os, this.capabilities(source.browser), {
              current: source.fingerprint,
              usage: this.deps.repos.profiles.fingerprintUsage(),
            }),
            source.proxyId,
            source.browser,
          )
        : this.normalize(source.fingerprint, source.proxyId, source.browser)
    const { serial: _sourceSerial, ...base } = source
    const draft: NewProfile = {
      ...base,
      id: this.deps.newId(),
      name: cloneName(source.name, names, this.deps.language()),
      tagIds: [...source.tagIds],
      // mesma lista de extensões; a autoconfiguração roda na 1ª abertura da cópia
      extensionIds: [...source.extensionIds],
      fingerprint,
      os: fingerprint.os,
      userAgent: fingerprint.userAgent,
      launchOptions: structuredClone(source.launchOptions),
      lastOpenedAt: null,
      lastClosedAt: null,
      openCount: 0,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    // a cópia recebe o próximo número (o do original não se repete)
    const [copy] = this.deps.repos.profiles.insertMany([draft])
    this.emitUpserted([copy!])
    return copy!
  }

  moveToGroup(ids: readonly string[], groupId: string | null): ProfileListItem[] {
    this.assertReferences({ groupId })
    const targets = this.activeOnly(ids)
    const updated = this.deps.repos.profiles.updateMany(
      targets.map((p) => p.id),
      { groupId, updatedAt: this.deps.now() },
    )
    this.emitUpserted(updated)
    return updated.map(toListItem)
  }

  assignProxy(ids: readonly string[], proxyId: string | null): AssignProxyResult {
    this.assertReferences({ proxyId })
    const proxy = proxyId ? this.deps.repos.proxies.get(proxyId) : null
    const host = this.host()
    const targets = this.activeOnly(ids)
    const now = this.deps.now()
    // fuso, idiomas e geolocalização "auto" passam a seguir o proxy (ou voltam a esta máquina)
    const updated = this.deps.repos.transaction(() =>
      targets.map((profile) =>
        this.deps.repos.profiles.update(profile.id, {
          proxyId,
          fingerprint: syncFingerprint(profile.fingerprint, proxy, host),
          updatedAt: now,
        }),
      ),
    )
    this.emitUpserted(updated)
    if (proxy && !proxy.countryCode && updated.length > 0) this.deps.requestProxyCheck?.(proxy.id)
    return {
      updated: updated.map(toListItem),
      runningIds: updated.filter((p) => this.deps.runtime.isActive(p.id)).map((p) => p.id),
    }
  }

  statuses(): RuntimeStatusEvent[] {
    return this.deps.runtime.snapshot()
  }

  start(ids: readonly string[]): Promise<RuntimeActionResult> {
    return this.runMany(ids, async (id) => {
      this.requireActive(id)
      await this.deps.runtime.start(id)
    })
  }

  stop(ids: readonly string[]): Promise<RuntimeActionResult> {
    return this.runMany(ids, (id) => this.deps.runtime.stop(id))
  }

  restart(ids: readonly string[]): Promise<RuntimeActionResult> {
    return this.runMany(ids, async (id) => {
      this.requireActive(id)
      await this.deps.runtime.stop(id)
      await this.deps.runtime.start(id)
    })
  }

  private async runMany(
    ids: readonly string[],
    action: (id: string) => Promise<void>,
  ): Promise<RuntimeActionResult> {
    const targets = unique(ids)
    const results = await Promise.allSettled(targets.map((id) => action(id)))
    const outcome: RuntimeActionResult = { done: [], failed: [] }
    results.forEach((result, index) => {
      const id = targets[index]
      if (id === undefined) return
      if (result.status === 'fulfilled') outcome.done.push(id)
      else outcome.failed.push({ id, error: toErrorPayload(result.reason) })
    })
    return outcome
  }

  private handleRuntimeStatus(event: RuntimeStatusEvent): void {
    this.deps.emit('runtime.statusChanged', event)
    const profile = this.deps.repos.profiles.get(event.profileId)
    if (!profile) return
    if (event.status === 'running' && !event.recovered) {
      const updated = this.deps.repos.profiles.update(profile.id, {
        lastOpenedAt: event.at,
        openCount: profile.openCount + 1,
      })
      this.emitUpserted([updated])
    } else if (
      event.status === 'stopped' &&
      profile.lastOpenedAt !== null &&
      (profile.lastClosedAt ?? 0) < profile.lastOpenedAt
    ) {
      const updated = this.deps.repos.profiles.update(profile.id, { lastClosedAt: event.at })
      this.emitUpserted([updated])
    }
  }

  private host(): HostLocale {
    return this.deps.hostLocale?.() ?? { timezone: this.deps.hostTimezone, languages: ['en-US', 'en'] }
  }

  /**
   * Perfil novo sem fingerprint informado: emulação, com tela e hardware sorteados entre as
   * combinações que nenhum perfil usa nem usou (`usage`). Também no sistema desta máquina.
   */
  private defaultFingerprint(
    os: OsName,
    proxyId: string | null,
    usage: FingerprintUsage,
    browser: BrowserKind,
  ): FingerprintConfig {
    const proxy = proxyId ? this.deps.repos.proxies.get(proxyId) : null
    const host = this.host()
    const base = createDefaultFingerprint({
      os,
      engineMajor: this.deps.engineMajor,
      timezone: proxy?.timezone ?? host.timezone,
      languages: host.languages,
      mode: 'emulated',
    })
    // `normalize` pede a verificação do proxy ainda sem geolocalização.
    return this.normalize(
      generateFingerprint(os, this.capabilities(browser), { base, usage }),
      proxyId,
      browser,
    )
  }

  private defaultBrowser(): BrowserKind {
    return this.deps.defaultBrowser?.() ?? DEFAULT_BROWSER
  }

  private capabilities(browser: BrowserKind): FingerprintCapabilities {
    return this.deps.capabilities?.(browser) ?? previewFor(browser, this.deps.engineMajor)
  }

  private normalize(
    fingerprint: FingerprintConfig,
    proxyId: string | null,
    browser: BrowserKind,
  ): FingerprintConfig {
    const proxy = proxyId ? this.deps.repos.proxies.get(proxyId) : null
    if (proxy && !proxy.countryCode) this.deps.requestProxyCheck?.(proxy.id)
    return syncFingerprint(canonicalFingerprint(fingerprint, this.capabilities(browser)), proxy, this.host())
  }

  private assertReferences(refs: {
    groupId?: string | null
    proxyId?: string | null
    tagIds?: readonly string[]
    extensionIds?: readonly string[]
  }): void {
    const { repos } = this.deps
    for (const extensionId of refs.extensionIds ?? []) {
      if (!repos.extensions.get(extensionId)) {
        throw new AppError('NOT_FOUND', `Extensão não encontrada: ${extensionId}`, {
          entity: 'extension',
          id: extensionId,
        })
      }
    }
    if (refs.groupId && !repos.groups.get(refs.groupId)) {
      throw new AppError('NOT_FOUND', `Grupo não encontrado: ${refs.groupId}`, {
        entity: 'group',
        id: refs.groupId,
      })
    }
    if (refs.proxyId && !repos.proxies.get(refs.proxyId)) {
      throw new AppError('NOT_FOUND', `Proxy não encontrado: ${refs.proxyId}`, {
        entity: 'proxy',
        id: refs.proxyId,
      })
    }
    for (const tagId of refs.tagIds ?? []) {
      if (!repos.tags.get(tagId)) {
        throw new AppError('NOT_FOUND', `Tag não encontrada: ${tagId}`, { entity: 'tag', id: tagId })
      }
    }
  }

  private requireActive(id: string): Profile {
    const profile = this.get(id)
    if (profile.deletedAt !== null) {
      throw new AppError('CONFLICT', `Perfil está na lixeira: ${id}`, { reason: 'trashed', id })
    }
    return profile
  }

  private activeOnly(ids: readonly string[]): Profile[] {
    return this.deps.repos.profiles.getMany(ids).filter((p) => p.deletedAt === null)
  }

  private emitUpserted(profiles: readonly Profile[]): void {
    if (profiles.length === 0) return
    this.deps.emit('profiles.changed', { upserted: profiles.map(toListItem), removedIds: [] })
    for (const profile of profiles) this.deps.emit('fingerprint.changed', { profileId: profile.id })
  }
}
