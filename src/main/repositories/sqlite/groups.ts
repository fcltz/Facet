import { eq } from 'drizzle-orm'
import type { AppDatabase } from '../../db/client'
import { groups } from '../../db/schema'
import { AppError } from '@shared/ipc/result'
import type { Group } from '@shared/schemas/group-tag'
import type { GroupPatch, GroupRepository } from '../types'

export const nameKey = (name: string): string => name.trim().normalize('NFC').toLocaleLowerCase('pt-BR')
const decode = ({ nameKey: _key, ...row }: typeof groups.$inferSelect): Group => row

export class SqliteGroupRepository implements GroupRepository {
  constructor(private readonly db: AppDatabase) {}
  list(): Group[] {
    return this.db.select().from(groups).all().map(decode)
  }
  get(id: string): Group | null {
    const row = this.db.select().from(groups).where(eq(groups.id, id)).get()
    return row ? decode(row) : null
  }
  findByName(name: string): Group | null {
    const row = this.db
      .select()
      .from(groups)
      .where(eq(groups.nameKey, nameKey(name)))
      .get()
    return row ? decode(row) : null
  }
  insert(row: Group): void {
    this.db
      .insert(groups)
      .values({ ...row, nameKey: nameKey(row.name) })
      .run()
  }
  update(id: string, patch: GroupPatch): Group {
    if (!this.get(id)) throw new AppError('NOT_FOUND', `Grupo não encontrado: ${id}`)
    this.db
      .update(groups)
      .set({ ...patch, ...(patch.name ? { nameKey: nameKey(patch.name) } : {}) })
      .where(eq(groups.id, id))
      .run()
    return this.get(id)!
  }
  delete(id: string): boolean {
    return this.db.delete(groups).where(eq(groups.id, id)).run().changes > 0
  }
}
