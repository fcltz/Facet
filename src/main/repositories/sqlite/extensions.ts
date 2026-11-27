import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { AppError } from '@shared/ipc/result'
import {
  DEFAULT_EXTENSION_CONFIG_MODE,
  type ExtensionConfigMode,
  type ExtensionSummary,
  type ProfileExtensionState,
} from '@shared/schemas/extension'
import type { AppDatabase } from '../../db/client'
import { extensions, profileExtensions } from '../../db/schema'
import type { SecretBox } from '../../security/secrets'
import type {
  ExtensionConfigOutcome,
  ExtensionConfigValue,
  ExtensionConfigWrite,
  ExtensionPackage,
  ExtensionRepository,
  ExtensionRow,
} from '../types'

type Row = typeof extensions.$inferSelect
type LinkRow = typeof profileExtensions.$inferSelect

function toRow(row: Row): ExtensionRow {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    manifestVersion: row.manifestVersion,
    source: row.source,
    publicKey: row.publicKey,
    dirName: row.dirName,
    icon: row.icon,
    permissions: [...row.permissions],
    sizeBytes: row.sizeBytes,
    isDefault: row.isDefault,
    applyMode: row.configMode ?? DEFAULT_EXTENSION_CONFIG_MODE,
    config:
      row.configEnc && row.configArea && row.configMode
        ? {
            area: row.configArea,
            mode: row.configMode,
            revision: row.configRevision,
            keys: row.configKeys ?? 0,
            updatedAt: row.configUpdatedAt ?? row.updatedAt,
          }
        : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function extensionSummary(row: ExtensionRow, profileCount: number): ExtensionSummary {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    manifestVersion: row.manifestVersion,
    source: row.source,
    icon: row.icon,
    permissions: [...row.permissions],
    hasStorage: row.permissions.includes('storage'),
    isDefault: row.isDefault,
    applyMode: row.applyMode,
    config: row.config ? { ...row.config } : null,
    profileCount,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function linkState(row: LinkRow): ProfileExtensionState {
  return {
    extensionId: row.extensionId,
    addedAt: row.addedAt,
    firstLoadedAt: row.firstLoadedAt,
    configRevision: row.configRevision,
    configAppliedAt: row.configAppliedAt,
    configError: row.configError,
  }
}

export function byName(a: { name: string; id: string }, b: { name: string; id: string }): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id)
}

export class SqliteExtensionRepository implements ExtensionRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly secretBox: SecretBox,
  ) {}

  private counts(): Map<string, number> {
    const rows = this.db
      .select({ id: profileExtensions.extensionId, count: sql<number>`count(*)` })
      .from(profileExtensions)
      .groupBy(profileExtensions.extensionId)
      .all()
    return new Map(rows.map((row) => [row.id, Number(row.count)]))
  }

  list(): ExtensionSummary[] {
    const counts = this.counts()
    return this.db
      .select()
      .from(extensions)
      .all()
      .map(toRow)
      .sort(byName)
      .map((row) => extensionSummary(row, counts.get(row.id) ?? 0))
  }

  get(id: string): ExtensionSummary | null {
    const row = this.row(id)
    if (!row) return null
    const count = this.db
      .select({ count: sql<number>`count(*)` })
      .from(profileExtensions)
      .where(eq(profileExtensions.extensionId, id))
      .get()
    return extensionSummary(row, Number(count?.count ?? 0))
  }

  getMany(ids: readonly string[]): ExtensionSummary[] {
    return [...new Set(ids)].map((id) => this.get(id)).filter((e): e is ExtensionSummary => e !== null)
  }

  row(id: string): ExtensionRow | null {
    const row = this.db.select().from(extensions).where(eq(extensions.id, id)).get()
    return row ? toRow(row) : null
  }

  savePackage(
    pkg: ExtensionPackage,
    now: number,
  ): { summary: ExtensionSummary; previous: ExtensionRow | null } {
    return this.db.transaction(() => {
      const previous = this.row(pkg.id)
      const files = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        manifestVersion: pkg.manifestVersion,
        source: pkg.source,
        publicKey: pkg.publicKey,
        dirName: pkg.dirName,
        icon: pkg.icon,
        permissions: [...pkg.permissions],
        sizeBytes: pkg.sizeBytes,
        updatedAt: now,
      }
      if (previous) this.db.update(extensions).set(files).where(eq(extensions.id, pkg.id)).run()
      else
        this.db
          .insert(extensions)
          .values({ id: pkg.id, ...files, createdAt: now })
          .run()
      return { summary: this.get(pkg.id)!, previous }
    })
  }

  setDefault(ids: readonly string[], isDefault: boolean, now: number): ExtensionSummary[] {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    this.db.update(extensions).set({ isDefault, updatedAt: now }).where(inArray(extensions.id, unique)).run()
    return this.getMany(unique)
  }

  defaultIds(): string[] {
    return this.db
      .select()
      .from(extensions)
      .where(eq(extensions.isDefault, true))
      .all()
      .map(toRow)
      .sort(byName)
      .map((row) => row.id)
  }

  setPreferences(id: string, mode: ExtensionConfigMode, isDefault: boolean, now: number): ExtensionSummary {
    if (!this.row(id)) throw new AppError('NOT_FOUND', `Extensão não encontrada: ${id}`)
    this.db
      .update(extensions)
      .set({ configMode: mode, isDefault, updatedAt: now })
      .where(eq(extensions.id, id))
      .run()
    return this.get(id)!
  }

  config(id: string): ExtensionConfigValue | null {
    const row = this.db.select().from(extensions).where(eq(extensions.id, id)).get()
    if (!row?.configEnc || !row.configArea || !row.configMode) return null
    return {
      area: row.configArea,
      mode: row.configMode,
      json: this.secretBox.decrypt(row.configEnc),
      revision: row.configRevision,
      updatedAt: row.configUpdatedAt ?? row.updatedAt,
    }
  }

  setConfig(
    id: string,
    config: ExtensionConfigWrite | null,
    reapply: boolean,
    now: number,
  ): ExtensionSummary {
    const current = this.db.select().from(extensions).where(eq(extensions.id, id)).get()
    if (!current)
      throw new AppError('NOT_FOUND', `Extensão não encontrada: ${id}`, { entity: 'extension', id })
    // Cifra fora da transação: se o cofre falhar, nada muda.
    const encrypted = config ? this.secretBox.encrypt(config.json) : null
    return this.db.transaction(() => {
      this.db
        .update(extensions)
        .set({
          configEnc: encrypted,
          configArea: config?.area ?? null,
          configMode: config?.mode ?? current.configMode,
          configKeys: config?.keys ?? null,
          configRevision: current.configRevision + 1,
          configUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(extensions.id, id))
        .run()
      if (reapply) {
        this.db
          .update(profileExtensions)
          .set({ configRevision: null, configAppliedAt: null, configError: null })
          .where(eq(profileExtensions.extensionId, id))
          .run()
      }
      return this.get(id)!
    })
  }

  deleteMany(ids: readonly string[]): number {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return 0
    return this.db.delete(extensions).where(inArray(extensions.id, unique)).run().changes
  }

  profileIdsUsing(ids: readonly string[]): string[] {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    const rows = this.db
      .selectDistinct({ profileId: profileExtensions.profileId })
      .from(profileExtensions)
      .where(inArray(profileExtensions.extensionId, unique))
      .all()
    return rows.map((row) => row.profileId)
  }

  profileState(profileId: string): ProfileExtensionState[] {
    return this.db
      .select()
      .from(profileExtensions)
      .where(eq(profileExtensions.profileId, profileId))
      .orderBy(asc(profileExtensions.addedAt), asc(profileExtensions.extensionId))
      .all()
      .map(linkState)
  }

  markLoaded(profileId: string, extensionIds: readonly string[], at: number): void {
    const unique = [...new Set(extensionIds)]
    if (unique.length === 0) return
    this.db
      .update(profileExtensions)
      .set({ firstLoadedAt: at })
      .where(
        and(
          eq(profileExtensions.profileId, profileId),
          inArray(profileExtensions.extensionId, unique),
          isNull(profileExtensions.firstLoadedAt),
        ),
      )
      .run()
  }

  markConfigResult(profileId: string, extensionId: string, outcome: ExtensionConfigOutcome): void {
    const values =
      'revision' in outcome
        ? { configRevision: outcome.revision, configAppliedAt: outcome.at, configError: null }
        : { configError: outcome.error }
    this.db
      .update(profileExtensions)
      .set(values)
      .where(and(eq(profileExtensions.profileId, profileId), eq(profileExtensions.extensionId, extensionId)))
      .run()
  }

  resetConfig(profileId: string, extensionIds: readonly string[]): ProfileExtensionState[] {
    const unique = [...new Set(extensionIds)]
    if (unique.length > 0) {
      this.db
        .update(profileExtensions)
        .set({ configRevision: null, configAppliedAt: null, configError: null })
        .where(
          and(eq(profileExtensions.profileId, profileId), inArray(profileExtensions.extensionId, unique)),
        )
        .run()
    }
    return this.profileState(profileId)
  }

  directories(): string[] {
    return this.db
      .select({ id: extensions.id, dirName: extensions.dirName })
      .from(extensions)
      .all()
      .map((row) => `${row.id}/${row.dirName}`)
  }
}
