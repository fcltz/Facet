import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { parseCrx } from '@main/extensions/crx'
import { extensionIdFromKeyBase64, extensionIdFromPath } from '@main/extensions/ids'
import { ExtensionInstaller } from '@main/extensions/installer'
import { findManifestRoot, readManifest, relaxedJson, removeReservedEntries } from '@main/extensions/manifest'
import { ExtensionStore } from '@main/extensions/store'
import { prodVersionFrom, WebStoreClient } from '@main/extensions/webstore'
import { unpackZip, validateEntryName } from '@main/extensions/zip'
import { silentLogger } from '@main/logger'
import { AppError } from '@shared/ipc/result'
import {
  extensionWarnings,
  hasCriticalWarning,
  permissionWarnings,
  parseExtensionConfig,
  parseWebStoreInput,
} from '@shared/schemas/extension'
import {
  fakeWebStore,
  makeCrx2,
  makeCrx3,
  makeKey,
  makeZip,
  writeExtension,
  zipFolder,
  type FakeWebStore,
} from '../helpers/extension-fixtures'

/** Chave real do uBlock Origin Lite, tirada do CRX baixado da Chrome Web Store. */
const UBOL_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqJE6DLdtfHXfeaGDSKdUuCvvb3pYEpH7jsuYMdExgIqmKRux2dknlJAnYkamBMcirGBfwCFjqE++TAkCs8AcrYLOGRRMt8oa7DXuFWzgtQpkwigI1+dnIuYLzERLQx/O02/p//fHdDQfxWKvySnN+VHdINOHsUD6OcoC5I7CXIBSrateRpRGpFxxR6F4nWvK3aq2j3L6A/qRg+pr0QVqL8p1TOJG+vSh234YHnsO9Dsys+VNbT0k0n8enCm/VsOCMjihgHpmftd1bSfSr8s1IwBuFdaLVQKghyDn1PvhFNBkuAXu+J/z0/o5Nio+/bIz406ECI9Qtkr9kqVboFDtzwIDAQAB'

const MV3 = { manifest_version: 3, name: 'Teste', version: '1.0.0', permissions: ['storage'] }

let root: string
const dirs: string[] = []
function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(root, `${name}-`))
  dirs.push(dir)
  return dir
}

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('Era esperado um erro')
}

function syncError(action: () => unknown): AppError {
  try {
    action()
  } catch (error) {
    if (error instanceof AppError) return error
    throw error
  }
  throw new Error('Era esperado um erro')
}

beforeAll(() => {
  fs.mkdirSync(path.resolve('.tmp-tests'), { recursive: true })
  root = fs.mkdtempSync(path.resolve('.tmp-tests', 'ext-'))
})
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
})

describe('IDs e entrada da Chrome Web Store', () => {
  it('deriva o ID da chave como o Chrome (vetor real da Web Store)', () => {
    expect(extensionIdFromKeyBase64(UBOL_KEY)).toBe('ddkjiahejlhfcafbddmgiahcphecmpfh')
  })

  it('reproduz o ID por caminho do Windows (verificado no Brave 158)', () => {
    // extensão descompactada sem "key" carregada deste caminho; o ID veio do próprio navegador
    const directory = 'C:\\Users\\Public\\Documents\\FacetIdTest\\ext\\B-mv3-nokey-nobg'
    expect(extensionIdFromPath(directory, 'win32')).toBe('ejllfcgjakgfdknioffaembjppoeajna')
    expect(extensionIdFromPath(`c${directory.slice(1)}`, 'win32')).toBe('ejllfcgjakgfdknioffaembjppoeajna')
  })

  it('aceita ID ou link da loja e recusa o resto', () => {
    const id = 'ddkjiahejlhfcafbddmgiahcphecmpfh'
    expect(parseWebStoreInput(id)).toBe(id)
    expect(parseWebStoreInput(` ${id.toUpperCase()} `)).toBe(id)
    expect(parseWebStoreInput(`https://chromewebstore.google.com/detail/ublock-origin-lite/${id}`)).toBe(id)
    expect(parseWebStoreInput(`https://chromewebstore.google.com/detail/${id}?hl=pt-BR`)).toBe(id)
    expect(parseWebStoreInput(`https://chrome.google.com/webstore/detail/nome/${id}`)).toBe(id)
    expect(parseWebStoreInput(`https://example.com/detail/${id}`)).toBeNull()
    expect(parseWebStoreInput('https://chromewebstore.google.com/detail/sem-id')).toBeNull()
    expect(parseWebStoreInput('qualquer coisa')).toBeNull()
    expect(parseWebStoreInput('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz')).toBeNull()
  })

  it('usa a versão do Chromium do Brave como prodversion', () => {
    expect(prodVersionFrom('Chrome/158.0.8127.92')).toBe('158.0.8127.92')
    expect(prodVersionFrom(null)).toMatch(/^\d+\.0\.0\.0$/)
  })

  it('destaca permissões que podem desfazer o proxy e o WebRTC', () => {
    expect(extensionWarnings(['storage', 'proxy', '<all_urls>', 'cookies'])).toEqual([
      'proxy',
      'allSites',
      'cookies',
    ])
    expect(hasCriticalWarning({ permissions: ['privacy'], source: 'folder' })).toBe(true)
    expect(
      hasCriticalWarning({ permissions: ['storage', 'tabs', 'https://*.google.com/*'], source: 'webstore' }),
    ).toBe(false)
    // a Facet, que vem com o app, pede "privacy" só para o pré-carregamento: sem avisos
    const facet = { permissions: ['storage', 'privacy', 'http://*/*'], source: 'builtin' }
    expect(permissionWarnings(facet)).toEqual([])
    expect(hasCriticalWarning(facet)).toBe(false)
    expect(permissionWarnings({ ...facet, source: 'folder' })).toEqual(['privacy', 'allSites'])
  })

  it('valida o JSON da autoconfiguração e a cota do sync', () => {
    expect(parseExtensionConfig('{"a":1}', 'local')).toEqual({ ok: true, values: { a: 1 } })
    expect(parseExtensionConfig('[1]', 'local')).toEqual({ ok: false, error: 'jsonNotObject' })
    expect(parseExtensionConfig('{}', 'local')).toEqual({ ok: false, error: 'jsonEmpty' })
    expect(parseExtensionConfig('{a', 'local')).toEqual({ ok: false, error: 'invalidJson' })
    const big = JSON.stringify({ item: 'x'.repeat(9000) })
    expect(parseExtensionConfig(big, 'local').ok).toBe(true)
    expect(parseExtensionConfig(big, 'sync')).toEqual({ ok: false, error: 'syncQuota' })
  })
})

describe('CRX', () => {
  it('CRX3: devolve o ZIP, o ID oficial e a chave do desenvolvedor (com prova extra da loja)', () => {
    const developer = makeKey()
    const zip = makeZip([{ name: 'manifest.json', data: JSON.stringify(MV3) }])
    const crx = parseCrx(makeCrx3(zip, developer, { extraKey: makeKey() }))
    expect(crx.version).toBe(3)
    expect(crx.id).toBe(developer.id)
    expect(crx.publicKey.equals(developer.publicKey)).toBe(true)
    expect(crx.zip.equals(zip)).toBe(true)
  })

  it('recusa CRX alterado depois de assinado e CRX sem a prova do desenvolvedor', () => {
    const developer = makeKey()
    const zip = makeZip([{ name: 'manifest.json', data: JSON.stringify(MV3) }])
    expect(syncError(() => parseCrx(makeCrx3(zip, developer, { tamper: true }))).message).toMatch(
      /Assinatura do CRX não confere/,
    )
    expect(
      syncError(() =>
        parseCrx(makeCrx3(zip, developer, { withoutDeveloperProof: true, extraKey: makeKey() })),
      ).message,
    ).toMatch(/chave do desenvolvedor/)
    expect(syncError(() => parseCrx(Buffer.from('Cr24\x07\x00\x00\x00', 'latin1'))).code).toBe(
      'EXTENSION_INVALID',
    )
  })

  it('CRX2 (formato antigo) também é conferido', () => {
    const developer = makeKey()
    const zip = makeZip([{ name: 'manifest.json', data: JSON.stringify(MV3) }])
    const crx = parseCrx(makeCrx2(zip, developer))
    expect(crx).toMatchObject({ version: 2, id: developer.id })
  })
})

describe('extração segura do ZIP', () => {
  const limits = { maxEntries: 100, maxTotalBytes: 1024 * 1024 }

  it('extrai pastas e arquivos com o conteúdo certo', async () => {
    const target = tempDir('zip')
    const result = await unpackZip(
      makeZip([
        { name: 'manifest.json', data: '{}' },
        { name: 'js/', directory: true },
        { name: 'js/app.js', data: 'console.log(1)' },
        { name: 'ícones/ç.txt', data: 'utf8' },
      ]),
      target,
      limits,
    )
    expect(result).toEqual({ files: 3, bytes: 2 + 14 + 4 })
    expect(fs.readFileSync(path.join(target, 'js', 'app.js'), 'utf8')).toBe('console.log(1)')
    expect(fs.readFileSync(path.join(target, 'ícones', 'ç.txt'), 'utf8')).toBe('utf8')
  })

  it.each([
    ['caminho para fora da pasta', [{ name: '../fora.txt', data: 'x' }], /inválido/],
    ['caminho absoluto', [{ name: '/abs.txt', data: 'x' }], /inválido/],
    ['nome reservado do Windows', [{ name: 'CON.txt', data: 'x' }], /inválido/],
    ['link simbólico', [{ name: 'link', data: '/etc/passwd', symlink: true }], /Links simbólicos/],
    ['arquivo corrompido', [{ name: 'a.txt', data: 'abc', crc: 1 }], /corrompido/],
    [
      'arquivo repetido (maiúsculas)',
      [
        { name: 'A.txt', data: '1' },
        { name: 'a.txt', data: '2' },
      ],
      /repetido/,
    ],
  ])('recusa %s', async (_label, entries, message) => {
    const error = await rejection(unpackZip(makeZip(entries), tempDir('bad'), limits))
    expect(error.code).toBe('EXTENSION_INVALID')
    expect(error.message).toMatch(message)
  })

  it('para zip bomb e pacotes com arquivos demais', async () => {
    const bomb = makeZip([{ name: 'zeros.bin', data: Buffer.alloc(4 * 1024 * 1024) }])
    expect(bomb.length).toBeLessThan(64 * 1024)
    expect((await rejection(unpackZip(bomb, tempDir('bomb'), limits))).details).toMatchObject({
      reason: 'tooLarge',
    })
    const many = makeZip(Array.from({ length: 120 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })))
    expect((await rejection(unpackZip(many, tempDir('many'), limits))).details).toMatchObject({
      reason: 'tooLarge',
    })
  })

  it('confere nomes também na cópia de pastas', () => {
    expect(validateEntryName('a/b/c.js')).toEqual(['a', 'b', 'c.js'])
    for (const name of ['a/../b', 'a\\b', 'nome.', 'pasta /x', 'aux', 'a:b'])
      expect(syncError(() => validateEntryName(name)).code).toBe('EXTENSION_INVALID')
  })
})

describe('manifest', () => {
  it('lê JSON com BOM, comentários e vírgula sobrando (como o Chrome)', () => {
    expect(relaxedJson('\uFEFF{ // comentário\n "a": [1, 2,], /* bloco */ "b": "x//y", }')).toEqual({
      a: [1, 2],
      b: 'x//y',
    })
  })

  it('resolve __MSG_ do default_locale, junta permissões MV3 e escolhe o ícone mais próximo de 48px', () => {
    const dir = writeExtension(
      tempDir('manifest'),
      {
        manifest_version: 3,
        name: '__MSG_appName__',
        description: '__MSG_appDesc__',
        version: '2.10.0.1',
        default_locale: 'pt_BR',
        permissions: ['storage', 'proxy'],
        host_permissions: ['<all_urls>'],
        icons: { '16': 'i16.png', '48': 'i48.png', '128': 'i128.png' },
      },
      {
        '_locales/pt_BR/messages.json': '{"APPNAME":{"message":"Meu App"},"appDesc":{"message":"Descrição"}}',
      },
    )
    const { info } = readManifest(dir)
    expect(info).toMatchObject({
      name: 'Meu App',
      description: 'Descrição',
      version: '2.10.0.1',
      manifestVersion: 3,
      permissions: ['storage', 'proxy', '<all_urls>'],
      iconPath: 'i48.png',
      key: null,
    })
  })

  it.each([
    [{ ...MV3, manifest_version: 1 }, /manifest_version/],
    [{ ...MV3, version: '1.0.0.0.1' }, /Versão inválida/],
    [{ ...MV3, version: '01.2' }, /Versão inválida/],
    [{ ...MV3, name: '' }, /nome/],
    [{ ...MV3, app: { launch: {} } }, /Aplicativos/],
    [{ ...MV3, theme: {} }, /Temas/],
    [{ ...MV3, key: 'não é base64 de chave' }, /key/],
    [{ ...MV3, default_locale: 'en' }, /_locales/],
  ])('recusa manifest inválido (%#)', (manifest, message) => {
    const dir = writeExtension(tempDir('invalid'), manifest)
    const error = syncError(() => readManifest(dir))
    expect(error.code).toBe('EXTENSION_INVALID')
    expect(error.message).toMatch(message)
  })

  it('acha o manifest numa subpasta única e remove nomes reservados (menos _locales)', () => {
    const dir = tempDir('root')
    writeExtension(path.join(dir, 'minha-extensao'), MV3, {
      '_metadata/verified_contents.json': '[]',
      '_locales/en/messages.json': '{}',
      '__MACOSX/lixo': 'x',
    })
    fs.mkdirSync(path.join(dir, '__MACOSX'))
    const root = findManifestRoot(dir)
    expect(root).toBe(path.join(dir, 'minha-extensao'))
    expect(removeReservedEntries(root).sort()).toEqual(['_metadata', '__MACOSX'].sort())
    expect(fs.existsSync(path.join(root, '_locales'))).toBe(true)
  })
})

describe('instalador', () => {
  let store: ExtensionStore
  let web: FakeWebStore
  let installer: ExtensionInstaller

  beforeAll(async () => {
    web = await fakeWebStore()
    store = new ExtensionStore(tempDir('library'), silentLogger)
    installer = new ExtensionInstaller({
      store,
      webStore: new WebStoreClient({ baseUrl: web.url, prodVersion: () => '158.0.8127.92' }),
    })
  })
  afterAll(async () => {
    await web.close()
  })
  afterEach(() => {
    web.redirectOutside = false
  })

  const installedManifest = (id: string, dirName: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(store.directory(id, dirName), 'manifest.json'), 'utf8')) as Record<
      string,
      unknown
    >

  it('ZIP sem key: gera uma chave, grava no manifest e o ID vem dela', async () => {
    const source = writeExtension(tempDir('src'), MV3, { 'sw.js': '' })
    const pkg = await installer.fromBuffer(zipFolder(source, 'pasta-unica/'), 'zip')
    store.settle(pkg.id, pkg.dirName)
    const manifest = installedManifest(pkg.id, pkg.dirName)
    expect(typeof manifest.key).toBe('string')
    expect(extensionIdFromKeyBase64(manifest.key as string)).toBe(pkg.id)
    expect(pkg).toMatchObject({ source: 'zip', name: 'Teste', version: '1.0.0', permissions: ['storage'] })
    expect(fs.readdirSync(path.join(store.root, '.staging'))).toEqual([])
  })

  it('CRX: o ID é o da chave do desenvolvedor, mesmo se o manifest trouxer outra key', async () => {
    const developer = makeKey()
    const other = makeKey()
    const zip = makeZip([
      { name: 'manifest.json', data: JSON.stringify({ ...MV3, key: other.key }) },
      { name: '_metadata/verified_contents.json', data: '[]' },
    ])
    const pkg = await installer.fromBuffer(makeCrx3(zip, developer), 'crx')
    store.settle(pkg.id, pkg.dirName)
    expect(pkg.id).toBe(developer.id)
    expect(installedManifest(pkg.id, pkg.dirName).key).toBe(developer.key)
    expect(fs.existsSync(path.join(store.directory(pkg.id, pkg.dirName), '_metadata'))).toBe(false)
  })

  it('substituir mantém o ID e recusa pacote de outra extensão', async () => {
    const original = makeKey()
    const pkg = await installer.fromBuffer(
      makeZip([{ name: 'manifest.json', data: JSON.stringify({ ...MV3, version: '2.0' }) }]),
      'zip',
      { replaceKey: original.key },
    )
    store.settle(pkg.id, pkg.dirName)
    expect(pkg.id).toBe(original.id)
    const foreign = makeZip([{ name: 'manifest.json', data: JSON.stringify({ ...MV3, key: makeKey().key }) }])
    const error = await rejection(installer.fromBuffer(foreign, 'zip', { replaceKey: original.key }))
    expect(error.details).toMatchObject({ reason: 'differentId' })
  })

  it('pasta: copia sem links e recusa junção apontando para fora', async () => {
    const source = writeExtension(tempDir('folder'), MV3, { 'js/a.js': 'a' })
    fs.mkdirSync(path.join(source, '.git'))
    fs.writeFileSync(path.join(source, '.git', 'HEAD'), 'ref')
    const pkg = await installer.fromFolder(source)
    store.settle(pkg.id, pkg.dirName)
    expect(pkg.source).toBe('folder')
    expect(fs.existsSync(path.join(store.directory(pkg.id, pkg.dirName), '.git'))).toBe(false)
    const outside = tempDir('outside')
    fs.symlinkSync(outside, path.join(source, 'atalho'), 'junction')
    expect((await rejection(installer.fromFolder(source))).message).toMatch(/Links e atalhos/)
  })

  it('recusa caminhos longos demais para o Windows', async () => {
    const strict = new ExtensionInstaller({
      store,
      webStore: { download: () => Promise.reject(new Error()) },
      limits: { maxPath: 60 },
    })
    const zip = makeZip([
      { name: 'manifest.json', data: JSON.stringify(MV3) },
      { name: `${'pasta-longa/'.repeat(4)}arquivo.js`, data: '' },
    ])
    expect((await rejection(strict.fromBuffer(zip, 'zip'))).details).toMatchObject({ reason: 'pathTooLong' })
  })

  it('Web Store: segue o redirecionamento, envia a versão do Brave e confere o ID pedido', async () => {
    const developer = makeKey()
    web.packages.set(
      developer.id,
      makeCrx3(makeZip([{ name: 'manifest.json', data: JSON.stringify(MV3) }]), developer),
    )
    const pkg = await installer.fromWebStore(developer.id)
    store.settle(pkg.id, pkg.dirName)
    expect(pkg).toMatchObject({ id: developer.id, source: 'webstore' })
    expect(web.requests.some((request) => request.includes('prodversion=158.0.8127.92'))).toBe(true)
    // pacote de outra extensão servido no lugar do pedido
    const impostor = makeKey()
    web.packages.set(
      impostor.id,
      makeCrx3(makeZip([{ name: 'manifest.json', data: JSON.stringify(MV3) }]), developer),
    )
    expect((await rejection(installer.fromWebStore(impostor.id))).details).toMatchObject({
      reason: 'differentId',
    })
  })

  it('Web Store: extensão inexistente e redirecionamento para host não permitido', async () => {
    const missing = makeKey()
    expect((await rejection(installer.fromWebStore(missing.id))).details).toMatchObject({
      reason: 'webStoreNotFound',
    })
    const developer = makeKey()
    web.packages.set(
      developer.id,
      makeCrx3(makeZip([{ name: 'manifest.json', data: JSON.stringify(MV3) }]), developer),
    )
    web.redirectOutside = true
    const error = await rejection(installer.fromWebStore(developer.id))
    expect(error.code).toBe('EXTENSION_DOWNLOAD_FAILED')
    expect(error.details).toMatchObject({ reason: 'webStoreRedirect' })
  })

  it('Web Store: download acima do limite é interrompido', async () => {
    const developer = makeKey()
    web.packages.set(
      developer.id,
      makeCrx3(makeZip([{ name: 'manifest.json', data: JSON.stringify(MV3) }]), developer),
    )
    const tiny = new WebStoreClient({ baseUrl: web.url, prodVersion: () => '158.0.0.0', maxBytes: 100 })
    expect((await rejection(tiny.download(developer.id))).details).toMatchObject({
      reason: 'webStoreTooLarge',
    })
  })
})
