import { z } from 'zod'
import { BROWSER_KINDS, LIMITS, MOBILE_OS_LIST, OS_LIST, type DESKTOP_OS_LIST } from '../constants'

/**
 * As mensagens dos schemas são chaves de tradução (namespace "validation" no
 * i18n do renderer). Assim o processo principal e os formulários compartilham a
 * mesma validação sem depender do idioma.
 */
export const idSchema = z.uuid('invalidId')

export const idInputSchema = z.object({ id: idSchema })
export type IdInput = z.infer<typeof idInputSchema>

export const idsInputSchema = z.object({
  ids: z.array(idSchema).min(1, 'required').max(LIMITS.idsPerCallMax, 'tooMany'),
})
export type IdsInput = z.infer<typeof idsInputSchema>

export const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'invalidColor')

export const osSchema = z.enum(OS_LIST)
export type OsName = z.infer<typeof osSchema>
export type MobileOs = (typeof MOBILE_OS_LIST)[number]
export type DesktopOs = (typeof DESKTOP_OS_LIST)[number]

/** Android e iOS: sempre emulados (o Facet roda num computador). */
export function isMobileOs(os: OsName): os is MobileOs {
  return (MOBILE_OS_LIST as readonly string[]).includes(os)
}

export const browserKindSchema = z.enum(BROWSER_KINDS)

export interface BulkCountResult {
  count: number
}
