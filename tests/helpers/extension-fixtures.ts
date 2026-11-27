import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import { extensionIdFromKey } from '@main/extensions/ids'

export interface TestKey {
  /** SPKI DER. */
  publicKey: Buffer
  /** SPKI em base64 (formato do campo `key` do manifest). */
  key: string
  privateKey: KeyObject
  id: string
}

export function makeKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return { publicKey: der, key: der.toString('base64'), privateKey, id: extensionIdFromKey(der) }
}

/** Grava uma extensão descompactada (manifest + arquivos) e devolve a pasta. */
export function writeExtension(
  directory: string,
  manifest: Record<string, unknown>,
  files: Record<string, string | Buffer> = {},
): string {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(directory, name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return directory
}

export interface ZipEntry {
  name: string
  data?: string | Buffer
  directory?: boolean
  /** Marca a entrada como link simbólico (atributos Unix). */
  symlink?: boolean
  /** CRC gravado no ZIP (para simular arquivo corrompido). */
  crc?: number
}

/** ZIP mínimo (deflate, nomes UTF-8) para montar pacotes de teste, inclusive maliciosos. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = entry.directory ? Buffer.alloc(0) : Buffer.from(entry.data ?? '')
    const data = entry.directory ? raw : zlib.deflateRawSync(raw)
    const method = entry.directory ? 0 : 8
    const crc = entry.crc ?? zlib.crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc >>> 0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, data)
    const mode = entry.symlink ? 0o120777 : entry.directory ? 0o40755 : 0o100644
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc >>> 0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((mode << 16) | (entry.directory ? 0x10 : 0)) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/** ZIP de uma pasta (todos os arquivos, nomes relativos com "/"). */
export function zipFolder(directory: string, prefix = ''): Buffer {
  const entries: ZipEntry[] = []
  const walk = (current: string, relative: string): void => {
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const name = relative ? `${relative}/${item.name}` : item.name
      if (item.isDirectory()) walk(path.join(current, item.name), name)
      else entries.push({ name: `${prefix}${name}`, data: fs.readFileSync(path.join(current, item.name)) })
    }
  }
  walk(directory, '')
  return makeZip(entries)
}

function varint(value: number): Buffer {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 128) | 0x80)
    rest = Math.floor(rest / 128)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

function field(number: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes])
}

export interface CrxOptions {
  /** Altera um byte do ZIP depois de assinar. */
  tamper?: boolean
  /** Prova extra de outra chave (como a da própria Web Store). */
  extraKey?: TestKey
  /** Sem a prova da chave do desenvolvedor. */
  withoutDeveloperProof?: boolean
}

/** CRX3 assinado como a Chrome Web Store entrega. */
export function makeCrx3(zip: Buffer, developer: TestKey, options: CrxOptions = {}): Buffer {
  const crxId = createHash('sha256').update(developer.publicKey).digest().subarray(0, 16)
  const signedHeader = field(1, crxId)
  const length = Buffer.alloc(4)
  length.writeUInt32LE(signedHeader.length)
  const signedData = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), length, signedHeader, zip])
  const proof = (key: TestKey): Buffer =>
    field(2, Buffer.concat([field(1, key.publicKey), field(2, sign('sha256', signedData, key.privateKey))]))
  const header = Buffer.concat([
    ...(options.extraKey ? [proof(options.extraKey)] : []),
    ...(options.withoutDeveloperProof ? [] : [proof(developer)]),
    field(10000, signedHeader),
  ])
  const prefix = Buffer.alloc(12)
  Buffer.from('Cr24', 'latin1').copy(prefix, 0)
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  const body = Buffer.from(zip)
  if (options.tamper) body[body.length - 30] = (body[body.length - 30]! + 1) % 256
  return Buffer.concat([prefix, header, body])
}

/** CRX2 (formato antigo, assinatura SHA-1 do ZIP). */
export function makeCrx2(zip: Buffer, developer: TestKey): Buffer {
  const signature = sign('sha1', zip, developer.privateKey)
  const prefix = Buffer.alloc(16)
  Buffer.from('Cr24', 'latin1').copy(prefix, 0)
  prefix.writeUInt32LE(2, 4)
  prefix.writeUInt32LE(developer.publicKey.length, 8)
  prefix.writeUInt32LE(signature.length, 12)
  return Buffer.concat([prefix, developer.publicKey, signature, zip])
}

export interface FakeWebStore {
  /** Endereço do serviço (equivalente a clients2.google.com/service/update2/crx). */
  url: string
  /** Pedidos recebidos (caminho + query). */
  requests: string[]
  packages: Map<string, Buffer>
  /** Redireciona o próximo download para fora do servidor (host não permitido). */
  redirectOutside: boolean
  close: () => Promise<void>
}

/** Web Store local: responde com redirecionamento para o CRX, como o serviço do Google. */
export async function fakeWebStore(): Promise<FakeWebStore> {
  const state: Omit<FakeWebStore, 'url' | 'close'> = {
    requests: [],
    packages: new Map(),
    redirectOutside: false,
  }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    state.requests.push(`${url.pathname}${url.search}`)
    if (url.pathname === '/crx') {
      const id = /id=([a-p]{32})/.exec(url.searchParams.get('x') ?? '')?.[1]
      if (!id || !state.packages.has(id)) {
        response.writeHead(204)
        response.end()
        return
      }
      const location = state.redirectOutside ? 'http://disallowed.invalid/blob.crx' : `/blob/${id}.crx`
      response.writeHead(302, { location })
      response.end()
      return
    }
    const blob = /^\/blob\/([a-p]{32})\.crx$/.exec(url.pathname)?.[1]
    const body = blob ? state.packages.get(blob) : undefined
    if (!body) {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(200, {
      'content-type': 'application/x-chrome-extension',
      'content-length': body.length,
    })
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Porta indisponível')
  return Object.assign(state, {
    url: `http://127.0.0.1:${address.port}/crx`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  })
}
