import { z } from 'zod'
import { LIMITS } from '../constants'
import { jobIdSchema } from './jobs'

export const BACKUP_INTERVALS = ['off', 'daily', 'weekly'] as const
export type BackupInterval = (typeof BACKUP_INTERVALS)[number]

export const BACKUP_INTERVAL_MS: Record<Exclude<BackupInterval, 'off'>, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

export const backupConfigSchema = z.object({
  interval: z.enum(BACKUP_INTERVALS),
  /** Backups mantidos na pasta; os mais antigos são apagados. */
  keep: z.number().int('invalidNumber').min(1, 'outOfRange').max(LIMITS.backupKeepMax, 'outOfRange'),
  /** Vazio = `<dados do app>/backups`. */
  folder: z.string().max(4096),
  /** Pastas dos perfis fechados (sem caches). Desligado = só banco, configurações e extensões. */
  includeProfiles: z.boolean(),
})
export type BackupConfig = z.infer<typeof backupConfigSchema>

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  interval: 'off',
  keep: 7,
  folder: '',
  includeProfiles: false,
}

/** Resultado do último backup (gravado pelo processo principal). */
export const backupStateSchema = z.object({
  lastAt: z.number().nullable(),
  lastFile: z.string().max(4096).nullable(),
  lastError: z.string().max(2000).nullable(),
  /** Nomes dos perfis abertos que ficaram de fora. */
  skipped: z.array(z.string().max(200)).max(1000),
})
export type BackupState = z.infer<typeof backupStateSchema>

export const DEFAULT_BACKUP_STATE: BackupState = {
  lastAt: null,
  lastFile: null,
  lastError: null,
  skipped: [],
}

export const BACKUP_FORMAT = 1

export const backupManifestSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  kind: z.literal('facet-backup'),
  app: z.object({ name: z.string().max(100), version: z.string().max(50) }),
  createdAt: z.number(),
  /** Marca da máquina e do usuário (hash): o cofre do Windows só abre no mesmo usuário. */
  machine: z.string().max(128),
  includesProfiles: z.boolean(),
  profiles: z.array(z.uuid()).max(100_000),
  /** Perfis abertos que ficaram de fora. */
  skipped: z.array(z.uuid()).max(100_000),
})
export type BackupManifest = z.infer<typeof backupManifestSchema>

export const backupRunSchema = z.object({ jobId: jobIdSchema, includeProfiles: z.boolean() })

export interface BackupResult {
  fileName: string
  bytes: number
  profiles: number
  skipped: string[]
}

export interface RestoreCandidate {
  token: string
  fileName: string
  createdAt: number
  appVersion: string
  includesProfiles: boolean
  profiles: number
  /** Backup feito em outra máquina ou usuário: senhas e cookies não serão legíveis. */
  otherMachine: boolean
}

export const restoreTokenSchema = z.object({ token: z.uuid('invalidId') })
