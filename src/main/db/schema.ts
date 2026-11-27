import { sql } from 'drizzle-orm'
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { FingerprintConfig, FingerprintSnapshot } from '@shared/schemas/fingerprint'
import type { LaunchOptions } from '@shared/schemas/profile'

export const groups = sqliteTable('groups', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull().unique(),
  color: text('color').notNull(),
  sortOrder: integer('sort_order').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
})
export const tags = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull().unique(),
  color: text('color').notNull(),
  createdAt: integer('created_at').notNull(),
})
export const proxies = sqliteTable(
  'proxies',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    type: text('type', { enum: ['http', 'https', 'socks5'] }).notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull(),
    username: text('username').notNull().default(''),
    passwordEnc: blob('password_enc', { mode: 'buffer' }),
    /** URL de troca de IP cifrada (contém a chave da API do provedor); o domínio fica em claro para exibir. */
    changeIpUrlEnc: blob('change_ip_url_enc', { mode: 'buffer' }),
    changeIpHost: text('change_ip_host'),
    notes: text('notes').notNull().default(''),
    checkStatus: text('check_status', { enum: ['unknown', 'online', 'offline'] })
      .notNull()
      .default('unknown'),
    checkedAt: integer('checked_at'),
    latencyMs: integer('latency_ms'),
    exitIp: text('exit_ip'),
    countryCode: text('country_code'),
    countryName: text('country_name'),
    region: text('region'),
    city: text('city'),
    timezone: text('timezone'),
    latitude: real('latitude'),
    longitude: real('longitude'),
    lastError: text('last_error'),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('proxy_endpoint_idx').on(t.type, t.host, t.port, t.username),
    check('proxy_port_check', sql`${t.port} between 1 and 65535`),
    check('proxy_type_check', sql`${t.type} in ('http', 'https', 'socks5')`),
  ],
)
export const profiles = sqliteTable(
  'profiles',
  {
    id: text('id').primaryKey(),
    /** Número sequencial do perfil (01, 02…): único e nunca reaproveitado (contador em `counters`). */
    serial: integer('serial').notNull(),
    name: text('name').notNull(),
    groupId: text('group_id').references(() => groups.id, { onDelete: 'set null' }),
    proxyId: text('proxy_id').references(() => proxies.id, { onDelete: 'set null' }),
    color: text('color'),
    notes: text('notes').notNull(),
    /** Navegador do perfil. Os perfis anteriores à migration 0010 foram todos criados no Brave. */
    browser: text('browser', { enum: ['ungoogled', 'chrome', 'brave', 'opera'] })
      .notNull()
      .default('brave'),
    os: text('os', { enum: ['windows', 'macos', 'linux', 'android', 'ios'] }).notNull(),
    userAgent: text('user_agent').notNull(),
    fingerprint: text('fingerprint', { mode: 'json' }).$type<FingerprintConfig>().notNull(),
    launchOptions: text('launch_options', { mode: 'json' }).$type<LaunchOptions>().notNull(),
    lastUrls: text('last_urls', { mode: 'json' }).$type<string[]>().notNull().default([]),
    lastOpenedAt: integer('last_opened_at'),
    lastClosedAt: integer('last_closed_at'),
    openCount: integer('open_count').notNull().default(0),
    deletedAt: integer('deleted_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('profiles_deleted_idx').on(t.deletedAt),
    index('profiles_group_idx').on(t.groupId),
    index('profiles_proxy_idx').on(t.proxyId),
    index('profiles_opened_idx').on(t.lastOpenedAt),
    uniqueIndex('profiles_serial_unique').on(t.serial),
    check('profiles_os_check', sql`${t.os} in ('windows', 'macos', 'linux', 'android', 'ios')`),
    check('profiles_browser_check', sql`${t.browser} in ('ungoogled', 'chrome', 'brave', 'opera')`),
  ],
)
export const profileTags = sqliteTable(
  'profile_tags',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.tagId] }), index('profile_tags_tag_idx').on(t.tagId)],
)
/** Biblioteca de extensões (arquivos em extensions/<id>/<dir_name>/, compartilhados pelos perfis). */
export const extensions = sqliteTable(
  'extensions',
  {
    /** ID do Chrome, derivado da chave pública gravada no manifest. */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    version: text('version').notNull(),
    description: text('description').notNull().default(''),
    manifestVersion: integer('manifest_version').notNull(),
    source: text('source', { enum: ['webstore', 'crx', 'zip', 'folder', 'builtin'] }).notNull(),
    /** Chave pública (SPKI em base64): mantém o mesmo ID quando os arquivos são trocados. */
    publicKey: text('public_key').notNull(),
    /** Pasta da versão em uso, dentro de extensions/<id>/. */
    dirName: text('dir_name').notNull(),
    /** Ícone como data URL. */
    icon: text('icon'),
    permissions: text('permissions', { mode: 'json' }).$type<string[]>().notNull().default([]),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    /** Autoconfiguração: o JSON fica cifrado; área, modo e nº de chaves ficam em claro para listar. */
    configEnc: blob('config_enc', { mode: 'buffer' }),
    configArea: text('config_area', { enum: ['local', 'sync'] }),
    configMode: text('config_mode', { enum: ['once', 'always'] }),
    configKeys: integer('config_keys'),
    configRevision: integer('config_revision').notNull().default(0),
    configUpdatedAt: integer('config_updated_at'),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    index('extensions_default_idx').on(t.isDefault),
    // `builtin`: a extensão Facet, que vem dentro do app (migration 0009).
    check('extensions_source_check', sql`${t.source} in ('webstore', 'crx', 'zip', 'folder', 'builtin')`),
    check('extensions_manifest_check', sql`${t.manifestVersion} in (2, 3)`),
  ],
)
export const profileExtensions = sqliteTable(
  'profile_extensions',
  {
    profileId: text('profile_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    extensionId: text('extension_id')
      .notNull()
      .references(() => extensions.id, { onDelete: 'cascade' }),
    addedAt: integer('added_at').notNull(),
    /** Primeira abertura em que o Brave carregou a extensão neste perfil. */
    firstLoadedAt: integer('first_loaded_at'),
    /** Revisão da autoconfiguração já aplicada neste perfil (null = nunca). */
    configRevision: integer('config_revision'),
    configAppliedAt: integer('config_applied_at'),
    configError: text('config_error'),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.extensionId] }),
    index('profile_extensions_extension_idx').on(t.extensionId),
  ],
)
/** Cookies importados num perfil fechado: aplicados via CDP na próxima abertura, antes da 1ª navegação. */
export const pendingCookies = sqliteTable('pending_cookies', {
  profileId: text('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  /** JSON dos cookies cifrado com o SecretBox (são credenciais de sessão). */
  cookiesEnc: blob('cookies_enc', { mode: 'buffer' }).notNull(),
  count: integer('count').notNull(),
  createdAt: integer('created_at').notNull(),
})
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: integer('updated_at').notNull(),
})
/** Contadores que só crescem (ex.: `profile_serial`, o último número de perfil atribuído). */
export const counters = sqliteTable('counters', {
  name: text('name').primaryKey(),
  value: integer('value').notNull(),
})
/**
 * Combinações de hardware emulado (`fingerprintKey`) já gravadas em algum perfil. Fica mesmo
 * depois da exclusão definitiva: o gerador evita entregar a um perfil novo o hardware de outro.
 */
export const fingerprintHistory = sqliteTable('fingerprint_history', {
  key: text('key').primaryKey(),
  firstUsedAt: integer('first_used_at').notNull(),
})
export const sessions = sqliteTable('profile_sessions', {
  profileId: text('profile_id')
    .primaryKey()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  phase: text('phase', { enum: ['starting', 'running', 'disconnected'] }).notNull(),
  pid: integer('pid'),
  processStartedAt: text('process_started_at'),
  executablePath: text('executable_path').notNull(),
  userDataDir: text('user_data_dir').notNull(),
  cdpPort: integer('cdp_port'),
  wsEndpoint: text('ws_endpoint'),
  engineVersion: text('engine_version'),
  /** Proxy usado na abertura (fica fixo até reiniciar) e porta do proxy local, para recuperar após queda. */
  proxyId: text('proxy_id'),
  localProxyPort: integer('local_proxy_port'),
  /** Pastas de extensão carregadas pelo Brave aberto (a limpeza não as apaga, mesmo após queda). */
  extensionDirs: text('extension_dirs', { mode: 'json' }).$type<string[]>(),
  fingerprintSnapshot: text('fingerprint_snapshot', { mode: 'json' }).$type<FingerprintSnapshot>(),
  startedAt: integer('started_at').notNull(),
})
