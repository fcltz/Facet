import { z } from 'zod'
import { LIMITS, RESERVED_ARG_PREFIXES, type BrowserKind } from '../constants'
import type { AppErrorPayload } from '../ipc/result'
import { browserKindSchema, colorSchema, idSchema, idsInputSchema, osSchema, type OsName } from './common'
import { extensionIdSchema } from './extension'
import { fingerprintV2Schema, type FingerprintConfig } from './fingerprint'

export const RUNTIME_STATUSES = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'disconnected',
  'error',
] as const
export type RuntimeStatus = (typeof RUNTIME_STATUSES)[number]

export function isRuntimeActive(status: RuntimeStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'stopping' || status === 'disconnected'
}

const extraArgSchema = z
  .string()
  .trim()
  .regex(/^--[a-z0-9][a-z0-9-]*(=.*)?$/i, 'invalidArg')
  .refine(
    (arg) => !RESERVED_ARG_PREFIXES.some((prefix) => arg.toLowerCase().startsWith(prefix)),
    'reservedArg',
  )

const windowSizeSchema = z.object({
  width: z.number().int('invalidNumber').min(400, 'outOfRange').max(7680, 'outOfRange'),
  height: z.number().int('invalidNumber').min(300, 'outOfRange').max(4320, 'outOfRange'),
})

export const launchOptionsSchema = z.object({
  startupUrls: z
    .array(z.url({ protocol: /^https?$/, error: 'invalidUrl' }))
    .max(LIMITS.startupUrlsMax, 'tooMany'),
  window: windowSizeSchema.nullable(),
  restoreTabs: z.boolean(),
  extraArgs: z.array(extraArgSchema).max(LIMITS.extraArgsMax, 'tooMany'),
})
export type LaunchOptions = z.infer<typeof launchOptionsSchema>

export const DEFAULT_LAUNCH_OPTIONS: LaunchOptions = {
  startupUrls: [],
  window: null,
  restoreTabs: false,
  extraArgs: [],
}

export interface Profile {
  id: string
  /** Número sequencial (1, 2, 3…), exibido como "01"; único e nunca reaproveitado. */
  serial: number
  name: string
  groupId: string | null
  proxyId: string | null
  tagIds: string[]
  /** Extensões da biblioteca carregadas neste perfil (IDs do Chrome). */
  extensionIds: string[]
  color: string | null
  notes: string
  /** Navegador que abre o perfil (Ungoogled Chromium, Chrome, Brave ou Opera). */
  browser: BrowserKind
  os: OsName
  /** Cópia de fingerprint.userAgent, usada na tabela e na busca. */
  userAgent: string
  fingerprint: FingerprintConfig
  launchOptions: LaunchOptions
  lastOpenedAt: number | null
  lastClosedAt: number | null
  openCount: number
  /** Preenchido quando o perfil está na lixeira. */
  deletedAt: number | null
  createdAt: number
  updatedAt: number
}

/** Perfil ainda não gravado: o número sequencial é atribuído pelo banco, na gravação. */
export type NewProfile = Omit<Profile, 'serial'>

/** Número do perfil com pelo menos dois dígitos: 1 → "01", 12 → "12", 105 → "105". */
export function formatSerial(serial: number): string {
  return String(serial).padStart(2, '0')
}

/** Identificação curta usada no navegador e na barra de tarefas: "01 · Loja". */
export function profileLabel(profile: Pick<Profile, 'serial' | 'name'>): string {
  return `${formatSerial(profile.serial)} · ${profile.name}`
}

/** Versão leve usada na listagem (sem o JSON de fingerprint e as opções de abertura). */
export type ProfileListItem = Omit<Profile, 'fingerprint' | 'launchOptions'>

export function toListItem(profile: Profile): ProfileListItem {
  const { fingerprint: _fingerprint, launchOptions: _launchOptions, ...item } = profile
  return item
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Nomes numerados que continuam a sequência existente: com "Perfil 07" já
 * criado, os próximos são "Perfil 08", "Perfil 09"… (usado pelo processo
 * principal e pela pré-visualização da criação em massa).
 */
export function sequentialNames(prefix: string, count: number, existing: Iterable<string>): string[] {
  const pattern = new RegExp(`^${escapeRegExp(prefix)} (\\d+)$`)
  let max = 0
  for (const name of existing) {
    const match = pattern.exec(name)
    if (match?.[1]) max = Math.max(max, Number(match[1]))
  }
  const width = Math.max(2, String(max + count).length)
  return Array.from({ length: count }, (_, i) => `${prefix} ${String(max + 1 + i).padStart(width, '0')}`)
}

const nameSchema = z.string().trim().min(1, 'required').max(LIMITS.nameMax, 'tooLong')
const tagIdsSchema = z.array(idSchema).max(LIMITS.tagsPerProfileMax, 'tooMany')
const extensionIdsSchema = z.array(extensionIdSchema).max(LIMITS.extensionsPerProfileMax, 'tooMany')

export const profileCreateSchema = z.object({
  name: nameSchema,
  /** Ausente na criação = o navegador padrão das Configurações. */
  browser: browserKindSchema.optional(),
  os: osSchema,
  groupId: idSchema.nullable(),
  proxyId: idSchema.nullable(),
  tagIds: tagIdsSchema,
  color: colorSchema.nullable(),
  notes: z.string().max(LIMITS.notesMax, 'tooLong'),
  launchOptions: launchOptionsSchema,
  /** Ausente na criação = extensões marcadas como padrão na biblioteca. */
  extensionIds: extensionIdsSchema.optional(),
  fingerprint: fingerprintV2Schema.optional(),
})
export type ProfileCreateInput = z.infer<typeof profileCreateSchema>

export const profileUpdateSchema = z.object({ id: idSchema, patch: profileCreateSchema.partial() })
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>
export type ProfilePatchInput = ProfileUpdateInput['patch']

export const PROFILE_SCOPES = ['active', 'trash', 'all'] as const
export type ProfileScope = (typeof PROFILE_SCOPES)[number]
export const profileListSchema = z.object({ scope: z.enum(PROFILE_SCOPES) })

export const bulkCreateSchema = z.object({
  count: z.number().int('invalidNumber').min(1, 'outOfRange').max(LIMITS.bulkCreateMax, 'outOfRange'),
  namePrefix: z.string().trim().min(1, 'required').max(LIMITS.bulkPrefixMax, 'tooLong'),
  /** Ausente = o navegador padrão das Configurações. */
  browser: browserKindSchema.optional(),
  os: osSchema,
  groupId: idSchema.nullable(),
  proxyId: idSchema.nullable(),
  tagIds: tagIdsSchema,
  /** Páginas iniciais de cada perfil criado; ausente ou vazio = a página inicial das Configurações. */
  startupUrls: launchOptionsSchema.shape.startupUrls.optional(),
})
export type BulkCreateInput = z.infer<typeof bulkCreateSchema>

export const moveToGroupSchema = idsInputSchema.extend({ groupId: idSchema.nullable() })
export type MoveToGroupInput = z.infer<typeof moveToGroupSchema>

export const assignProxySchema = idsInputSchema.extend({ proxyId: idSchema.nullable() })
export type AssignProxyInput = z.infer<typeof assignProxySchema>

export interface AssignProxyResult {
  updated: ProfileListItem[]
  /** Perfis que estavam abertos: a troca só vale depois de reiniciar. */
  runningIds: string[]
}

export interface RuntimeActionResult {
  done: string[]
  failed: { id: string; error: AppErrorPayload }[]
}
