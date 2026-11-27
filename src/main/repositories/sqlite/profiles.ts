import { and, asc, eq, inArray, isNotNull, isNull, max } from 'drizzle-orm'
import type { DatabaseConnection } from '../../db/client'
import { counters, fingerprintHistory, profileExtensions, profiles, profileTags } from '../../db/schema'
import { AppError } from '@shared/ipc/result'
import {
  fingerprintKey,
  fingerprintSchema,
  type FingerprintConfig,
  type FingerprintUsage,
} from '@shared/schemas/fingerprint'
import {
  launchOptionsSchema,
  type NewProfile,
  type Profile,
  type ProfileScope,
} from '@shared/schemas/profile'
import type { ProfilePatch, ProfileRepository } from '../types'

const PROFILE_SERIAL = 'profile_serial'

export class SqliteProfileRepository implements ProfileRepository {
  constructor(private readonly connection: DatabaseConnection) {}
  private decode(row: typeof profiles.$inferSelect, tagIds: string[], extensionIds: string[]): Profile {
    const { lastUrls: _lastUrls, ...profile } = row
    return {
      ...profile,
      tagIds,
      extensionIds,
      fingerprint: fingerprintSchema.parse(row.fingerprint),
      launchOptions: launchOptionsSchema.parse(row.launchOptions),
    }
  }
  list(scope: ProfileScope): Profile[] {
    const { db } = this.connection
    const relation = new Map<string, string[]>()
    for (const row of db.select().from(profileTags).all()) {
      const ids = relation.get(row.profileId) ?? []
      ids.push(row.tagId)
      relation.set(row.profileId, ids)
    }
    const extensionRelation = new Map<string, string[]>()
    for (const row of db
      .select()
      .from(profileExtensions)
      .orderBy(asc(profileExtensions.addedAt), asc(profileExtensions.extensionId))
      .all()) {
      const ids = extensionRelation.get(row.profileId) ?? []
      ids.push(row.extensionId)
      extensionRelation.set(row.profileId, ids)
    }
    return db
      .select()
      .from(profiles)
      .where(
        scope === 'all'
          ? undefined
          : scope === 'trash'
            ? isNotNull(profiles.deletedAt)
            : isNull(profiles.deletedAt),
      )
      .all()
      .map((row) => this.decode(row, relation.get(row.id) ?? [], extensionRelation.get(row.id) ?? []))
  }
  get(id: string): Profile | null {
    const { db } = this.connection
    const row = db.select().from(profiles).where(eq(profiles.id, id)).get()
    return row
      ? this.decode(
          row,
          db
            .select()
            .from(profileTags)
            .where(eq(profileTags.profileId, id))
            .all()
            .map((t) => t.tagId),
          this.extensionIds(id),
        )
      : null
  }
  getMany(ids: readonly string[]): Profile[] {
    return [...new Set(ids)].map((id) => this.get(id)).filter((p): p is Profile => p !== null)
  }
  insertMany(items: readonly NewProfile[]): Profile[] {
    return this.connection.sqlite.transaction(() => {
      if (items.length === 0) return []
      const first = this.reserveSerials(items.length)
      return items.map((item, index): Profile => {
        const serial = first + index
        const { tagIds, extensionIds, ...row } = item
        this.connection.db
          .insert(profiles)
          .values({ ...row, serial })
          .run()
        this.recordFingerprint(item.fingerprint, item.createdAt)
        this.setTags(item.id, tagIds)
        this.setExtensions(item.id, extensionIds, item.createdAt)
        return { ...item, serial }
      })
    })()
  }
  /** Reserva `count` números seguidos no contador; roda dentro da transação da gravação. */
  private reserveSerials(count: number): number {
    const { db } = this.connection
    const row = db.select().from(counters).where(eq(counters.name, PROFILE_SERIAL)).get()
    // Sem a linha do contador (não acontece depois da migration 0006): parte do maior número gravado.
    const current =
      row?.value ??
      db
        .select({ value: max(profiles.serial) })
        .from(profiles)
        .get()?.value ??
      0
    const last = current + count
    db.insert(counters)
      .values({ name: PROFILE_SERIAL, value: last })
      .onConflictDoUpdate({ target: counters.name, set: { value: last } })
      .run()
    return current + 1
  }
  update(id: string, patch: ProfilePatch): Profile {
    return this.connection.sqlite.transaction(() => {
      if (!this.get(id)) throw new AppError('NOT_FOUND', `Perfil não encontrado: ${id}`)
      const { tagIds, extensionIds, ...row } = patch
      if (Object.values(row).some((v) => v !== undefined))
        this.connection.db.update(profiles).set(row).where(eq(profiles.id, id)).run()
      if (row.fingerprint) this.recordFingerprint(row.fingerprint, patch.updatedAt ?? Date.now())
      if (tagIds) this.setTags(id, tagIds)
      if (extensionIds) this.setExtensions(id, extensionIds, patch.updatedAt ?? Date.now())
      return this.get(id)!
    })()
  }
  updateMany(ids: readonly string[], patch: ProfilePatch): Profile[] {
    return this.connection.sqlite.transaction(() => this.getMany(ids).map((p) => this.update(p.id, patch)))()
  }
  deleteMany(ids: readonly string[]): number {
    return this.connection.sqlite.transaction(() =>
      [...new Set(ids)].reduce(
        (count, id) => count + this.connection.db.delete(profiles).where(eq(profiles.id, id)).run().changes,
        0,
      ),
    )()
  }
  clearGroup(groupId: string, updatedAt: number): Profile[] {
    return this.updateMany(
      this.list('all')
        .filter((p) => p.groupId === groupId)
        .map((p) => p.id),
      { groupId: null, updatedAt },
    )
  }
  clearTag(tagId: string, updatedAt: number): Profile[] {
    return this.connection.sqlite.transaction(() =>
      this.list('all')
        .filter((p) => p.tagIds.includes(tagId))
        .map((p) => this.update(p.id, { tagIds: p.tagIds.filter((t) => t !== tagId), updatedAt })),
    )()
  }
  fingerprintUsage(): FingerprintUsage {
    const { db } = this.connection
    const inUse = new Map<string, number>()
    for (const row of db.select({ fingerprint: profiles.fingerprint }).from(profiles).all()) {
      const parsed = fingerprintSchema.safeParse(row.fingerprint)
      const key = parsed.success ? fingerprintKey(parsed.data) : null
      if (key) inUse.set(key, (inUse.get(key) ?? 0) + 1)
    }
    const used = new Set(inUse.keys())
    for (const row of db.select({ key: fingerprintHistory.key }).from(fingerprintHistory).all())
      used.add(row.key)
    return { inUse, used }
  }
  /** O hardware emulado gravado entra no histórico (uma vez por combinação). */
  private recordFingerprint(fingerprint: FingerprintConfig, at: number): void {
    const key = fingerprintKey(fingerprint)
    if (!key) return
    this.connection.db
      .insert(fingerprintHistory)
      .values({ key, firstUsedAt: at })
      .onConflictDoNothing({ target: fingerprintHistory.key })
      .run()
  }
  private extensionIds(id: string): string[] {
    return this.connection.db
      .select({ extensionId: profileExtensions.extensionId })
      .from(profileExtensions)
      .where(eq(profileExtensions.profileId, id))
      .orderBy(asc(profileExtensions.addedAt), asc(profileExtensions.extensionId))
      .all()
      .map((row) => row.extensionId)
  }
  /** Só mexe no que mudou: as extensões que continuam mantêm a 1ª carga e a autoconfiguração aplicada. */
  private setExtensions(id: string, extensionIds: readonly string[], addedAt: number): void {
    const { db } = this.connection
    const next = new Set(extensionIds)
    const current = new Set(this.extensionIds(id))
    const removed = [...current].filter((extensionId) => !next.has(extensionId))
    if (removed.length > 0) {
      db.delete(profileExtensions)
        .where(and(eq(profileExtensions.profileId, id), inArray(profileExtensions.extensionId, removed)))
        .run()
    }
    for (const extensionId of next) {
      if (!current.has(extensionId))
        db.insert(profileExtensions).values({ profileId: id, extensionId, addedAt }).run()
    }
  }
  private setTags(id: string, tagIds: readonly string[]): void {
    const { db } = this.connection
    db.delete(profileTags).where(eq(profileTags.profileId, id)).run()
    for (const tagId of new Set(tagIds)) db.insert(profileTags).values({ profileId: id, tagId }).run()
  }
}
