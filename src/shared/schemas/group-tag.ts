import { z } from 'zod'
import { LIMITS } from '../constants'
import { colorSchema, idSchema } from './common'

export interface Group {
  id: string
  name: string
  color: string
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export interface Tag {
  id: string
  name: string
  color: string
  createdAt: number
}

export const groupInputSchema = z.object({
  name: z.string().trim().min(1, 'required').max(LIMITS.groupNameMax, 'tooLong'),
  color: colorSchema,
})
export type GroupInput = z.infer<typeof groupInputSchema>

export const groupUpdateSchema = z.object({ id: idSchema, patch: groupInputSchema.partial() })
export type GroupUpdateInput = z.infer<typeof groupUpdateSchema>

export const tagInputSchema = z.object({
  name: z.string().trim().min(1, 'required').max(LIMITS.tagNameMax, 'tooLong'),
  color: colorSchema,
})
export type TagInput = z.infer<typeof tagInputSchema>

export const tagUpdateSchema = z.object({ id: idSchema, patch: tagInputSchema.partial() })
export type TagUpdateInput = z.infer<typeof tagUpdateSchema>

export interface DeleteCatalogResult {
  affectedProfiles: number
}
