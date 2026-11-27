import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { mergeCookies } from '@shared/cookies/formats'
import { cookieSchema, type BrowserCookie } from '@shared/schemas/cookies'
import type { AppDatabase } from '../../db/client'
import { pendingCookies } from '../../db/schema'
import type { SecretBox } from '../../security/secrets'
import type { PendingCookieRepository } from '../types'

const storedSchema = z.array(cookieSchema)

/** Os cookies ficam cifrados: são credenciais de sessão dos sites. */
export class SqlitePendingCookieRepository implements PendingCookieRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly secrets: SecretBox,
  ) {}

  status(profileId: string): { count: number; createdAt: number } | null {
    const row = this.db
      .select({ count: pendingCookies.count, createdAt: pendingCookies.createdAt })
      .from(pendingCookies)
      .where(eq(pendingCookies.profileId, profileId))
      .get()
    return row ?? null
  }

  get(profileId: string): BrowserCookie[] | null {
    const row = this.db.select().from(pendingCookies).where(eq(pendingCookies.profileId, profileId)).get()
    if (!row) return null
    return storedSchema.parse(JSON.parse(this.secrets.decrypt(row.cookiesEnc)))
  }

  add(profileId: string, cookies: readonly BrowserCookie[], now: number): number {
    const current = this.status(profileId) ? (this.get(profileId) ?? []) : []
    const merged = mergeCookies(current, cookies)
    const row = {
      profileId,
      cookiesEnc: this.secrets.encrypt(JSON.stringify(merged)),
      count: merged.length,
      createdAt: now,
    }
    this.db
      .insert(pendingCookies)
      .values(row)
      .onConflictDoUpdate({ target: pendingCookies.profileId, set: row })
      .run()
    return merged.length
  }

  clear(profileId: string): void {
    this.db.delete(pendingCookies).where(eq(pendingCookies.profileId, profileId)).run()
  }
}
