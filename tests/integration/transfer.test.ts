import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { createServer, type Server } from 'node:http'
import path, { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import type { ExportOptions } from '@shared/schemas/transfer'
import { AppError } from '@shared/ipc/result'
import { forEachEntry, openZipFile, readEntryBuffer } from '@main/archive/zip-reader'
import { CdpClient } from '@main/browser/cdp/client'
import { createContainer, type Container } from '@main/container'
import { silentLogger } from '@main/logger'
import { testBrowserDeps, useTestBrowser } from '../helpers/browser'
import { ensureBaseDirs, resolveAppPaths } from '@main/paths'
import { createTestSecretBox } from '@main/security/secrets'
import { writeExtension } from '../helpers/extension-fixtures'

const ALL: ExportOptions = {
  browserData: true,
  cookies: true,
  extensions: true,
  proxy: true,
  proxySecrets: false,
  password: null,
}

describe.skipIf(process.env.SKIP_BRAVE_TESTS === '1')('Pacote de perfis no Brave real', () => {
  let root: string
  let server: Server
  let url: string
  const requests: { path: string; cookie: string }[] = []
  const apps: Container[] = []

  async function make(name: string): Promise<Container> {
    const paths = resolveAppPaths(path.join(root, name))
    ensureBaseDirs(paths)
    const app = useTestBrowser(
      createContainer({
        ...testBrowserDeps,
        paths,
        migrationsFolder: resolve('drizzle'),
        emit: vi.fn(),
        logger: silentLogger,
        hostTimezone: 'America/Sao_Paulo',
        hostLanguages: ['pt-BR', 'pt'],
        secrets: createTestSecretBox(),
        appVersion: '0.0.0-test',
      }),
    )
    await app.initialize()
    apps.push(app)
    return app
  }

  async function pageValue(app: Container, id: string, expression: string): Promise<unknown> {
    const client = await CdpClient.connect(app.sessions.get(id)!.wsEndpoint!)
    try {
      let targetId = ''
      await vi.waitFor(
        async () => {
          const target = (await client.send('Target.getTargets', {})).targetInfos.find(
            (info) => info.type === 'page' && info.url.includes('/set'),
          )
          expect(target).toBeDefined()
          targetId = target!.targetId
        },
        { timeout: 15000 },
      )
      const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true })
      let value: unknown
      await vi.waitFor(
        async () => {
          const result = await client.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
          value = result.result.value
          expect(value).not.toBeUndefined()
        },
        { timeout: 10000 },
      )
      return value
    } finally {
      client.close()
    }
  }

  beforeAll(async () => {
    fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
    root = fs.mkdtempSync(resolve('.tmp-tests', 'transfer-'))
    server = createServer((request, response) => {
      requests.push({ path: request.url ?? '/', cookie: request.headers.cookie ?? '' })
      response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
      response.end(`<!doctype html><script>
        window.before = localStorage.getItem('k') ?? 'vazio';
        localStorage.setItem('k', 'valor-salvo');
        document.cookie = 'site=1; max-age=86400; path=/';
      </script>`)
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Porta indisponível')
    url = `http://127.0.0.1:${address.port}`
  }, 60000)

  afterAll(async () => {
    for (const app of apps) {
      await app.runtime.stopAll().catch(() => undefined)
      await app.close()
    }
    await new Promise<void>((done) => server?.close(() => done()))
    if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }, 60000)

  it('exporta perfis com dados, cookies e extensão e importa em outra instalação', async () => {
    const source = await make('origem')
    const extensionDir = writeExtension(path.join(root, 'ext'), {
      manifest_version: 3,
      name: 'Transfer Ext',
      version: '1.2.3',
    })
    const extension = (await source.services.extensions.importFolder(extensionDir)).extension
    const group = source.services.groups.create({ name: 'Clientes', color: '#5B5BF7' })
    const tag = source.services.tags.create({ name: 'vip', color: '#22C55E' })
    const proxy = source.services.proxies.create({
      name: 'Proxy pacote',
      type: 'socks5',
      host: 'proxy.example',
      port: 1080,
      username: 'user',
      password: 'segredo',
      changeIpUrl: '',
      notes: '',
    })
    const launchOptions = { ...structuredClone(DEFAULT_LAUNCH_OPTIONS), startupUrls: [`${url}/set`] }
    const withData = source.services.profiles.create({
      name: 'Com dados',
      os: 'windows',
      groupId: group.id,
      proxyId: null,
      tagIds: [tag.id],
      color: '#3B82F6',
      notes: 'nota',
      launchOptions,
      extensionIds: [extension.id],
    })
    const withProxy = source.services.profiles.create({
      name: 'Com proxy',
      os: 'windows',
      groupId: null,
      proxyId: proxy.id,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
      extensionIds: [],
    })

    await source.runtime.start(withData.id)
    expect(await pageValue(source, withData.id, 'window.before')).toBe('vazio')
    await source.runtime.stop(withData.id)
    await source.services.cookies.import(withData.id, [
      {
        name: 'pend',
        value: '1',
        domain: '127.0.0.1',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true,
        secure: false,
        sameSite: null,
        partitionKey: null,
      },
    ])

    await source.runtime.start(withData.id)
    expect(
      await source.services.cookies.import(withData.id, [
        {
          name: 'session',
          value: 'live',
          domain: '127.0.0.1',
          path: '/',
          expires: null,
          httpOnly: true,
          secure: false,
          sameSite: null,
          partitionKey: null,
        },
      ]),
    ).toMatchObject({ applied: 'now', imported: 1, failed: [] })

    const file = path.join(root, 'perfis.zip')
    const exported = await source.services.transfer.export(
      randomUUID(),
      [withData.id, withProxy.id],
      ALL,
      file,
    )
    expect(exported).toMatchObject({ file: 'perfis.zip', profiles: 2, stopped: 1 })
    expect(exported.cookies).toBeGreaterThanOrEqual(3)

    // Nada cifrado com a chave do usuário do Windows vai no pacote portátil.
    const names: string[] = []
    let localState = ''
    const zipfile = await openZipFile(file)
    await forEachEntry(
      zipfile,
      async ({ entry, segments }) => {
        names.push(segments.join('/'))
        if (segments.join('/') === 'profiles/p1/data/Local State')
          localState = (
            await readEntryBuffer(zipfile, entry, 1e6, (m) => new AppError('TRANSFER_INVALID', m))
          ).toString()
      },
      { maxEntries: 100000, invalid: (m) => new AppError('TRANSFER_INVALID', m) },
    )
    zipfile.close()
    expect(names).toContain('facet-export.json')
    expect(names).toContain('profiles/p1/cookies.json')
    expect(names).toContain(`extensions/${extension.id}/manifest.json`)
    expect(names.some((name) => name.startsWith('profiles/p1/data/Default/Local Storage/'))).toBe(true)
    expect(
      names.some((name) => /\/Network\/Cookies$|\/Login Data$|\/Cache\/|BrowserMetrics/.test(name)),
    ).toBe(false)
    expect(JSON.parse(localState).os_crypt).toBeUndefined()

    const target = await make('destino')
    const preview = await target.services.transfer.open(file)
    expect(preview).toMatchObject({ encrypted: false, locked: false, engineNewer: false })
    expect(preview.extensions).toEqual([
      { id: extension.id, name: 'Transfer Ext', version: '1.2.3', inLibrary: false },
    ])
    expect(preview.profiles.map((profile) => profile.name)).toEqual(['Com dados', 'Com proxy'])
    expect(preview.profiles[1]?.proxy).toEqual({
      type: 'socks5',
      host: 'proxy.example',
      port: 1080,
      hasPassword: false,
    })
    const imported = await target.services.transfer.import(randomUUID(), preview.token, ['p1', 'p2'])
    expect(imported).toMatchObject({
      proxiesCreated: 1,
      groupsCreated: 1,
      tagsCreated: 1,
      extensionsInstalled: 1,
      failed: [],
    })
    expect(imported.createdIds).toHaveLength(2)
    const [dataId, proxyId] = imported.createdIds as [string, string]
    const copy = target.services.profiles.get(dataId)
    expect(copy).toMatchObject({
      name: 'Com dados',
      color: '#3B82F6',
      notes: 'nota',
      extensionIds: [extension.id],
    })
    expect(target.repos.groups.get(copy.groupId!)?.name).toBe('Clientes')
    expect(copy.tagIds.map((id) => target.repos.tags.get(id)?.name)).toEqual(['vip'])
    const importedProxy = target.repos.proxies.get(target.services.profiles.get(proxyId).proxyId!)
    expect(importedProxy).toMatchObject({
      type: 'socks5',
      host: 'proxy.example',
      port: 1080,
      username: 'user',
      hasPassword: false,
    })
    expect(target.services.cookies.status(dataId).pending).toBeGreaterThanOrEqual(3)
    expect(fs.existsSync(path.join(target.files.directory(dataId), 'Default', 'Login Data'))).toBe(false)

    // O perfil importado abre com o localStorage e os cookies da origem já na 1ª requisição.
    const before = requests.length
    await target.runtime.start(dataId)
    expect(await pageValue(target, dataId, 'window.before')).toBe('valor-salvo')
    const first = requests.slice(before).find((request) => request.path === '/set')!
    expect(first.cookie.split('; ').sort()).toEqual(['pend=1', 'session=live', 'site=1'])
    await target.runtime.stop(dataId)
  }, 180000)

  it('pacote com senha: senha errada é recusada e a senha do proxy acompanha', async () => {
    const source = apps[0]!
    const proxyProfile = source.services.profiles
      .list('active')
      .find((profile) => profile.name === 'Com proxy')!
    const file = path.join(root, 'protegido.zip')
    await source.services.transfer.export(
      randomUUID(),
      [proxyProfile.id],
      { ...ALL, proxySecrets: true, password: 'uma senha longa' },
      file,
    )
    const target = await make('protegido')
    const locked = await target.services.transfer.open(file)
    expect(locked).toMatchObject({ encrypted: true, locked: true, profiles: [] })
    await expect(target.services.transfer.unlock(locked.token, 'senha errada')).rejects.toMatchObject({
      code: 'TRANSFER_PASSWORD',
    })
    const preview = await target.services.transfer.unlock(locked.token, 'uma senha longa')
    expect(preview.profiles[0]?.proxy).toMatchObject({ host: 'proxy.example', hasPassword: true })
    const imported = await target.services.transfer.import(randomUUID(), preview.token, ['p1'])
    const proxyId = target.services.profiles.get(imported.createdIds[0]!).proxyId!
    expect(target.repos.proxies.secrets(proxyId)?.password).toBe('segredo')
    await expect(target.services.transfer.unlock(preview.token, 'uma senha longa')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  }, 120000)
})
