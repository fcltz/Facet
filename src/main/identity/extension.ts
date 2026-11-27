import fs from 'node:fs'
import path from 'node:path'
import { formatSerial, profileLabel, type Profile } from '@shared/schemas/profile'
import type { CdpClient } from '../browser/cdp/client'
import { openExtensionPage } from '../extensions/autoconfig'
import type { Logger } from '../logger'
import { badgeIco, badgePng } from './icon'

/**
 * Chave pública fixa da extensão de identificação: o mesmo ID em todos os perfis, para o
 * ícone continuar fixado entre aberturas (`extensions.pinned_extensions` guarda o ID).
 */
export const IDENTITY_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtr5bFTznIh+hibw0gCemojGQp3gYRrptWk+u6Cd/JpJ6/OPzFnXc2VJcdJa2w6dbidIrcEH1xdKkg1VhbE18MtN+sKUgnsMC7TkqS26rtiSmfS4hqqGALvOLP5Ft5LagjNgLzJ2CVkgCJCpqHT8F61OLKlJGRvSrNlmD/Kva27eBcmpFnmnegr6KXEDHmMuVDtj86ydGJ50pSp/alL8kybfSPyES23L/fNdlrhJeZWIjKfl7agARiAD2UYZfvlNy6p2xxVyCER0JyT35CZAfqX308pdvaTh2/dYhT+dQkFMvfFIOhBDA8oAf1d8YbdXMB3NkLmQGKaBZL9Mk0bhfrQIDAQAB'
export const IDENTITY_EXTENSION_ID = 'gnlbmghdbkjkogijiodkidngibpcdjap'

/** Muda quando o desenho do ícone muda (os ícones gravados são refeitos). */
const ICON_VERSION = 1
const PNG_SIZES = [16, 32, 48, 128] as const
const LABEL_MAX = 60

/** Rótulo curto o bastante para o grupo de abas, a dica e o nome da extensão. */
export function identityLabel(profile: Pick<Profile, 'serial' | 'name'>): string {
  const label = profileLabel(profile).replace(/[\r\n\t]+/g, ' ')
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label
}

/**
 * Service worker da extensão: põe as abas de cada janela normal num grupo roxo com o
 * rótulo do perfil. Abas criadas ao mesmo tempo passam por uma fila, para nunca abrir dois
 * grupos na mesma janela. Os IDs dos grupos ficam em `storage.session` (o service worker
 * dorme e acorda) e o Facet usa a mesma lista para desagrupar e renomear.
 */
export function identityServiceWorker(label: string): string {
  return `// Gerado pelo Facet: grupo de abas com a identificação do perfil.
const BASE_TITLE = ${JSON.stringify(label)}
const COLOR = 'purple'
let queue = Promise.resolve()
function enqueue(task) {
  queue = queue.then(task, task).catch(() => undefined)
  return queue
}
async function title() {
  const { title } = await chrome.storage.session.get('title')
  return typeof title === 'string' && title ? title : BASE_TITLE
}
async function groups() {
  const { groups } = await chrome.storage.session.get('groups')
  return groups && typeof groups === 'object' ? groups : {}
}
async function groupOf(windowId) {
  const id = (await groups())[windowId]
  if (typeof id !== 'number') return null
  try {
    const group = await chrome.tabGroups.get(id)
    return group.windowId === windowId ? group.id : null
  } catch {
    return null
  }
}
async function addTabs(windowId, tabIds) {
  if (!tabIds.length) return
  const existing = await groupOf(windowId)
  let groupId
  try {
    groupId = await chrome.tabs.group(
      existing === null ? { tabIds, createProperties: { windowId } } : { groupId: existing, tabIds },
    )
  } catch {
    return // pop-up, aba sendo arrastada ou janela fechando
  }
  const map = await groups()
  map[windowId] = groupId
  await chrome.storage.session.set({ groups: map })
  await chrome.tabGroups.update(groupId, { title: await title(), color: COLOR })
}
async function groupAll() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] })
  for (const window of windows) {
    const loose = (window.tabs || []).filter((tab) => tab.groupId === -1 && !tab.pinned)
    await addTabs(window.id, loose.map((tab) => tab.id))
  }
}
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.groupId === -1 && !tab.pinned) enqueue(() => addTabs(tab.windowId, [tab.id]))
})
chrome.runtime.onStartup.addListener(() => enqueue(groupAll))
chrome.runtime.onInstalled.addListener(() => enqueue(groupAll))
`
}

export function identityManifest(label: string): Record<string, unknown> {
  const icons = Object.fromEntries(PNG_SIZES.map((size) => [String(size), `icon${size}.png`]))
  return {
    manifest_version: 3,
    name: label,
    short_name: label.split(' · ')[0],
    description: 'Identificação do perfil no Facet: grupo de abas e ícone com o número do perfil.',
    version: '1.0.0',
    key: IDENTITY_EXTENSION_KEY,
    minimum_chrome_version: '120',
    icons,
    action: { default_title: label, default_icon: { 16: 'icon16.png', 32: 'icon32.png' } },
    // Sem scripts nas páginas, sem permissões de sites e sem recursos acessíveis: os sites não
    // têm como perceber a extensão.
    permissions: ['tabGroups', 'storage'],
    background: { service_worker: 'sw.js' },
  }
}

export interface ProfileIdentityFiles {
  /** "01 · Nome" (encurtado). */
  label: string
  /** Pasta da extensão para o --load-extension; null = desligada ou caminho inválido. */
  extensionDir: string | null
  /** Ícone da barra de tarefas (.ico). */
  iconPath: string
  /** AppUserModelID das janelas do perfil no Windows. */
  appId: string
}

function writeIfChanged(file: string, data: string | Buffer): void {
  const next = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  try {
    if (fs.readFileSync(file).equals(next)) return
  } catch {
    // ainda não existe
  }
  fs.writeFileSync(file, next)
}

/** Arquivos de identificação de cada perfil em `<dados do app>/identity/<id>/`. */
export class ProfileIdentityStore {
  constructor(
    private readonly root: string,
    private readonly logger: Logger,
  ) {}

  directory(profileId: string): string {
    return path.join(this.root, profileId)
  }

  /** Grava ícones (só quando o número muda), manifest e service worker; barato a cada abertura. */
  prepare(
    profile: Pick<Profile, 'id' | 'serial' | 'name'>,
    options: { inBrowser: boolean },
  ): ProfileIdentityFiles {
    const directory = this.directory(profile.id)
    const extensionDir = path.join(directory, 'extension')
    fs.mkdirSync(extensionDir, { recursive: true })
    const label = identityLabel(profile)
    const text = formatSerial(profile.serial)
    const metaFile = path.join(directory, 'meta.json')
    const iconPath = path.join(directory, 'taskbar.ico')
    let meta: { serial?: number; version?: number } = {}
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as typeof meta
    } catch {
      // primeira abertura ou arquivo corrompido: refaz os ícones
    }
    const iconsMissing = [
      iconPath,
      ...PNG_SIZES.map((size) => path.join(extensionDir, `icon${size}.png`)),
    ].some((file) => !fs.existsSync(file))
    if (meta.serial !== profile.serial || meta.version !== ICON_VERSION || iconsMissing) {
      for (const size of PNG_SIZES)
        fs.writeFileSync(path.join(extensionDir, `icon${size}.png`), badgePng(size, text))
      fs.writeFileSync(iconPath, badgeIco(text))
      fs.writeFileSync(metaFile, JSON.stringify({ serial: profile.serial, version: ICON_VERSION }))
    }
    writeIfChanged(path.join(extensionDir, 'manifest.json'), JSON.stringify(identityManifest(label), null, 2))
    writeIfChanged(path.join(extensionDir, 'sw.js'), identityServiceWorker(label))
    // O --load-extension separa as pastas por vírgula: com vírgula no caminho, sem extensão.
    const usable = options.inBrowser && !extensionDir.includes(',')
    if (options.inBrowser && !usable) {
      this.logger.warn('Pasta de dados com vírgula: a identificação no navegador fica desligada')
    }
    return {
      label,
      extensionDir: usable ? extensionDir : null,
      iconPath,
      appId: `Facet.Profile.${profile.id.replace(/-/g, '')}`,
    }
  }

  remove(profileId: string): void {
    fs.rmSync(this.directory(profileId), { recursive: true, force: true })
  }
}

/** Expressões avaliadas numa página oculta da extensão (o service worker pode estar dormindo). */
const UNGROUP_EXPRESSION = `(async () => {
  const { groups } = await chrome.storage.session.get('groups')
  const ids = new Set(Object.values(groups || {}))
  const tabs = await chrome.tabs.query({})
  const ours = tabs.filter((tab) => ids.has(tab.groupId)).map((tab) => tab.id)
  if (ours.length) await chrome.tabs.ungroup(ours)
  return ours.length
})()`

function renameExpression(label: string): string {
  return `(async (title) => {
  await chrome.storage.session.set({ title })
  const { groups } = await chrome.storage.session.get('groups')
  for (const id of new Set(Object.values(groups || {}))) {
    try {
      await chrome.tabGroups.update(id, { title })
    } catch {}
  }
  await chrome.action.setTitle({ title })
  return true
})(${JSON.stringify(label)})`
}

async function runInIdentityPage(
  client: CdpClient,
  expression: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const page = await openExtensionPage(client, IDENTITY_EXTENSION_ID, signal)
  try {
    for (let attempt = 0; ; attempt++) {
      const response = await client.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        page.sessionId,
      )
      if (!response.exceptionDetails) return response.result.value
      // contexto ainda carregando logo após abrir a página
      if (attempt >= 3) throw new Error(response.exceptionDetails.text)
      await new Promise((done) => setTimeout(done, 150))
    }
  } finally {
    await page.close()
  }
}

/**
 * Antes de o Facet fechar o perfil: desfaz os grupos da extensão. Grupo fechado junto com a
 * janela vira "grupo salvo" no Brave (uma cópia por abertura); desagrupado, não fica cópia.
 */
export function ungroupIdentityTabs(client: CdpClient, signal?: AbortSignal): Promise<unknown> {
  return runInIdentityPage(client, UNGROUP_EXPRESSION, signal)
}

/** Nome novo com o perfil aberto: grupo de abas e dica do ícone na hora. */
export function renameIdentity(client: CdpClient, label: string, signal?: AbortSignal): Promise<unknown> {
  return runInIdentityPage(client, renameExpression(label), signal)
}
