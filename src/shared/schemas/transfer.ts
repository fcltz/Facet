import { z } from 'zod'
import { LIMITS } from '../constants'
import type { AppErrorPayload } from '../ipc/result'
import { browserKindSchema, colorSchema, idSchema, osSchema, type OsName } from './common'
import { extensionIdSchema } from './extension'
import { fingerprintSchema } from './fingerprint'
import { jobIdSchema } from './jobs'
import { launchOptionsSchema } from './profile'
import { proxyTypeSchema, type ProxyType } from './proxy'

/** Versão do formato do pacote (.zip) de perfis. */
export const PACKAGE_FORMAT = 1

export const transferPasswordSchema = z
  .string()
  .min(LIMITS.transferPasswordMin, 'tooShort')
  .max(LIMITS.transferPasswordMax, 'tooLong')

export const exportOptionsSchema = z
  .object({
    /** Pasta do perfil sem caches (localStorage, IndexedDB, preferências…). */
    browserData: z.boolean(),
    /** Cookies lidos via CDP (o banco de cookies do Brave só abre no mesmo usuário do Windows). */
    cookies: z.boolean(),
    /** Pacotes das extensões usadas, para importar numa biblioteca sem elas. */
    extensions: z.boolean(),
    proxy: z.boolean(),
    /** Senha e URL de troca do proxy: só em pacote protegido por senha. */
    proxySecrets: z.boolean(),
    password: transferPasswordSchema.nullable(),
  })
  .refine((value) => !value.proxySecrets || (value.proxy && value.password !== null), {
    path: ['proxySecrets'],
    message: 'secretsNeedPassword',
  })
export type ExportOptions = z.infer<typeof exportOptionsSchema>

export const transferExportSchema = z.object({
  jobId: jobIdSchema,
  ids: z.array(idSchema).min(1, 'required').max(LIMITS.transferProfilesMax, 'tooMany'),
  options: exportOptionsSchema,
})
export type TransferExportInput = z.infer<typeof transferExportSchema>

export interface TransferExportResult {
  /** Nome do arquivo salvo; null = cancelado no seletor. */
  file: string | null
  profiles: number
  bytes: number
  cookies: number
  /** Perfis que estavam abertos e foram fechados para exportar. */
  stopped: number
}

export const packageProxySchema = z.object({
  type: proxyTypeSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().max(LIMITS.proxyCredentialMax),
  name: z.string().max(LIMITS.proxyNameMax).nullable(),
  password: z.string().max(LIMITS.proxyCredentialMax).nullable(),
  changeIpUrl: z.string().max(LIMITS.proxyChangeUrlMax).nullable(),
})
export type PackageProxy = z.infer<typeof packageProxySchema>

/** `profiles/<key>/profile.json`: tudo que o perfil precisa, sem IDs da instalação de origem. */
export const packageProfileSchema = z.object({
  name: z.string().trim().min(1).max(LIMITS.nameMax),
  notes: z.string().max(LIMITS.notesMax),
  color: colorSchema.nullable(),
  /** Ausente nos pacotes anteriores aos vários navegadores (todos do Brave). */
  browser: browserKindSchema.optional(),
  os: osSchema,
  fingerprint: fingerprintSchema,
  launchOptions: launchOptionsSchema,
  lastUrls: z.array(z.string().max(4096)).max(100),
  group: z.string().trim().min(1).max(LIMITS.groupNameMax).nullable(),
  tags: z.array(z.string().trim().min(1).max(LIMITS.tagNameMax)).max(LIMITS.tagsPerProfileMax),
  extensionIds: z.array(extensionIdSchema).max(LIMITS.extensionsPerProfileMax),
  proxy: packageProxySchema.nullable(),
})
export type PackageProfile = z.infer<typeof packageProfileSchema>

const appInfoSchema = z.object({ name: z.string().max(100), version: z.string().max(50) })

export const PACKAGE_KEY = /^p\d{1,4}$/

/** `facet-export.json` de um pacote sem senha (ou de dentro do conteúdo cifrado). */
export const packageManifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  kind: z.literal('facet-profiles'),
  app: appInfoSchema,
  createdAt: z.number(),
  /** `Browser.getVersion().product` do Brave que exportou. */
  engine: z.string().max(200).nullable(),
  profiles: z
    .array(
      z.object({
        key: z.string().regex(PACKAGE_KEY),
        name: z.string().max(LIMITS.nameMax),
        os: osSchema,
        data: z.boolean(),
        dataBytes: z.number().int().min(0),
        cookies: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(LIMITS.transferProfilesMax),
  extensions: z
    .array(z.object({ id: extensionIdSchema, name: z.string().max(200), version: z.string().max(50) }))
    .max(1000),
})
export type PackageManifest = z.infer<typeof packageManifestSchema>

export const kdfSchema = z.object({
  name: z.literal('scrypt'),
  N: z
    .number()
    .int()
    .min(1024)
    .max(2 ** 20),
  r: z.number().int().min(1).max(32),
  p: z.number().int().min(1).max(16),
  salt: z.string().min(16).max(128),
})
export type KdfParams = z.infer<typeof kdfSchema>

/** `facet-export.json` de um pacote com senha: o resto está cifrado em `payload.bin`. */
export const encryptedManifestSchema = z.object({
  format: z.literal(PACKAGE_FORMAT),
  kind: z.literal('facet-profiles-encrypted'),
  app: appInfoSchema,
  createdAt: z.number(),
  kdf: kdfSchema,
  /** HMAC de uma constante com a chave: senha errada é recusada antes de decifrar. */
  verifier: z.string().min(16).max(128),
})
export type EncryptedManifest = z.infer<typeof encryptedManifestSchema>

export interface TransferPreviewProfile {
  key: string
  name: string
  os: OsName
  data: boolean
  dataBytes: number
  cookies: number
  group: string | null
  tags: string[]
  proxy: { type: ProxyType; host: string; port: number; hasPassword: boolean } | null
  extensionIds: string[]
  /** Extensões que não estão na biblioteca nem no pacote: o perfil entra sem elas. */
  extensionsMissing: string[]
}

export interface TransferPreview {
  token: string
  fileName: string
  encrypted: boolean
  /** Pacote com senha ainda não aberto: perfis e extensões vêm depois de `transfer.unlock`. */
  locked: boolean
  createdAt: number
  appVersion: string
  engine: string | null
  /** O pacote veio de um navegador mais novo que o instalado (o Chromium pode recusar o perfil). */
  engineNewer: boolean
  profiles: TransferPreviewProfile[]
  extensions: { id: string; name: string; version: string; inLibrary: boolean }[]
}

export const transferTokenSchema = z.object({ token: z.uuid('invalidId') })
export const transferUnlockSchema = transferTokenSchema.extend({
  password: z.string().min(1, 'required').max(LIMITS.transferPasswordMax, 'tooLong'),
})
export const transferImportSchema = transferTokenSchema.extend({
  jobId: jobIdSchema,
  keys: z.array(z.string().regex(PACKAGE_KEY)).min(1, 'required').max(LIMITS.transferProfilesMax),
})

export interface TransferImportResult {
  createdIds: string[]
  proxiesCreated: number
  groupsCreated: number
  tagsCreated: number
  extensionsInstalled: number
  /** Cookies que serão aplicados na primeira abertura dos perfis importados. */
  cookies: number
  failed: { name: string; error: AppErrorPayload }[]
}
