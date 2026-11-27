import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, type Container } from '@main/container'
import { silentLogger } from '@main/logger'
import { ensureBaseDirs, resolveAppPaths } from '@main/paths'
import { createTestSecretBox } from '@main/security/secrets'
import { FACET_EXTENSION_ID } from '@shared/facet-extension'
import type { EmitFn } from '@shared/ipc/events'
import { AppError } from '@shared/ipc/result'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import {
  fakeWebStore,
  makeCrx3,
  makeKey,
  makeZip,
  writeExtension,
  type FakeWebStore,
} from '../helpers/extension-fixtures'

const MV3 = { manifest_version: 3, name: 'Gerenciador', version: '1.0.0', permissions: ['storage'] }

describe('serviço de extensões (SQLite + pastas reais)', () => {
  let root: string
  let directory: string
  let app: Container
  let emit: ReturnType<typeof vi.fn<EmitFn>>
  let web: FakeWebStore

  const make = (): Container => {
    const paths = resolveAppPaths(directory)
    ensureBaseDirs(paths)
    emit = vi.fn<EmitFn>()
    return createContainer({
      paths,
      migrationsFolder: path.resolve('drizzle'),
      emit,
      logger: silentLogger,
      hostTimezone: 'America/Sao_Paulo',
      secrets: createTestSecretBox(),
      network: { webStoreUrl: web.url },
    })
  }
  const create = (name: string, extensionIds?: string[]) =>
    app.services.profiles.create({
      name,
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
      ...(extensionIds ? { extensionIds } : {}),
    })
  const folder = (name: string, manifest: Record<string, unknown> = MV3) =>
    writeExtension(fs.mkdtempSync(path.join(root, `${name}-`)), manifest, { 'sw.js': '' })
  const zipFile = (name: string, manifest: Record<string, unknown>) => {
    const file = path.join(fs.mkdtempSync(path.join(root, `${name}-`)), `${name}.zip`)
    fs.writeFileSync(file, makeZip([{ name: 'manifest.json', data: JSON.stringify(manifest) }]))
    return file
  }
  const versionDirs = (id: string): string[] => {
    const parent = path.join(app.extensionStore.root, id)
    return fs.existsSync(parent) ? fs.readdirSync(parent) : []
  }

  beforeAll(async () => {
    fs.mkdirSync(path.resolve('.tmp-tests'), { recursive: true })
    root = fs.mkdtempSync(path.resolve('.tmp-tests', 'ext-service-'))
    web = await fakeWebStore()
  })
  afterAll(async () => {
    await web.close()
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(root, 'app-'))
    app = make()
  })
  afterEach(async () => {
    await app.close()
  })

  it('importa pasta e ZIP, emite o evento e guarda os arquivos com a key no manifest', async () => {
    const result = await app.services.extensions.importFolder(folder('pasta'))
    expect(result).toMatchObject({ status: 'added', previousVersion: null })
    expect(result.extension).toMatchObject({
      name: 'Gerenciador',
      source: 'folder',
      hasStorage: true,
      isDefault: false,
    })
    expect(emit).toHaveBeenCalledWith('extensions.changed', { upserted: [result.extension], removedIds: [] })
    const [dirName] = versionDirs(result.extension.id)
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(app.extensionStore.directory(result.extension.id, dirName!), 'manifest.json'),
        'utf8',
      ),
    ) as { key?: string }
    expect(manifest.key).toBeTruthy()
    // sem key própria, cada importação da mesma pasta é uma extensão nova (use "Substituir" para atualizar)
    const again = await app.services.extensions.importFolder(folder('pasta'))
    expect(again.extension.id).not.toBe(result.extension.id)
    expect(app.services.extensions.list()).toHaveLength(2)
  })

  it('reimportar a mesma extensão (mesma key) atualiza no lugar e apaga a pasta antiga', async () => {
    const key = makeKey()
    const first = await app.services.extensions.importArchive(zipFile('v1', { ...MV3, key: key.key }))
    expect(first.extension.id).toBe(key.id)
    const profile = create('Usa a extensão', [key.id])
    app.services.extensions.setDefault([key.id], true)
    const second = await app.services.extensions.importArchive(
      zipFile('v2', { ...MV3, key: key.key, version: '1.1.0' }),
    )
    expect(second).toMatchObject({ status: 'updated', previousVersion: '1.0.0' })
    expect(second.extension).toMatchObject({ version: '1.1.0', isDefault: true, profileCount: 1 })
    expect(versionDirs(key.id)).toHaveLength(1)
    const third = await app.services.extensions.importArchive(
      zipFile('v3', { ...MV3, key: key.key, version: '1.1.0' }),
    )
    expect(third.status).toBe('reinstalled')
    expect(app.services.profiles.get(profile.id).extensionIds).toEqual([key.id])
  })

  it('a limpeza não apaga a pasta que um perfil aberto (sessão gravada) ainda usa', async () => {
    const key = makeKey()
    await app.services.extensions.importArchive(zipFile('v1', { ...MV3, key: key.key }))
    const [oldDir] = versionDirs(key.id)
    const profile = create('Aberto', [key.id])
    app.sessions.save({
      profileId: profile.id,
      phase: 'running',
      fingerprintSnapshot: null,
      pid: null,
      processStartedAt: null,
      executablePath: 'brave.exe',
      userDataDir: app.files.directory(profile.id),
      cdpPort: null,
      wsEndpoint: null,
      engineVersion: null,
      proxyId: null,
      localProxyPort: null,
      extensionDirs: [`${key.id}/${oldDir}`],
      startedAt: Date.now(),
    })
    await app.services.extensions.importArchive(zipFile('v2', { ...MV3, key: key.key, version: '2.0' }))
    expect(versionDirs(key.id)).toHaveLength(2)
    app.sessions.delete(profile.id)
    expect(app.extensionRuntime.collectGarbage()).toBe(1)
    expect(versionDirs(key.id)).toHaveLength(1)
    expect(versionDirs(key.id)).not.toContain(oldDir)
  })

  it('padrões entram nos perfis novos e na criação em massa; lista explícita e clone são respeitados', async () => {
    const a = await app.services.extensions.importFolder(folder('a', { ...MV3, name: 'Alfa' }))
    const b = await app.services.extensions.importFolder(folder('b', { ...MV3, name: 'Beta' }))
    app.services.extensions.setDefault([a.extension.id], true)
    expect(create('Novo').extensionIds).toEqual([a.extension.id])
    expect(create('Sem nenhuma', []).extensionIds).toEqual([])
    const bulk = app.services.profiles.bulkCreate({
      count: 2,
      namePrefix: 'Lote',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
    })
    expect(bulk.map((profile) => profile.extensionIds)).toEqual([[a.extension.id], [a.extension.id]])
    const source = create('Origem', [b.extension.id])
    expect(app.services.profiles.clone(source.id).extensionIds).toEqual([b.extension.id])
    expect(() => create('Inexistente', ['c'.repeat(32)])).toThrowError(AppError)
  })

  it('liga e desliga em todos os perfis ativos (lixeira fica de fora)', async () => {
    const ext = await app.services.extensions.importFolder(folder('todos'))
    const p1 = create('Um', [])
    const p2 = create('Dois', [])
    const trashed = create('Lixeira', [])
    await app.services.trash.trash([trashed.id])
    expect(app.services.extensions.assign(ext.extension.id, 'allActive', true)).toEqual({
      changed: 2,
      runningIds: [],
    })
    expect(app.services.profiles.get(p1.id).extensionIds).toEqual([ext.extension.id])
    expect(app.services.profiles.get(p2.id).extensionIds).toEqual([ext.extension.id])
    expect(app.services.profiles.get(trashed.id).extensionIds).toEqual([])
    expect(app.services.extensions.assign(ext.extension.id, [p1.id], false).changed).toBe(1)
    expect(app.services.extensions.assign(ext.extension.id, [p1.id], false).changed).toBe(0)
  })

  it('excluir extensão em uso exige confirmação, tira dos perfis e apaga a pasta', async () => {
    const ext = await app.services.extensions.importFolder(folder('excluir'))
    const profile = create('Usa', [ext.extension.id])
    const error = (() => {
      try {
        app.services.extensions.delete([ext.extension.id], false)
      } catch (caught) {
        return caught as AppError
      }
      return null
    })()
    expect(error?.code).toBe('EXTENSION_IN_USE')
    expect(error?.details).toEqual({ profiles: 1 })
    expect(app.services.extensions.delete([ext.extension.id], true)).toEqual({
      count: 1,
      detachedProfiles: 1,
    })
    expect(app.services.profiles.get(profile.id).extensionIds).toEqual([])
    expect(versionDirs(ext.extension.id)).toEqual([])
    expect(emit).toHaveBeenCalledWith('extensions.changed', { upserted: [], removedIds: [ext.extension.id] })
  })

  it('autoconfiguração: JSON normalizado e cifrado, revisão, reaplicar e extensão sem "storage"', async () => {
    const ext = await app.services.extensions.importFolder(folder('config'))
    const profile = create('Perfil', [ext.extension.id])
    const saved = app.services.extensions.setConfig(
      ext.extension.id,
      { area: 'local', mode: 'once', json: '{"tema":"escuro","conta":{"token":"t-123"}}' },
      false,
    )
    expect(saved.config).toMatchObject({ area: 'local', mode: 'once', keys: 2, revision: 1 })
    expect(app.services.extensions.getConfig(ext.extension.id)?.json).toBe(
      JSON.stringify({ tema: 'escuro', conta: { token: 't-123' } }, null, 2),
    )
    app.repos.extensions.markConfigResult(profile.id, ext.extension.id, { revision: 1, at: 5 })
    expect(app.services.extensions.reapplyConfig(profile.id, [ext.extension.id])[0]).toMatchObject({
      configRevision: null,
      configAppliedAt: null,
    })
    expect(app.services.extensions.setConfig(ext.extension.id, null, false).config).toBeNull()
    const withoutStorage = await app.services.extensions.importFolder(
      folder('sem-storage', { ...MV3, name: 'Sem storage', permissions: [] }),
    )
    expect(() =>
      app.services.extensions.setConfig(
        withoutStorage.extension.id,
        { area: 'local', mode: 'once', json: '{"a":1}' },
        false,
      ),
    ).toThrowError(/storage/)
    await expect(
      app.services.extensions.captureConfig(ext.extension.id, profile.id, 'local'),
    ).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'profileNotRunning' } })
  })

  it('Chrome Web Store: instala pelo link e atualiza pelo menu', async () => {
    const developer = makeKey()
    const crx = (version: string) =>
      makeCrx3(
        makeZip([{ name: 'manifest.json', data: JSON.stringify({ ...MV3, name: 'Da loja', version }) }]),
        developer,
      )
    web.packages.set(developer.id, crx('3.0'))
    const added = await app.services.extensions.importWebStore(
      `https://chromewebstore.google.com/detail/da-loja/${developer.id}`,
    )
    expect(added.extension).toMatchObject({ id: developer.id, source: 'webstore', version: '3.0' })
    web.packages.set(developer.id, crx('3.1'))
    expect(await app.services.extensions.refresh(developer.id)).toMatchObject({
      status: 'updated',
      previousVersion: '3.0',
    })
    const local = await app.services.extensions.importFolder(folder('local'))
    await expect(app.services.extensions.refresh(local.extension.id)).rejects.toMatchObject({
      details: { reason: 'notWebStore' },
    })
  })

  it('abrir um perfil com a pasta da extensão apagada falha antes de iniciar o Brave', async () => {
    const ext = await app.services.extensions.importFolder(folder('sumiu'))
    const profile = create('Sem arquivos', [ext.extension.id])
    fs.rmSync(path.join(app.extensionStore.root, ext.extension.id), { recursive: true, force: true })
    // sem sondar o navegador de verdade: o erro precisa vir antes do spawn
    const engine = app.browsers.get(app.services.profiles.get(profile.id).browser)
    vi.spyOn(engine, 'detect').mockResolvedValue({
      ...engine.info(),
      available: true,
      executablePath: 'chrome.exe',
      source: 'bundled',
      product: 'Chrome/158.0.8127.36',
      userAgent: '',
      error: null,
    })
    const launch = vi.spyOn(engine, 'launch')
    const result = await app.services.profiles.start([profile.id])
    expect(result.failed[0]?.error).toMatchObject({
      code: 'EXTENSION_UNAVAILABLE',
      details: { reason: 'missingFiles', names: ['Gerenciador'] },
    })
    expect(launch).not.toHaveBeenCalled()
  })

  describe('extensão Facet integrada', () => {
    const bundled = path.resolve('resources/facet-extension')
    const bundledVersion = (
      JSON.parse(fs.readFileSync(path.join(bundled, 'manifest.json'), 'utf8')) as { version: string }
    ).version
    /** Reabre o app com a pasta da Facet (a inicialização instala ou atualiza a extensão). */
    const restartWithFacet = async (directoryOfBundle = bundled): Promise<void> => {
      await app.close()
      const paths = resolveAppPaths(directory)
      emit = vi.fn<EmitFn>()
      app = createContainer({
        paths,
        migrationsFolder: path.resolve('drizzle'),
        emit,
        logger: silentLogger,
        hostTimezone: 'America/Sao_Paulo',
        secrets: createTestSecretBox(),
        network: { webStoreUrl: web.url },
        bundledExtensionDir: directoryOfBundle,
        detectBrowsers: 'default',
      })
      // sem sondar o navegador (a inicialização só precisa instalar a extensão)
      const engine = app.browsers.get(app.services.settings.get().defaultBrowser)
      vi.spyOn(engine, 'detect').mockResolvedValue({ ...engine.info(), error: 'teste' })
      await app.initialize()
    }
    const facet = () => app.services.extensions.list().find((item) => item.id === FACET_EXTENSION_ID)
    const usesFacet = (id: string) => app.services.profiles.get(id).extensionIds.includes(FACET_EXTENSION_ID)
    /** Cópia da pasta da Facet com outra versão no manifest (simula uma atualização do app). */
    const bundleVersion = (version: string): string => {
      const copy = fs.mkdtempSync(path.join(root, 'facet-'))
      fs.cpSync(bundled, copy, { recursive: true })
      const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8')) as Record<
        string,
        unknown
      >
      fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify({ ...manifest, version }))
      return copy
    }

    it('na 1ª abertura do app vira padrão e entra nos perfis que já existem (lixeira fica de fora)', async () => {
      const first = create('Antigo 1')
      const second = create('Antigo 2')
      const trashed = create('Na lixeira')
      await app.services.trash.trash([trashed.id])
      await restartWithFacet()
      expect(facet()).toMatchObject({
        name: 'Facet',
        source: 'builtin',
        isDefault: true,
        applyMode: 'always',
        hasStorage: true,
        profileCount: 2,
      })
      // descrição traduzida do manifest (_locales/pt_BR) e ícone embutido
      expect(facet()?.description).toMatch(/Bloqueia anúncios/)
      expect(facet()?.icon).toMatch(/^data:image\/png;base64,/)
      expect(usesFacet(first.id)).toBe(true)
      expect(usesFacet(second.id)).toBe(true)
      expect(usesFacet(trashed.id)).toBe(false)
      // perfis novos já vêm com ela
      expect(usesFacet(create('Novo').id)).toBe(true)
    })

    it('depois da 1ª instalação, desmarcar o padrão e tirar de um perfil vale nos reinícios e nas atualizações', async () => {
      const kept = create('Fica')
      const removed = create('Sai')
      await restartWithFacet()
      app.services.extensions.setPreferences(FACET_EXTENSION_ID, 'once', false)
      app.services.extensions.assign(FACET_EXTENSION_ID, [removed.id], false)
      const before = versionDirs(FACET_EXTENSION_ID)
      await restartWithFacet()
      expect(facet()).toMatchObject({ isDefault: false, applyMode: 'once', version: bundledVersion })
      expect(versionDirs(FACET_EXTENSION_ID)).toEqual(before)
      // nova versão do app: troca os arquivos e mantém as escolhas
      await restartWithFacet(bundleVersion('9.0.1'))
      expect(facet()).toMatchObject({
        version: '9.0.1',
        isDefault: false,
        applyMode: 'once',
        source: 'builtin',
      })
      expect(usesFacet(kept.id)).toBe(true)
      expect(usesFacet(removed.id)).toBe(false)
      expect(usesFacet(create('Novo').id)).toBe(false)
      // a pasta da versão anterior sai (nenhum perfil aberto a usa)
      const after = versionDirs(FACET_EXTENSION_ID)
      expect(after).toHaveLength(1)
      expect(after).not.toEqual(before)
    })

    it('reinstala sozinha quando a pasta dela some', async () => {
      await restartWithFacet()
      fs.rmSync(path.join(app.extensionStore.root, FACET_EXTENSION_ID), { recursive: true, force: true })
      await restartWithFacet()
      const row = app.repos.extensions.row(FACET_EXTENSION_ID)!
      expect(app.extensionStore.resolveForLaunch([row])).toHaveLength(1)
    })

    it('não é excluída nem substituída, e uma cópia da pasta não toma o lugar dela', async () => {
      const profile = create('Com Facet')
      await restartWithFacet()
      expect(() => app.services.extensions.delete([FACET_EXTENSION_ID], true)).toThrow(
        expect.objectContaining({ code: 'CONFLICT', details: { reason: 'builtinExtension' } }),
      )
      await expect(
        app.services.extensions.replace(FACET_EXTENSION_ID, 'folder', bundled),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'builtinExtension' },
      })
      // a chave pública está no manifest: importar a pasta daria o mesmo ID
      await expect(app.services.extensions.importFolder(bundleVersion('9.9.9'))).rejects.toMatchObject({
        code: 'CONFLICT',
        details: { reason: 'builtinExtension' },
      })
      expect(facet()).toMatchObject({ source: 'builtin', version: bundledVersion })
      expect(versionDirs(FACET_EXTENSION_ID)).toHaveLength(1)
      // desligar continua possível: por perfil e como padrão
      app.services.extensions.assign(FACET_EXTENSION_ID, [profile.id], false)
      app.services.extensions.setDefault([FACET_EXTENSION_ID], false)
      expect(facet()).toMatchObject({ isDefault: false, profileCount: 0 })
    })

    it('pasta da Facet ausente não impede o app de iniciar', async () => {
      await restartWithFacet(path.join(root, 'nao-existe'))
      expect(facet()).toBeUndefined()
      expect(create('Sem Facet').extensionIds).toEqual([])
    })
  })
})
