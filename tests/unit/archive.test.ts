import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterAll, describe, expect, it } from 'vitest'
import {
  checkVerifier,
  DecryptStream,
  deriveKey,
  EncryptStream,
  newKdfParams,
  verifierFor,
} from '@main/archive/crypto'
import { forEachEntry, openZipFile, readEntryBuffer, unpackAll } from '@main/archive/zip-reader'
import { ZipWriter } from '@main/archive/zip-writer'
import { AppError } from '@shared/ipc/result'
import { profileDataFilter, sanitizeImportedProfile, sanitizeLocalState } from '@main/transfer/profile-data'

fs.mkdirSync(path.resolve('.tmp-tests'), { recursive: true })
const root = fs.mkdtempSync(path.resolve('.tmp-tests', 'archive-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
const temp = (name: string): string => path.join(root, name)
const invalid = (message: string) => new AppError('TRANSFER_INVALID', message)

async function roundTrip(
  plain: Buffer,
  key: Buffer,
  mutate?: (sealed: Buffer) => Buffer,
  openKey: Buffer = key,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  await pipeline(Readable.from([plain]), new EncryptStream(key), async function (source) {
    for await (const chunk of source) chunks.push(chunk as Buffer)
  })
  const sealed = mutate ? mutate(Buffer.concat(chunks)) : Buffer.concat(chunks)
  const out: Buffer[] = []
  // Pedaços pequenos: os registros chegam cortados no meio, como num arquivo de verdade.
  const pieces = Array.from({ length: Math.ceil(sealed.length / 7000) }, (_, i) =>
    sealed.subarray(i * 7000, (i + 1) * 7000),
  )
  await pipeline(Readable.from(pieces), new DecryptStream(openKey), async function (source) {
    for await (const chunk of source) out.push(chunk as Buffer)
  })
  return Buffer.concat(out)
}

describe('cifragem do pacote', () => {
  const key = crypto.randomBytes(32)

  it.each([0, 10, 1024 * 1024, 1024 * 1024 + 1, 3 * 1024 * 1024 + 5])(
    'volta igual com %i bytes',
    async (size) => {
      const plain = crypto.randomBytes(size)
      expect((await roundTrip(plain, key)).equals(plain)).toBe(true)
    },
  )

  it('detecta byte alterado, registro final cortado e chave errada', async () => {
    const plain = crypto.randomBytes(2 * 1024 * 1024 + 100)
    await expect(
      roundTrip(plain, key, (sealed) => {
        const copy = Buffer.from(sealed)
        copy[copy.length - 40]! ^= 1
        return copy
      }),
    ).rejects.toMatchObject({ code: 'TRANSFER_INVALID' })
    // Corta o último registro inteiro: o penúltimo foi selado como "não é o último".
    const lastRecord = 4 + 100 + 16
    await expect(
      roundTrip(plain, key, (sealed) => sealed.subarray(0, sealed.length - lastRecord)),
    ).rejects.toMatchObject({ code: 'TRANSFER_INVALID' })
    await expect(roundTrip(plain, key, undefined, crypto.randomBytes(32))).rejects.toMatchObject({
      code: 'TRANSFER_INVALID',
    })
  })

  it('scrypt deriva a mesma chave e o verificador recusa a senha errada', async () => {
    const params = newKdfParams({ name: 'scrypt', N: 1024, r: 8, p: 1 })
    const a = await deriveKey('senha certa', params)
    const b = await deriveKey('senha certa'.normalize('NFD'), params)
    expect(a.equals(b)).toBe(true)
    expect(checkVerifier(a, verifierFor(a))).toBe(true)
    expect(checkVerifier(await deriveKey('senha errada', params), verifierFor(a))).toBe(false)
  })
})

describe('ZIP em fluxo', () => {
  it('grava pasta com filtro, espera a leitura dos arquivos e lê de volta com conferência', async () => {
    const source = temp('source')
    fs.mkdirSync(path.join(source, 'Default', 'Cache'), { recursive: true })
    fs.mkdirSync(path.join(source, 'Default', 'Local Storage', 'leveldb'), { recursive: true })
    fs.writeFileSync(path.join(source, 'Default', 'Cache', 'big'), 'cache')
    fs.writeFileSync(path.join(source, 'Default', 'Local Storage', 'leveldb', '000003.log'), 'dados')
    fs.writeFileSync(path.join(source, 'Default', 'Local Storage', 'leveldb', 'LOCK'), '')
    fs.writeFileSync(path.join(source, 'Default', 'Preferences'), '{}')
    fs.writeFileSync(path.join(source, 'BrowserMetrics'), 'x')
    const file = temp('out.zip')
    const writer = new ZipWriter(file)
    const added = writer.addDirectory(source, 'profiles/p1/data', profileDataFilter('backup'))
    writer.addBuffer('{"ok":true}', 'facet-export.json')
    expect(added).toMatchObject({ files: 2, bytes: 7 })
    const finished = writer.finish()
    await added.done
    expect(await finished).toBeGreaterThan(0)
    expect(fs.existsSync(`${file}.partial`)).toBe(false)

    const zipfile = await openZipFile(file)
    const names: string[] = []
    let manifest = ''
    await forEachEntry(
      zipfile,
      async ({ entry, segments }) => {
        names.push(segments.join('/'))
        if (segments[0] === 'facet-export.json')
          manifest = (await readEntryBuffer(zipfile, entry, 1024, invalid)).toString()
      },
      { maxEntries: 100, invalid },
    )
    zipfile.close()
    expect(names.sort()).toEqual([
      'facet-export.json',
      'profiles/p1/data/Default/Local Storage/leveldb/000003.log',
      'profiles/p1/data/Default/Preferences',
    ])
    expect(manifest).toBe('{"ok":true}')

    const target = temp('unpacked')
    const again = await openZipFile(file)
    expect(await unpackAll(again, target, { maxEntries: 100, maxTotalBytes: 1000 }, invalid)).toEqual({
      files: 3,
      bytes: 18,
    })
    again.close()
    expect(
      fs.readFileSync(path.join(target, 'profiles', 'p1', 'data', 'Default', 'Preferences'), 'utf8'),
    ).toBe('{}')
  })

  it('cancelar apaga o arquivo parcial e rejeita a espera pelos arquivos', async () => {
    const source = temp('cancel')
    fs.mkdirSync(source, { recursive: true })
    fs.writeFileSync(path.join(source, 'a.bin'), crypto.randomBytes(1024))
    const controller = new AbortController()
    const file = temp('cancel.zip')
    const writer = new ZipWriter(file, controller.signal)
    const added = writer.addDirectory(source, 'x', () => true)
    controller.abort(new AppError('CANCELLED', 'Operação cancelada'))
    await expect(writer.finish()).rejects.toMatchObject({ code: 'CANCELLED' })
    await expect(added.done).rejects.toBeDefined()
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(`${file}.partial`)).toBe(false)
  })
})

describe('dados do perfil', () => {
  const portable = profileDataFilter('portable')
  const backup = profileDataFilter('backup')

  it.each([
    [['Local State'], false, true, true],
    [['Default'], true, true, true],
    [['BrowserMetrics'], true, false, false],
    [['afalakplffnnnlkncjhbmahjfjhmlkal'], true, false, false],
    [['Default', 'Cache'], true, false, false],
    [['Default', 'GPUCache'], true, false, false],
    [['Default', 'Sessions'], true, false, false],
    [['Default', 'Service Worker', 'CacheStorage'], true, false, false],
    [['Default', 'Service Worker', 'Database'], true, true, true],
    [['Default', 'Network', 'Cookies'], false, false, true],
    [['Default', 'Login Data'], false, false, true],
    [['Default', 'History-journal'], false, false, false],
    [['Default', 'IndexedDB', 'x.leveldb', 'LOCK'], false, false, false],
    [['Default', 'Local Storage', 'leveldb', '000003.log'], false, true, true],
  ] as const)('%j (pasta=%s) portátil=%s backup=%s', (segments, isDirectory, inPortable, inBackup) => {
    expect(portable([...segments], isDirectory)).toBe(inPortable)
    expect(backup([...segments], isDirectory)).toBe(inBackup)
  })

  it('tira a chave os_crypt do Local State e apaga o que é cifrado com a chave do usuário', () => {
    expect(
      JSON.parse(
        sanitizeLocalState(Buffer.from('{"os_crypt":{"encrypted_key":"x"},"browser":{"a":1}}'))!.toString(),
      ),
    ).toEqual({ browser: { a: 1 } })
    expect(sanitizeLocalState(Buffer.from('não é json'))).toBeNull()
    const directory = temp('imported')
    fs.mkdirSync(path.join(directory, 'Default', 'Network'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'Local State'), '{"os_crypt":{"encrypted_key":"x"},"keep":1}')
    fs.writeFileSync(path.join(directory, 'Default', 'Network', 'Cookies'), 'cifrado')
    fs.writeFileSync(path.join(directory, 'Default', 'Login Data'), 'cifrado')
    fs.writeFileSync(path.join(directory, 'Default', 'Preferences'), '{}')
    sanitizeImportedProfile(directory)
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'Local State'), 'utf8'))).toEqual({ keep: 1 })
    expect(fs.existsSync(path.join(directory, 'Default', 'Network', 'Cookies'))).toBe(false)
    expect(fs.existsSync(path.join(directory, 'Default', 'Login Data'))).toBe(false)
    expect(fs.existsSync(path.join(directory, 'Default', 'Preferences'))).toBe(true)
  })
})
