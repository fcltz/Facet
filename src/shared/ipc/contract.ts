import { z } from 'zod'
import {
  backupRunSchema,
  restoreTokenSchema,
  type BackupResult,
  type RestoreCandidate,
} from '../schemas/backup'
import {
  cookieExportSchema,
  cookieImportSchema,
  type CookieExportResult,
  type CookieImportResult,
  type CookieStatus,
} from '../schemas/cookies'
import { jobCancelSchema } from '../schemas/jobs'
import {
  transferExportSchema,
  transferImportSchema,
  transferTokenSchema,
  transferUnlockSchema,
  type TransferExportResult,
  type TransferImportResult,
  type TransferPreview,
} from '../schemas/transfer'
import {
  fingerprintGenerateSchema,
  type FingerprintConfig,
  type FingerprintSessionState,
} from '../schemas/fingerprint'
import {
  browserKindInputSchema,
  browserPathSchema,
  type BrowserInfo,
  type BrowsersInfo,
} from '../schemas/browser'
import { idInputSchema, idsInputSchema, type BulkCountResult } from '../schemas/common'
import {
  extensionAssignSchema,
  extensionCaptureSchema,
  extensionDeleteSchema,
  extensionIdInputSchema,
  extensionImportFileSchema,
  extensionImportWebStoreSchema,
  extensionProfileStateSchema,
  extensionReapplySchema,
  extensionReplaceSchema,
  extensionSetConfigSchema,
  extensionSetDefaultSchema,
  extensionPreferencesSchema,
  type ExtensionAssignResult,
  type ExtensionCaptureResult,
  type ExtensionConfigData,
  type ExtensionDeleteResult,
  type ExtensionImportResult,
  type ExtensionSummary,
  type ProfileExtensionState,
} from '../schemas/extension'
import {
  groupInputSchema,
  groupUpdateSchema,
  tagInputSchema,
  tagUpdateSchema,
  type DeleteCatalogResult,
  type Group,
  type Tag,
} from '../schemas/group-tag'
import {
  assignProxySchema,
  bulkCreateSchema,
  moveToGroupSchema,
  profileCreateSchema,
  profileListSchema,
  profileUpdateSchema,
  type AssignProxyResult,
  type Profile,
  type ProfileListItem,
  type RuntimeActionResult,
} from '../schemas/profile'
import {
  proxyCreateSchema,
  proxyDeleteSchema,
  proxyImportSchema,
  proxyParseImportSchema,
  proxyTestDraftSchema,
  proxyUpdateSchema,
  type ProxyCheckOutcome,
  type ProxyCheckResult,
  type ProxyDeleteResult,
  type ProxyImportPreview,
  type ProxyImportResult,
  type ProxyPassword,
  type ProxyRotateResult,
  type ProxySummary,
} from '../schemas/proxy'
import {
  geoIpTokenSchema,
  profilesRootMoveSchema,
  profilesRootPickSchema,
  settingsPatchSchema,
  type AppInfo,
  type AppSettings,
  type GeoIpTokenStatus,
  type Language,
  type ProfilesRootCandidate,
  type ProfilesRootMoveResult,
} from '../schemas/settings'
import type { EventChannel, InvokeChannel } from './channels'
import type { EventPayloads, RuntimeStatusEvent } from './events'
import type { Result } from './result'

/** Definição de um canal: schema Zod da entrada + tipo da saída (só em tempo de compilação). */
export interface ChannelDef<I extends z.ZodType, O> {
  input: I
  output: O
}

function channel<O>() {
  return <I extends z.ZodType>(input: I): ChannelDef<I, O> => ({ input, output: undefined as O })
}

const noInput = z.undefined()

export const ipcContract = {
  'app.getInfo': channel<AppInfo>()(noInput),
  'fingerprint.generate': channel<FingerprintConfig>()(fingerprintGenerateSchema),
  'fingerprint.session': channel<FingerprintSessionState>()(idInputSchema),
  'browser.getInfo': channel<BrowsersInfo>()(noInput),
  /** Esquece o executável escolhido e procura o navegador de novo. */
  'browser.detect': channel<BrowserInfo>()(browserKindInputSchema),
  'browser.validate': channel<BrowserInfo>()(browserPathSchema),
  'browser.selectExecutable': channel<BrowserInfo | null>()(browserKindInputSchema),
  'browser.openProfileFolder': channel<void>()(idInputSchema),

  'settings.get': channel<AppSettings>()(noInput),
  'settings.update': channel<AppSettings>()(settingsPatchSchema),
  'settings.getGeoIpToken': channel<GeoIpTokenStatus>()(noInput),
  'settings.setGeoIpToken': channel<GeoIpTokenStatus>()(geoIpTokenSchema),

  'profiles.list': channel<ProfileListItem[]>()(profileListSchema),
  'profiles.get': channel<Profile>()(idInputSchema),
  'profiles.create': channel<Profile>()(profileCreateSchema),
  'profiles.bulkCreate': channel<ProfileListItem[]>()(bulkCreateSchema),
  'profiles.update': channel<Profile>()(profileUpdateSchema),
  'profiles.clone': channel<Profile>()(idInputSchema),
  'profiles.moveToGroup': channel<ProfileListItem[]>()(moveToGroupSchema),
  'profiles.assignProxy': channel<AssignProxyResult>()(assignProxySchema),
  'profiles.trash': channel<BulkCountResult>()(idsInputSchema),
  'profiles.restore': channel<BulkCountResult>()(idsInputSchema),
  'profiles.deletePermanently': channel<BulkCountResult>()(idsInputSchema),
  'profiles.emptyTrash': channel<BulkCountResult>()(noInput),

  'groups.list': channel<Group[]>()(noInput),
  'groups.create': channel<Group>()(groupInputSchema),
  'groups.update': channel<Group>()(groupUpdateSchema),
  'groups.delete': channel<DeleteCatalogResult>()(idInputSchema),

  'tags.list': channel<Tag[]>()(noInput),
  'tags.create': channel<Tag>()(tagInputSchema),
  'tags.update': channel<Tag>()(tagUpdateSchema),
  'tags.delete': channel<DeleteCatalogResult>()(idInputSchema),

  'proxies.list': channel<ProxySummary[]>()(noInput),
  'proxies.get': channel<ProxySummary>()(idInputSchema),
  /** Senha salva, só para o formulário de edição (as listas nunca levam a senha). */
  'proxies.getPassword': channel<ProxyPassword>()(idInputSchema),
  'proxies.create': channel<ProxySummary>()(proxyCreateSchema),
  'proxies.update': channel<ProxySummary>()(proxyUpdateSchema),
  'proxies.delete': channel<ProxyDeleteResult>()(proxyDeleteSchema),
  'proxies.parseImport': channel<ProxyImportPreview>()(proxyParseImportSchema),
  'proxies.import': channel<ProxyImportResult>()(proxyImportSchema),
  'proxies.check': channel<ProxyCheckResult[]>()(idsInputSchema),
  'proxies.cancelCheck': channel<void>()(noInput),
  'proxies.testDraft': channel<ProxyCheckOutcome>()(proxyTestDraftSchema),
  'proxies.rotate': channel<ProxyRotateResult>()(idInputSchema),

  'extensions.list': channel<ExtensionSummary[]>()(noInput),
  /** Abre o seletor de arquivo/pasta no processo principal; null = cancelado. */
  'extensions.importFile': channel<ExtensionImportResult | null>()(extensionImportFileSchema),
  'extensions.importWebStore': channel<ExtensionImportResult>()(extensionImportWebStoreSchema),
  /** Baixa de novo da Chrome Web Store (só extensões vindas de lá). */
  'extensions.refresh': channel<ExtensionImportResult>()(extensionIdInputSchema),
  /** Troca os arquivos de uma extensão local mantendo o ID; null = cancelado. */
  'extensions.replace': channel<ExtensionImportResult | null>()(extensionReplaceSchema),
  'extensions.setDefault': channel<ExtensionSummary[]>()(extensionSetDefaultSchema),
  'extensions.setPreferences': channel<ExtensionSummary>()(extensionPreferencesSchema),
  'extensions.assign': channel<ExtensionAssignResult>()(extensionAssignSchema),
  'extensions.delete': channel<ExtensionDeleteResult>()(extensionDeleteSchema),
  'extensions.getConfig': channel<ExtensionConfigData | null>()(extensionIdInputSchema),
  'extensions.setConfig': channel<ExtensionSummary>()(extensionSetConfigSchema),
  'extensions.captureConfig': channel<ExtensionCaptureResult>()(extensionCaptureSchema),
  'extensions.profileState': channel<ProfileExtensionState[]>()(extensionProfileStateSchema),
  'extensions.reapplyConfig': channel<ProfileExtensionState[]>()(extensionReapplySchema),

  'runtime.statuses': channel<RuntimeStatusEvent[]>()(noInput),
  'runtime.start': channel<RuntimeActionResult>()(idsInputSchema),
  'runtime.stop': channel<RuntimeActionResult>()(idsInputSchema),
  'runtime.restart': channel<RuntimeActionResult>()(idsInputSchema),

  'cookies.status': channel<CookieStatus>()(idInputSchema),
  'cookies.pickFile': channel<{ name: string; text: string } | null>()(noInput),
  /** Perfil aberto: grava na hora; fechado: fica pendente até a próxima abertura. */
  'cookies.import': channel<CookieImportResult>()(cookieImportSchema),
  /** `file` abre o seletor no processo principal; `clipboard` devolve o texto. */
  'cookies.export': channel<CookieExportResult>()(cookieExportSchema),
  'cookies.clearPending': channel<CookieStatus>()(idInputSchema),

  /** Abre o seletor de destino no processo principal; `file: null` = cancelado. */
  'transfer.export': channel<TransferExportResult>()(transferExportSchema),
  /** Abre o seletor de arquivo no processo principal; null = cancelado. */
  'transfer.pickImport': channel<TransferPreview | null>()(noInput),
  'transfer.unlock': channel<TransferPreview>()(transferUnlockSchema),
  'transfer.import': channel<TransferImportResult>()(transferImportSchema),
  'transfer.discard': channel<void>()(transferTokenSchema),
  'jobs.cancel': channel<void>()(jobCancelSchema),

  /** Seletor de pasta no processo principal; a mudança usa o token da pasta conferida. */
  'profilesRoot.pick': channel<ProfilesRootCandidate | null>()(profilesRootPickSchema),
  'profilesRoot.move': channel<ProfilesRootMoveResult>()(profilesRootMoveSchema),

  'backup.run': channel<BackupResult>()(backupRunSchema),
  /** Seletor de pasta no processo principal; null = cancelado. */
  'backup.pickFolder': channel<AppSettings | null>()(noInput),
  'backup.openFolder': channel<void>()(noInput),
  'backup.pickRestore': channel<RestoreCandidate | null>()(noInput),
  /** Prepara a restauração e reinicia o app; ela é aplicada antes de abrir o banco. */
  'backup.restore': channel<void>()(restoreTokenSchema),
} satisfies Record<InvokeChannel, ChannelDef<z.ZodType, unknown>>

export type IpcContract = typeof ipcContract
/** Entrada como o renderer envia (antes do parse). */
export type ChannelInput<C extends InvokeChannel> = z.input<IpcContract[C]['input']>
/** Entrada já validada, como o handler recebe. */
export type ChannelParsedInput<C extends InvokeChannel> = z.output<IpcContract[C]['input']>
export type ChannelOutput<C extends InvokeChannel> = IpcContract[C]['output']
/** Canais sem entrada podem ser chamados sem argumento. */
export type InvokeArgs<C extends InvokeChannel> =
  undefined extends ChannelInput<C> ? [input?: ChannelInput<C>] : [input: ChannelInput<C>]

/** API exposta pelo preload em `window.api`. */
export interface FacetBridge {
  invoke<C extends InvokeChannel>(channel: C, input?: ChannelInput<C>): Promise<Result<ChannelOutput<C>>>
  on<E extends EventChannel>(event: E, listener: (payload: EventPayloads[E]) => void): () => void
  readonly platform: string
  readonly initialLanguage: Language
  /** Primeira abertura: começa pela tela de boas-vindas. */
  readonly initialWelcome: boolean
}
