/**
 * Nomes dos canais de IPC, sem nenhuma dependência.
 *
 * Fica separado do contrato (que importa Zod) porque o preload roda com
 * `sandbox: true` e não pode carregar pacotes do node_modules: ele só precisa
 * desta lista para montar a allowlist.
 */
export const INVOKE_CHANNELS = [
  'app.getInfo',
  'fingerprint.generate',
  'fingerprint.session',
  'browser.getInfo',
  'browser.detect',
  'browser.validate',
  'browser.selectExecutable',
  'browser.openProfileFolder',
  'settings.get',
  'settings.update',
  'settings.getGeoIpToken',
  'settings.setGeoIpToken',
  'profiles.list',
  'profiles.get',
  'profiles.create',
  'profiles.bulkCreate',
  'profiles.update',
  'profiles.clone',
  'profiles.moveToGroup',
  'profiles.assignProxy',
  'profiles.trash',
  'profiles.restore',
  'profiles.deletePermanently',
  'profiles.emptyTrash',
  'groups.list',
  'groups.create',
  'groups.update',
  'groups.delete',
  'tags.list',
  'tags.create',
  'tags.update',
  'tags.delete',
  'proxies.list',
  'proxies.get',
  'proxies.getPassword',
  'proxies.create',
  'proxies.update',
  'proxies.delete',
  'proxies.parseImport',
  'proxies.import',
  'proxies.check',
  'proxies.cancelCheck',
  'proxies.testDraft',
  'proxies.rotate',
  'extensions.list',
  'extensions.importFile',
  'extensions.importWebStore',
  'extensions.refresh',
  'extensions.replace',
  'extensions.setDefault',
  'extensions.setPreferences',
  'extensions.assign',
  'extensions.delete',
  'extensions.getConfig',
  'extensions.setConfig',
  'extensions.captureConfig',
  'extensions.profileState',
  'extensions.reapplyConfig',
  'runtime.statuses',
  'runtime.start',
  'runtime.stop',
  'runtime.restart',
  'cookies.status',
  'cookies.pickFile',
  'cookies.import',
  'cookies.export',
  'cookies.clearPending',
  'transfer.export',
  'transfer.pickImport',
  'transfer.unlock',
  'transfer.import',
  'transfer.discard',
  'jobs.cancel',
  'profilesRoot.pick',
  'profilesRoot.move',
  'backup.run',
  'backup.pickFolder',
  'backup.openFolder',
  'backup.pickRestore',
  'backup.restore',
] as const
export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

export const EVENT_CHANNELS = [
  'runtime.statusChanged',
  'fingerprint.changed',
  'runtime.proxyHealth',
  'runtime.traffic',
  'profiles.changed',
  'proxies.changed',
  'proxies.checkProgress',
  'extensions.changed',
  'extensions.configResult',
  'catalog.changed',
  'settings.changed',
  'jobs.progress',
  'cookies.applied',
  'browsers.changed',
] as const
export type EventChannel = (typeof EVENT_CHANNELS)[number]

const invokeSet: ReadonlySet<string> = new Set(INVOKE_CHANNELS)
const eventSet: ReadonlySet<string> = new Set(EVENT_CHANNELS)

export function isInvokeChannel(channel: string): channel is InvokeChannel {
  return invokeSet.has(channel)
}

export function isEventChannel(channel: string): channel is EventChannel {
  return eventSet.has(channel)
}
