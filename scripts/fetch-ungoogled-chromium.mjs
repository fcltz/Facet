// Ungoogled Chromium que vem com o Facet (navegador padrão dos perfis), na versão fixada abaixo.
// Baixa o zip oficial do ungoogled-chromium-windows, confere o SHA-256 publicado na release e
// extrai em vendor/ungoogled-chromium (o electron-builder copia a pasta para os recursos do app).
// Sai na hora quando a versão certa já está extraída. Só no Windows (é o único pacote do Facet).
//
// uso: node scripts/fetch-ungoogled-chromium.mjs [--zip <arquivo já baixado>]
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'

export const UNGOOGLED = {
  version: '158.0.8127.36-1.1',
  file: 'ungoogled-chromium_158.0.8127.36-1.1_windows_x64.zip',
  url: 'https://github.com/ungoogled-software/ungoogled-chromium-windows/releases/download/158.0.8127.36-1.1/ungoogled-chromium_158.0.8127.36-1.1_windows_x64.zip',
  sha256: 'bc78b9590881f8ca99aca29288d1b347ffdd689ca8a57384bb0bc113ef687b6b',
  size: 204306715,
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const vendor = path.join(root, 'vendor')
const target = path.join(vendor, 'ungoogled-chromium')
const marker = path.join(target, 'facet-browser.json')

async function sha256(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

async function download(destination) {
  process.stdout.write(`Baixando ${UNGOOGLED.file} (${(UNGOOGLED.size / 1024 ** 2).toFixed(0)} MB)…\n`)
  const response = await fetch(UNGOOGLED.url, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download falhou: HTTP ${response.status}`)
  const partial = `${destination}.${randomUUID()}.part`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  await fs.rename(partial, destination)
}

function openZip(file) {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true }, (error, zip) =>
      error ? reject(error) : resolve(zip),
    ),
  )
}

/** Extrai tirando a pasta de cima do zip; recusa caminhos que saiam do destino. */
async function extract(file, destination) {
  const zip = await openZip(file)
  let count = 0
  await new Promise((resolve, reject) => {
    zip.on('error', reject)
    zip.on('end', resolve)
    zip.on('entry', (entry) => {
      const parts = entry.fileName.split('/').filter(Boolean)
      const relative = parts.slice(1).join('/')
      const output = path.resolve(destination, relative)
      if (!relative || (output !== destination && !output.startsWith(destination + path.sep))) {
        if (relative) return reject(new Error(`Caminho inválido no zip: ${entry.fileName}`))
        zip.readEntry()
        return
      }
      if (entry.fileName.endsWith('/')) {
        fs.mkdir(output, { recursive: true }).then(() => zip.readEntry(), reject)
        return
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error) return reject(error)
        fs.mkdir(path.dirname(output), { recursive: true })
          .then(() => pipeline(stream, createWriteStream(output)))
          .then(() => {
            count++
            zip.readEntry()
          }, reject)
      })
    })
    zip.readEntry()
  })
  return count
}

async function main() {
  if (process.platform !== 'win32') {
    process.stdout.write('Ungoogled Chromium empacotado só no Windows; nada a fazer.\n')
    return
  }
  try {
    const current = JSON.parse(await fs.readFile(marker, 'utf8'))
    if (current.version === UNGOOGLED.version && existsSync(path.join(target, 'chrome.exe'))) return
  } catch {
    /* ainda não extraído */
  }
  await fs.mkdir(vendor, { recursive: true })
  const given = process.argv.includes('--zip') ? process.argv[process.argv.indexOf('--zip') + 1] : null
  const zip = given ? path.resolve(given) : path.join(vendor, UNGOOGLED.file)
  if (!existsSync(zip)) await download(zip)
  const digest = await sha256(zip)
  if (digest !== UNGOOGLED.sha256) {
    if (!given) await fs.rm(zip, { force: true })
    throw new Error(`SHA-256 do zip não confere (${digest}); nada foi extraído`)
  }
  const staging = path.join(vendor, `.ungoogled-${randomUUID()}`)
  try {
    const count = await extract(zip, staging)
    if (!existsSync(path.join(staging, 'chrome.exe'))) throw new Error('chrome.exe ausente no zip')
    await fs.writeFile(
      path.join(staging, 'facet-browser.json'),
      JSON.stringify(
        { version: UNGOOGLED.version, sha256: UNGOOGLED.sha256, source: UNGOOGLED.url },
        null,
        2,
      ),
    )
    await fs.rm(target, { recursive: true, force: true })
    await fs.rename(staging, target)
    process.stdout.write(
      `Ungoogled Chromium ${UNGOOGLED.version}: ${count} arquivos em ${path.relative(root, target)}\n`,
    )
  } finally {
    await fs.rm(staging, { recursive: true, force: true })
  }
  // o zip baixado não é mais necessário (o extraído é o que vai no pacote)
  if (!given) await fs.rm(zip, { force: true })
}

main().catch((error) => {
  console.error(
    'Não foi possível preparar o Ungoogled Chromium:',
    error instanceof Error ? error.message : error,
  )
  process.exit(1)
})
