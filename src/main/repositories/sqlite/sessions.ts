import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../../db/client'
import { sessions, profiles } from '../../db/schema'
import { fingerprintSnapshotSchema } from '@shared/schemas/fingerprint'

export type ProfileSession = typeof sessions.$inferSelect
export class SessionRepository {
  constructor(private readonly db: AppDatabase) {}
  list(): ProfileSession[] {
    return this.db
      .select()
      .from(sessions)
      .all()
      .map((row) => this.decode(row))
  }
  get(id: string): ProfileSession | null {
    const row = this.db.select().from(sessions).where(eq(sessions.profileId, id)).get()
    return row ? this.decode(row) : null
  }
  private decode(row: ProfileSession): ProfileSession {
    return {
      ...row,
      fingerprintSnapshot:
        row.fingerprintSnapshot === null ? null : fingerprintSnapshotSchema.parse(row.fingerprintSnapshot),
    }
  }
  save(row: ProfileSession): void {
    if (row.fingerprintSnapshot) fingerprintSnapshotSchema.parse(row.fingerprintSnapshot)
    this.db.insert(sessions).values(row).onConflictDoUpdate({ target: sessions.profileId, set: row }).run()
  }
  delete(id: string): void {
    this.db.delete(sessions).where(eq(sessions.profileId, id)).run()
  }
  getUrls(id: string): string[] {
    return (
      this.db.select({ urls: profiles.lastUrls }).from(profiles).where(eq(profiles.id, id)).get()?.urls ?? []
    )
  }
  saveUrls(id: string, urls: string[]): void {
    this.db.update(profiles).set({ lastUrls: urls }).where(eq(profiles.id, id)).run()
  }
}
