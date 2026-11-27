import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { z, ZodError } from 'zod'
import type { Entry, ZipFile } from 'yauzl'
import { DEFAULT_COLOR, LIMITS } from '@shared/constants'
import { validateCookie } from '@shared/cookies/formats'
import type { EmitFn } from '@shared/ipc/events'
import { AppError, type AppErrorPayload } from '@shared/ipc/result'
import { cookieSchema, type BrowserCookie } from '@shared/schemas/cookies'
import { proxyCreateSchema } from '@shared/schemas/proxy'
import {
  encryptedManifestSchema,
  packageManifestSchema,
  packageProfileSchema,
  type EncryptedManifest,
  type PackageManifest,
  type PackageProfile,
  type PackageProxy,
  type TransferImportResult,
  type TransferPreview,
} from '@shared/schemas/transfer'
import { checkVerifier, DecryptStream, deriveKey } from '../archive/crypto'
import {
  byteBudget,
  extractEntry,
  forEachEntry,
  openEntry,
  openZipFile,
  readEntryBuffer,
  type InvalidZip,
} from '../archive/zip-reader'
import type { ProfileFiles } from '../browser/profile-files'
import { isWebUrl } from '../browser/sessions'
import type { JobContext } from '../jobs'
import type { Logger } from '../logger'
import type { Repositories } from '../repositories/types'
import type { SessionRepository } from '../repositories/sqlite/sessions'
import type { ExtensionService } from '../services/extension.service'
import type { GroupService, TagService } from '../services/group-tag.service'
import type { ProfileService } from '../services/profile.service'
import type { ProxyService } from '../services/proxy.service'
import { sanitizeImportedProfile } from './profile-data'

const invalid: InvalidZip = (message, reason = 'package') =>
  new AppError('TRANSFER_INVALID', message, { reason })

/** Pacotes abertos e não importados são descartados depois de 30 minutos. */
const TOKEN_TTL_MS = 30 * 60 * 1000
const MANIFEST = 'facet-export.json'
const MANIFEST_MAX_BYTES = 1024 * 1024

interface OpenPackage {
  token: string
  file: string
  fileName: string
  openedAt: number
  header: EncryptedManifest | null
  /** O próprio arquivo (sem senha) ou o conteúdo decifrado num temporário. */
  contentFile: string | null
  manifest: PackageManifest | null
  profiles: Map<string, PackageProfile>
}

export interface ImportDeps {
  repos: Repositories
  sessions: Pick<SessionRepository, 'saveUrls'>
  files: ProfileFiles
  profiles: ProfileService
  groups: GroupService
  tags: TagService
  proxies: ProxyService
  extensions: Pick<ExtensionService, 'importFolder'>
  engineProduct: () => string | null
  emit: EmitFn
  now: () => number
  tempDir: string
  logger: Logger
}

function parseJson<T>(raw: Buffer, schema: z.ZodType<T>, what: string): T {
  try {
    return schema.parse(JSON.parse(raw.toString('utf8')))
  } catch (error) {
    const detail = error instanceof ZodError ? (error.issues[0]?.path.join('.') ?? '') : ''
    throw invalid(`${what} inválido${detail ? ` (${detail})` : ''}`)
  }
}

const cookieListSchema = z.array(cookieSchema).max(LIMITS.cookiesImportMax)

function majorOf(product: string | null): number | null {
  const major = Number(/(?:Chrome|Chromium)\/(\d+)/.exec(product ?? '')?.[1])
  return Number.isInteger(major) ? major : null
}

function payload(error: unknown): AppErrorPayload {
  return error instanceof AppError
    ? error.toPayload()
    : { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
}

async function readManifest(
  file: string,
): Promise<{ header: EncryptedManifest | null; manifest: PackageManifest | null }> {
  let zipfile: ZipFile
  try {
    zipfile = await openZipFile(file)
  } catch (error) {
    throw invalid(`O arquivo não é um ZIP válido: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const found: { raw: Buffer | null } = { raw: null }
    await forEachEntry(
      zipfile,
      async ({ entry, segments }) => {
        if (segments.length === 1 && segments[0] === MANIFEST)
          found.raw = await readEntryBuffer(zipfile, entry, MANIFEST_MAX_BYTES, invalid)
      },
      { maxEntries: LIMITS.transferMaxEntries, invalid },
    )
    const raw = found.raw
    if (!raw) throw invalid('Este ZIP não é um pacote de perfis do Facet', 'notPackage')
    const kind = (JSON.parse(raw.toString('utf8')) as { kind?: unknown }).kind
    if (kind === 'facet-profiles-encrypted')
      return { header: parseJson(raw, encryptedManifestSchema, 'Manifesto'), manifest: null }
    if (kind === 'facet-profiles')
      return { header: null, manifest: parseJson(raw, packageManifestSchema, 'Manifesto') }
    throw invalid('Este ZIP não é um pacote de perfis do Facet', 'notPackage')
  } catch (error) {
    if (error instanceof SyntaxError) throw invalid('Manifesto inválido')
    throw error
  } finally {
    zipfile.close()
  }
}

/** Manifesto e `profile.json` de cada perfil (sem extrair os dados). */
async function inspectContent(
  file: string,
): Promise<{ manifest: PackageManifest; profiles: Map<string, PackageProfile> }> {
  const zipfile = await openZipFile(file).catch((error: unknown) => {
    throw invalid(`Conteúdo do pacote inválido: ${error instanceof Error ? error.message : String(error)}`)
  })
  try {
    const holder: { manifest: PackageManifest | null } = { manifest: null }
    const profiles = new Map<string, PackageProfile>()
    await forEachEntry(
      zipfile,
      async ({ entry, segments, directory }) => {
        if (directory) return
        if (segments.length === 1 && segments[0] === MANIFEST) {
          holder.manifest = parseJson(
            await readEntryBuffer(zipfile, entry, MANIFEST_MAX_BYTES, invalid),
            packageManifestSchema,
            'Manifesto',
          )
        } else if (segments.length === 3 && segments[0] === 'profiles' && segments[2] === 'profile.json') {
          profiles.set(
            segments[1]!,
            parseJson(
              await readEntryBuffer(zipfile, entry, LIMITS.transferJsonMaxBytes, invalid),
              packageProfileSchema,
              'profile.json',
            ),
          )
        }
      },
      { maxEntries: LIMITS.transferMaxEntries, invalid },
    )
    const found = holder.manifest
    if (!found) throw invalid('Pacote sem manifesto', 'notPackage')
    for (const entry of found.profiles)
      if (!profiles.has(entry.key)) throw invalid(`Pacote incompleto: falta o perfil ${entry.name}`)
    return { manifest: found, profiles }
  } finally {
    zipfile.close()
  }
}

async function decryptPayload(file: string, key: Buffer, target: string): Promise<void> {
  const zipfile = await openZipFile(file)
  try {
    const found: { entry: Entry | null } = { entry: null }
    await forEachEntry(
      zipfile,
      async ({ entry, segments }) => {
        if (segments.length === 1 && segments[0] === 'payload.bin') {
          if (entry.uncompressedSize > LIMITS.transferMaxBytes)
            throw invalid('Pacote grande demais', 'tooLarge')
          found.entry = entry
          await pipeline(
            await openEntry(zipfile, entry),
            new DecryptStream(key),
            fs.createWriteStream(target, { flags: 'wx' }),
          )
        }
      },
      { maxEntries: 16, invalid },
    )
    if (!found.entry) throw invalid('Pacote protegido sem conteúdo')
  } catch (error) {
    fs.rmSync(target, { force: true })
    throw error
  } finally {
    zipfile.close()
  }
}

/**
 * Importação em duas fases: abrir (manifesto e prévia; com senha, só depois de
 * `unlock`) e importar os perfis escolhidos. Cada perfil entra com ID novo; grupos,
 * tags, proxies e extensões são reaproveitados pelo nome/endereço/ID ou criados. Os
 * cookies ficam pendentes e entram na primeira abertura via CDP.
 */
export class TransferImports {
  private readonly open = new Map<string, OpenPackage>()

  constructor(private readonly deps: ImportDeps) {}

  async inspect(file: string): Promise<TransferPreview> {
    this.expire()
    const { header, manifest } = await readManifest(file)
    const pkg: OpenPackage = {
      token: randomUUID(),
      file,
      fileName: path.basename(file),
      openedAt: this.deps.now(),
      header,
      contentFile: header ? null : file,
      manifest,
      profiles: new Map(),
    }
    if (!header) {
      const content = await inspectContent(file)
      pkg.manifest = content.manifest
      pkg.profiles = content.profiles
    }
    this.open.set(pkg.token, pkg)
    return this.preview(pkg)
  }

  async unlock(token: string, password: string): Promise<TransferPreview> {
    const pkg = this.require(token)
    if (!pkg.header || pkg.contentFile) return this.preview(pkg)
    const key = await deriveKey(password, pkg.header.kdf)
    if (!checkVerifier(key, pkg.header.verifier)) throw new AppError('TRANSFER_PASSWORD', 'Senha incorreta')
    fs.mkdirSync(this.deps.tempDir, { recursive: true })
    const target = path.join(this.deps.tempDir, `${token}.zip`)
    await decryptPayload(pkg.file, key, target)
    try {
      const content = await inspectContent(target)
      pkg.contentFile = target
      pkg.manifest = content.manifest
      pkg.profiles = content.profiles
    } catch (error) {
      fs.rmSync(target, { force: true })
      throw error
    }
    return this.preview(pkg)
  }

  async import(token: string, keys: readonly string[], job: JobContext): Promise<TransferImportResult> {
    const pkg = this.require(token)
    if (!pkg.contentFile || !pkg.manifest)
      throw new AppError('TRANSFER_PASSWORD', 'Pacote protegido: informe a senha antes de importar')
    const selected = pkg.manifest.profiles.filter((entry) => keys.includes(entry.key))
    if (selected.length === 0) throw new AppError('NOT_FOUND', 'Nenhum perfil do pacote foi escolhido')
    try {
      const extracted = await this.extract(pkg, selected, job)
      const installed = await this.installExtensions(extracted.extensions)
      return this.createProfiles(pkg, selected, extracted, installed, job)
    } finally {
      this.discard(token)
    }
  }

  discard(token: string): void {
    const pkg = this.open.get(token)
    this.open.delete(token)
    if (pkg?.header && pkg.contentFile) fs.rmSync(pkg.contentFile, { force: true })
    fs.rmSync(path.join(this.deps.tempDir, token), { recursive: true, force: true })
    try {
      this.deps.files.discardImportStaging(token)
    } catch (error) {
      this.deps.logger.warn('Área de importação não pôde ser limpa', error)
    }
  }

  close(): void {
    for (const token of [...this.open.keys()]) this.discard(token)
  }

  private expire(): void {
    const now = this.deps.now()
    for (const pkg of [...this.open.values()]) if (now - pkg.openedAt > TOKEN_TTL_MS) this.discard(pkg.token)
  }

  private require(token: string): OpenPackage {
    const pkg = this.open.get(token)
    if (!pkg) throw new AppError('NOT_FOUND', 'O pacote não está mais aberto; escolha o arquivo de novo')
    return pkg
  }

  private preview(pkg: OpenPackage): TransferPreview {
    const manifest = pkg.manifest
    const local = majorOf(this.deps.engineProduct())
    const remote = majorOf(manifest?.engine ?? null)
    const library = new Set(this.deps.repos.extensions.list().map((extension) => extension.id))
    const included = new Set(manifest?.extensions.map((extension) => extension.id) ?? [])
    return {
      token: pkg.token,
      fileName: pkg.fileName,
      encrypted: pkg.header !== null,
      locked: manifest === null,
      createdAt: manifest?.createdAt ?? pkg.header?.createdAt ?? 0,
      appVersion: manifest?.app.version ?? pkg.header?.app.version ?? '',
      engine: manifest?.engine ?? null,
      engineNewer: local !== null && remote !== null && remote > local,
      profiles: (manifest?.profiles ?? []).map((entry) => {
        const profile = pkg.profiles.get(entry.key)!
        return {
          key: entry.key,
          name: profile.name,
          os: profile.os,
          data: entry.data,
          dataBytes: entry.dataBytes,
          cookies: entry.cookies,
          group: profile.group,
          tags: profile.tags,
          proxy: profile.proxy
            ? {
                type: profile.proxy.type,
                host: profile.proxy.host,
                port: profile.proxy.port,
                hasPassword: Boolean(profile.proxy.password),
              }
            : null,
          extensionIds: profile.extensionIds,
          extensionsMissing: profile.extensionIds.filter((id) => !library.has(id) && !included.has(id)),
        }
      }),
      extensions: (manifest?.extensions ?? []).map((extension) => ({
        ...extension,
        inLibrary: library.has(extension.id),
      })),
    }
  }

  /** Uma passada pelo ZIP: dados dos perfis escolhidos, cookies e extensões que faltam. */
  private async extract(
    pkg: OpenPackage,
    selected: PackageManifest['profiles'],
    job: JobContext,
  ): Promise<{ staging: string; cookies: Map<string, BrowserCookie[]>; extensions: string[] }> {
    const wanted = new Set(selected.map((entry) => entry.key))
    const library = new Set(this.deps.repos.extensions.list().map((extension) => extension.id))
    const needed = new Set(
      selected.flatMap((entry) => pkg.profiles.get(entry.key)!.extensionIds).filter((id) => !library.has(id)),
    )
    const staging = this.deps.files.importStaging(pkg.token)
    const extensionsDir = path.join(this.deps.tempDir, pkg.token, 'extensions')
    const cookies = new Map<string, BrowserCookie[]>()
    const extensions = new Set<string>()
    const total = selected.reduce((sum, entry) => sum + entry.dataBytes, 0)
    const budget = byteBudget(LIMITS.transferMaxBytes, invalid)
    let extracted = 0
    const zipfile = await openZipFile(pkg.contentFile!)
    try {
      await forEachEntry(
        zipfile,
        async ({ entry, segments, directory }) => {
          if (directory) return
          const [top, key, kind, ...rest] = segments
          if (top === 'profiles' && key && wanted.has(key)) {
            if (kind === 'data' && rest.length > 0) {
              const root = path.join(staging, key)
              const destination = path.join(root, ...rest)
              if (!destination.startsWith(root + path.sep))
                throw invalid(`Caminho inválido: ${entry.fileName}`)
              await extractEntry(
                zipfile,
                entry,
                destination,
                (count) => {
                  budget(count)
                  extracted += count
                  job.progress('extracting', Math.min(extracted, total), total, null)
                },
                invalid,
              )
            } else if (kind === 'cookies.json' && rest.length === 0) {
              const list = parseJson(
                await readEntryBuffer(zipfile, entry, LIMITS.transferJsonMaxBytes, invalid),
                cookieListSchema,
                'cookies.json',
              )
              cookies.set(
                key,
                list.filter((cookie) => validateCookie(cookie) === null),
              )
            }
          } else if (top === 'extensions' && key && needed.has(key) && segments.length >= 3) {
            const root = path.join(extensionsDir, key)
            const destination = path.join(root, ...segments.slice(2))
            if (!destination.startsWith(root + path.sep)) throw invalid(`Caminho inválido: ${entry.fileName}`)
            await extractEntry(zipfile, entry, destination, budget, invalid)
            extensions.add(key)
          }
        },
        { maxEntries: LIMITS.transferMaxEntries, invalid, signal: job.signal },
      )
    } finally {
      zipfile.close()
    }
    return { staging, cookies, extensions: [...extensions].map((id) => path.join(extensionsDir, id)) }
  }

  private async installExtensions(directories: readonly string[]): Promise<number> {
    let installed = 0
    for (const directory of directories) {
      try {
        await this.deps.extensions.importFolder(directory)
        installed++
      } catch (error) {
        // O perfil entra sem ela; a prévia já avisou quando faltar.
        this.deps.logger.warn('Extensão do pacote não pôde ser instalada', path.basename(directory), error)
      }
    }
    return installed
  }

  private createProfiles(
    pkg: OpenPackage,
    selected: PackageManifest['profiles'],
    extracted: { staging: string; cookies: Map<string, BrowserCookie[]> },
    extensionsInstalled: number,
    job: JobContext,
  ): TransferImportResult {
    const result: TransferImportResult = {
      createdIds: [],
      proxiesCreated: 0,
      groupsCreated: 0,
      tagsCreated: 0,
      extensionsInstalled,
      cookies: 0,
      failed: [],
    }
    const available = new Set(this.deps.repos.extensions.list().map((extension) => extension.id))
    const now = this.deps.now()
    for (const [index, entry] of selected.entries()) {
      job.signal.throwIfAborted()
      job.progress('profiles', index, selected.length, entry.name)
      const data = pkg.profiles.get(entry.key)!
      let createdId: string | null = null
      try {
        const groupId = data.group ? this.groupFor(data.group, result) : null
        const tagIds = [...new Set(data.tags.map((name) => this.tagFor(name, result)))]
        const proxyId = data.proxy ? this.proxyFor(data.proxy, result) : null
        const profile = this.deps.profiles.create({
          name: data.name,
          // Pacotes anteriores aos vários navegadores vieram todos do Brave.
          browser: data.browser ?? 'brave',
          os: data.os,
          groupId,
          proxyId,
          tagIds,
          color: data.color,
          notes: data.notes,
          launchOptions: data.launchOptions,
          extensionIds: data.extensionIds.filter((id) => available.has(id)),
          fingerprint: data.fingerprint,
        })
        createdId = profile.id
        const urls = data.lastUrls.filter(isWebUrl).slice(0, 100)
        if (urls.length > 0) this.deps.sessions.saveUrls(profile.id, urls)
        const source = path.join(extracted.staging, entry.key)
        if (fs.existsSync(source)) {
          sanitizeImportedProfile(source)
          this.deps.files.adopt(source, profile.id)
        }
        const cookies = extracted.cookies.get(entry.key) ?? []
        if (cookies.length > 0) {
          this.deps.repos.pendingCookies.add(profile.id, cookies, now)
          result.cookies += cookies.length
        }
        result.createdIds.push(profile.id)
      } catch (error) {
        if (createdId) this.rollback(createdId)
        result.failed.push({ name: entry.name, error: payload(error) })
      }
    }
    job.progress('profiles', selected.length, selected.length, null)
    return result
  }

  private rollback(id: string): void {
    try {
      const directory = this.deps.files.directory(id)
      if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 })
      this.deps.repos.profiles.deleteMany([id])
      this.deps.emit('profiles.changed', { upserted: [], removedIds: [id] })
    } catch (error) {
      this.deps.logger.error('Falha ao desfazer o perfil importado pela metade', error)
    }
  }

  private groupFor(name: string, result: TransferImportResult): string {
    const existing = this.deps.repos.groups.findByName(name)
    if (existing) return existing.id
    result.groupsCreated++
    return this.deps.groups.create({ name, color: DEFAULT_COLOR }).id
  }

  private tagFor(name: string, result: TransferImportResult): string {
    const existing = this.deps.repos.tags.findByName(name)
    if (existing) return existing.id
    result.tagsCreated++
    return this.deps.tags.create({ name, color: DEFAULT_COLOR }).id
  }

  /** Mesmo tipo, host, porta e usuário = o mesmo proxy (a senha guardada não é trocada). */
  private proxyFor(proxy: PackageProxy, result: TransferImportResult): string {
    const existing = this.deps.repos.proxies.findByEndpoint({
      type: proxy.type,
      host: proxy.host.toLowerCase(),
      port: proxy.port,
      username: proxy.username,
    })
    if (existing) return existing.id
    const created = this.deps.proxies.create(
      proxyCreateSchema.parse({
        name: proxy.name ?? '',
        type: proxy.type,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password ?? '',
        changeIpUrl: proxy.changeIpUrl ?? '',
        notes: '',
      }),
    )
    result.proxiesCreated++
    return created.id
  }
}
