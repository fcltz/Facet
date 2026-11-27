import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { APP_NAME } from '@shared/constants'
import { isBuiltinExtension } from '@shared/facet-extension'
import { AppError } from '@shared/ipc/result'
import type { BrowserCookie } from '@shared/schemas/cookies'
import type { Profile } from '@shared/schemas/profile'
import {
  PACKAGE_FORMAT,
  type EncryptedManifest,
  type ExportOptions,
  type KdfParams,
  type PackageManifest,
  type PackageProfile,
  type TransferExportResult,
} from '@shared/schemas/transfer'
import { DEFAULT_KDF, deriveKey, EncryptStream, newKdfParams, verifierFor } from '../archive/crypto'
import { ZipWriter } from '../archive/zip-writer'
import type { ProfileFiles } from '../browser/profile-files'
import type { ExtensionStore } from '../extensions/store'
import type { JobContext } from '../jobs'
import type { Repositories } from '../repositories/types'
import type { SessionRepository } from '../repositories/sqlite/sessions'
import type { ProfileRuntime } from '../runtime/types'
import type { CookieService } from '../services/cookie.service'
import { profileDataFilter, sanitizeLocalState } from './profile-data'

export interface ExportDeps {
  repos: Repositories
  sessions: Pick<SessionRepository, 'getUrls'>
  runtime: ProfileRuntime
  cookies: Pick<CookieService, 'read'>
  files: ProfileFiles
  extensionStore: Pick<ExtensionStore, 'directory'>
  /** `Browser.getVersion().product` do Brave instalado (avisa importações num Brave mais antigo). */
  engineProduct: () => string | null
  appVersion: string
  now: () => number
  tempDir: string
  /** Testes usam um custo menor; o app usa o padrão. */
  kdf?: Omit<KdfParams, 'salt'>
}

function packageProfile(profile: Profile, deps: ExportDeps, options: ExportOptions): PackageProfile {
  const { repos } = deps
  let proxy: PackageProfile['proxy'] = null
  if (options.proxy && profile.proxyId) {
    const summary = repos.proxies.get(profile.proxyId)
    if (summary) {
      const secrets = options.proxySecrets ? repos.proxies.secrets(profile.proxyId) : null
      proxy = {
        type: summary.type,
        host: summary.host,
        port: summary.port,
        username: summary.username,
        name: summary.name,
        password: secrets?.password ?? null,
        changeIpUrl: secrets?.changeIpUrl ?? null,
      }
    }
  }
  return {
    name: profile.name,
    notes: profile.notes,
    color: profile.color,
    browser: profile.browser,
    os: profile.os,
    fingerprint: profile.fingerprint,
    launchOptions: profile.launchOptions,
    lastUrls: deps.sessions.getUrls(profile.id),
    group: profile.groupId ? (repos.groups.get(profile.groupId)?.name ?? null) : null,
    tags: profile.tagIds.flatMap((id) => {
      const name = repos.tags.get(id)?.name
      return name ? [name] : []
    }),
    extensionIds: [...profile.extensionIds],
    proxy,
  }
}

/**
 * Monta o pacote de perfis (.zip). Cada perfil é fechado (se aberto) e fica travado até os
 * arquivos dele terem sido lidos para o ZIP. Com senha, o ZIP de conteúdo é cifrado e vai
 * como `payload.bin` dentro de um ZIP externo com o manifesto da cifragem.
 */
export async function exportProfiles(
  deps: ExportDeps,
  ids: readonly string[],
  options: ExportOptions,
  file: string,
  job: JobContext,
): Promise<TransferExportResult> {
  const profiles = [...new Set(ids)]
    .map((id) => deps.repos.profiles.get(id))
    .filter((profile): profile is Profile => profile !== null && profile.deletedAt === null)
  if (profiles.length === 0) throw new AppError('NOT_FOUND', 'Nenhum perfil para exportar')
  const runStopped =
    deps.runtime.runStopped?.bind(deps.runtime) ??
    (<T>(_id: string, action: () => Promise<T> | T): Promise<T> => Promise.resolve(action()))
  const encrypted = options.password !== null
  fs.mkdirSync(deps.tempDir, { recursive: true })
  const contentFile = encrypted ? path.join(deps.tempDir, `${randomUUID()}.zip`) : file
  const writer = new ZipWriter(contentFile, job.signal)
  let outer: ZipWriter | null = null
  const filter = profileDataFilter('portable')
  const manifestProfiles: PackageManifest['profiles'] = []
  let cookiesTotal = 0
  let stopped = 0
  try {
    for (const [index, profile] of profiles.entries()) {
      job.signal.throwIfAborted()
      job.progress('profiles', index, profiles.length, profile.name)
      if (deps.runtime.isActive(profile.id)) stopped++
      const key = `p${index + 1}`
      const prefix = `profiles/${key}`
      // Capture a sessão viva antes de fechar: o Brave pode descartar cookies de sessão ao sair.
      const cookies: BrowserCookie[] = options.cookies ? await deps.cookies.read(profile.id, job.signal) : []
      const entry = await runStopped(profile.id, async () => {
        let dataBytes = 0
        let hasData = false
        const directory = deps.files.directory(profile.id)
        if (options.browserData && fs.existsSync(directory)) {
          hasData = true
          const added = writer.addDirectory(
            directory,
            `${prefix}/data`,
            (segments, isDirectory) =>
              !(segments.length === 1 && segments[0] === 'Local State') && filter(segments, isDirectory),
          )
          dataBytes = added.bytes
          const localState = path.join(directory, 'Local State')
          const clean = fs.existsSync(localState) ? sanitizeLocalState(fs.readFileSync(localState)) : null
          if (clean) {
            writer.addBuffer(clean, `${prefix}/data/Local State`)
            dataBytes += clean.length
          }
          // A pasta só pode mudar (perfil aberto de novo) depois de lida para o ZIP.
          await added.done
        }
        writer.addBuffer(
          JSON.stringify(packageProfile(profile, deps, options), null, 2),
          `${prefix}/profile.json`,
        )
        if (options.cookies) writer.addBuffer(JSON.stringify(cookies), `${prefix}/cookies.json`)
        return { key, name: profile.name, os: profile.os, data: hasData, dataBytes, cookies: cookies.length }
      })
      cookiesTotal += entry.cookies
      manifestProfiles.push(entry)
    }

    const extensions: PackageManifest['extensions'] = []
    if (options.extensions) {
      job.progress('extensions', profiles.length, profiles.length, null)
      for (const id of [...new Set(profiles.flatMap((profile) => profile.extensionIds))]) {
        const row = deps.repos.extensions.row(id)
        // A Facet vem com todo Facet: o perfil leva só o ID, e a importação usa a do app.
        if (!row || isBuiltinExtension(row)) continue
        const directory = deps.extensionStore.directory(row.id, row.dirName)
        if (!fs.existsSync(directory)) continue
        writer.addDirectory(directory, `extensions/${row.id}`, () => true)
        extensions.push({ id: row.id, name: row.name, version: row.version })
      }
    }
    const now = deps.now()
    const manifest: PackageManifest = {
      format: PACKAGE_FORMAT,
      kind: 'facet-profiles',
      app: { name: APP_NAME, version: deps.appVersion },
      createdAt: now,
      engine: deps.engineProduct(),
      profiles: manifestProfiles,
      extensions,
    }
    writer.addBuffer(JSON.stringify(manifest, null, 2), 'facet-export.json')
    job.progress('finishing', profiles.length, profiles.length, null)
    let bytes = await writer.finish()

    if (encrypted) {
      job.progress('encrypting', profiles.length, profiles.length, null)
      const kdf = newKdfParams(deps.kdf ?? DEFAULT_KDF)
      const key = await deriveKey(options.password!, kdf)
      const header: EncryptedManifest = {
        format: PACKAGE_FORMAT,
        kind: 'facet-profiles-encrypted',
        app: { name: APP_NAME, version: deps.appVersion },
        createdAt: now,
        kdf,
        verifier: verifierFor(key),
      }
      outer = new ZipWriter(file, job.signal)
      outer.addBuffer(JSON.stringify(header, null, 2), 'facet-export.json')
      const source = fs.createReadStream(contentFile)
      const cipher = new EncryptStream(key)
      source.once('error', (error) => cipher.destroy(error))
      outer.addStream(source.pipe(cipher), 'payload.bin')
      bytes = await outer.finish()
    }
    return { file: path.basename(file), profiles: profiles.length, bytes, cookies: cookiesTotal, stopped }
  } catch (error) {
    await writer.abort()
    await outer?.abort()
    if (job.signal.aborted) throw job.signal.reason
    throw error
  } finally {
    if (encrypted) fs.rmSync(contentFile, { force: true })
  }
}
