import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../../db/client'
import { tags } from '../../db/schema'
import { AppError } from '@shared/ipc/result'
import type { Tag } from '@shared/schemas/group-tag'
import type { TagPatch, TagRepository } from '../types'
import { nameKey } from './groups'

const decode = ({ nameKey: _key, ...row }: typeof tags.$inferSelect): Tag => row
export class SqliteTagRepository implements TagRepository {
  constructor(private readonly db: AppDatabase) {}
  list(): Tag[] {
    return this.db.select().from(tags).all().map(decode)
  }
  get(id: string): Tag | null {
    const row = this.db.select().from(tags).where(eq(tags.id, id)).get()
    return row ? decode(row) : null
  }
  findByName(name: string): Tag | null {
    const row = this.db
      .select()
      .from(tags)
      .where(eq(tags.nameKey, nameKey(name)))
      .get()
    return row ? decode(row) : null
  }
  insert(row: Tag): void {
    this.db
      .insert(tags)
      .values({ ...row, nameKey: nameKey(row.name) })
      .run()
  }
  update(id: string, patch: TagPatch): Tag {
    if (!this.get(id)) throw new AppError('NOT_FOUND', `Tag não encontrada: ${id}`)
    this.db
      .update(tags)
      .set({ ...patch, ...(patch.name ? { nameKey: nameKey(patch.name) } : {}) })
      .where(eq(tags.id, id))
      .run()
    return this.get(id)!
  }
  delete(id: string): boolean {
    return this.db.delete(tags).where(eq(tags.id, id)).run().changes > 0
  }
}
