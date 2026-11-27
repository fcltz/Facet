import { z } from 'zod'

export const OPTIONAL_PROFILE_COLUMNS = ['serial', 'group', 'tags', 'proxy', 'system', 'lastOpened'] as const
export const RESIZABLE_PROFILE_COLUMNS = [
  'serial',
  'name',
  'status',
  'group',
  'tags',
  'proxy',
  'system',
  'lastOpened',
] as const
export type OptionalProfileColumn = (typeof OPTIONAL_PROFILE_COLUMNS)[number]
export type ResizableProfileColumn = (typeof RESIZABLE_PROFILE_COLUMNS)[number]
export const profileTableSchema = z.object({
  hidden: z.array(z.enum(OPTIONAL_PROFILE_COLUMNS)).max(OPTIONAL_PROFILE_COLUMNS.length),
  widths: z.partialRecord(z.enum(RESIZABLE_PROFILE_COLUMNS), z.number().int().min(48).max(32000)),
})
export type ProfileTablePreferences = z.infer<typeof profileTableSchema>
export const DEFAULT_PROFILE_TABLE: ProfileTablePreferences = { hidden: [], widths: {} }
