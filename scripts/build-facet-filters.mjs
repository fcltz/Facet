/*
 * Gera os filtros da extensão Facet a partir das listas padrão do uBlock Origin.
 *
 *   node scripts/build-facet-filters.mjs            compila as listas guardadas (offline)
 *   node scripts/build-facet-filters.mjs --update   baixa as listas de novo e compila
 *
 * As listas ficam em resources/facet-extension/third-party/lists/ (com endereço, data e
 * SHA-256 em sources.json), e o resultado em rules/*.json e cosmetic.json.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from './filters/compile.mjs'

const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../resources/facet-extension')
const listsDir = path.join(extension, 'third-party', 'lists')
const sourcesFile = path.join(extension, 'third-party', 'sources.json')

/** As 9 listas que o uBlock Origin liga por padrão (assets/assets.json do repositório dele). */
export const LISTS = [
  {
    id: 'ublock-filters',
    title: 'uBlock filters – Ads',
    url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt',
    ruleset: 'ads',
    format: 'filters',
    license: 'GPL-3.0',
  },
  {
    id: 'ublock-badware',
    title: 'uBlock filters – Badware risks',
    url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt',
    ruleset: 'malware',
    format: 'filters',
    license: 'GPL-3.0',
  },
  {
    id: 'ublock-privacy',
    title: 'uBlock filters – Privacy',
    url: 'https://ublockorigin.github.io/uAssets/filters/privacy.txt',
    ruleset: 'privacy',
    format: 'filters',
    license: 'GPL-3.0',
  },
  {
    id: 'ublock-unbreak',
    title: 'uBlock filters – Unbreak',
    url: 'https://ublockorigin.github.io/uAssets/filters/unbreak.txt',
    ruleset: 'unbreak',
    format: 'filters',
    license: 'GPL-3.0',
  },
  {
    id: 'ublock-quick-fixes',
    title: 'uBlock filters – Quick fixes',
    url: 'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt',
    ruleset: 'ads',
    format: 'filters',
    license: 'GPL-3.0',
  },
  {
    id: 'easylist',
    title: 'EasyList',
    url: 'https://ublockorigin.github.io/uAssets/thirdparties/easylist.txt',
    ruleset: 'ads',
    format: 'filters',
    license: 'GPL-3.0 OR CC-BY-SA-3.0',
  },
  {
    id: 'easyprivacy',
    title: 'EasyPrivacy',
    url: 'https://ublockorigin.github.io/uAssets/thirdparties/easyprivacy.txt',
    ruleset: 'privacy',
    format: 'filters',
    license: 'GPL-3.0 OR CC-BY-SA-3.0',
  },
  {
    id: 'plowe-0',
    title: "Peter Lowe's Ad and tracking server list",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=1&mimetype=plaintext',
    ruleset: 'ads',
    format: 'hosts',
    license: 'Peter Lowe (uso livre com atribuição: https://pgl.yoyo.org/adservers/)',
  },
  {
    // a variante só de hosts inteiros: a completa tem 110 mil URLs, grande demais para regras declarativas
    id: 'urlhaus-1',
    title: 'Online Malicious URL Blocklist (hosts)',
    url: 'https://malware-filter.gitlab.io/urlhaus-filter/urlhaus-filter-domains-online.txt',
    ruleset: 'malware',
    format: 'domains',
    license: 'CC0-1.0 (URLhaus) e MIT (urlhaus-filter)',
  },
]
export const RULESETS = ['ads', 'privacy', 'malware', 'unbreak']

async function download(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'facet-filter-builder' } })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.text()
}

/** Baixa a lista e insere no lugar os arquivos de `!#include` (do mesmo endereço). */
async function fetchList(url, depth = 0) {
  const text = await download(url)
  if (depth > 2) return text
  const lines = []
  for (const line of text.split(/\r?\n/)) {
    const include = /^!#include\s+(\S+)/.exec(line.trim())
    if (!include) {
      lines.push(line)
      continue
    }
    const target = new URL(include[1], url).href
    lines.push(`! >>> ${include[1]}`, await fetchList(target, depth + 1), `! <<< ${include[1]}`)
  }
  return lines.join('\n')
}

async function update() {
  fs.mkdirSync(listsDir, { recursive: true })
  const sources = []
  for (const list of LISTS) {
    const text = await fetchList(list.url)
    fs.writeFileSync(path.join(listsDir, `${list.id}.txt`), text)
    sources.push({
      id: list.id,
      title: list.title,
      url: list.url,
      license: list.license,
      fetchedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(text).digest('hex'),
      lines: text.split('\n').length,
    })
    process.stdout.write(`baixada ${list.id}\n`)
  }
  fs.writeFileSync(sourcesFile, `${JSON.stringify(sources, null, 2)}\n`)
}

function build() {
  const sources = JSON.parse(fs.readFileSync(sourcesFile, 'utf8'))
  const lists = LISTS.map((list) => {
    const text = fs.readFileSync(path.join(listsDir, `${list.id}.txt`), 'utf8')
    const pinned = sources.find((source) => source.id === list.id)
    const sha256 = createHash('sha256').update(text).digest('hex')
    if (!pinned || pinned.sha256 !== sha256)
      throw new Error(`Lista ${list.id} diferente da registrada em sources.json`)
    return { ...list, text }
  })
  const result = compile(lists)
  const rulesDir = path.join(extension, 'rules')
  fs.mkdirSync(rulesDir, { recursive: true })
  let total = 0
  for (const name of RULESETS) {
    const rules = result.rulesets[name] ?? []
    total += rules.length
    fs.writeFileSync(path.join(rulesDir, `${name}.json`), `${JSON.stringify(rules)}\n`)
  }
  fs.writeFileSync(path.join(extension, 'cosmetic.json'), `${JSON.stringify(result.cosmetic)}\n`)
  const generic = Object.values(result.cosmetic.lowly).reduce((sum, list) => sum + list.length, 0)
  process.stdout.write(
    [
      `Facet: ${result.stats.network} filtros de rede em ${total} regras declarativas`,
      `  ${RULESETS.map((name) => `${name}: ${(result.rulesets[name] ?? []).length}`).join(', ')}`,
      `  cosméticos: ${generic} genéricos por classe/id, ${result.cosmetic.highly.length} genéricos amplos, ` +
        `${Object.keys(result.cosmetic.specific).length} sites com seletores próprios`,
      `  fora (sem equivalente sem alterar a página): ${JSON.stringify(result.stats.skipped)}`,
      '',
    ].join('\n'),
  )
}

if (process.argv.includes('--update')) await update()
build()
