/*
 * Compilador das listas de filtros na sintaxe do uBlock Origin (e do Adblock Plus) para a
 * extensão Facet, na mesma linha do uBlock Origin Lite (Manifest V3):
 *
 * - filtros de rede viram regras declarativeNetRequest (bloqueio, exceções `@@`, `$important`,
 *   `$domain`, tipos, terceiros, `$denyallow`, `$to`, `$method`, `$badfilter`);
 * - filtros cosméticos (`##`, `#@#`) viram seletores CSS por site e genéricos, aplicados pela
 *   extensão como folha de estilo de usuário.
 *
 * Fica de fora o que exige mexer no JavaScript ou no HTML da página (scriptlets `+js`, filtros
 * procedurais, `$redirect`, `$removeparam`, `$csp`, filtros de HTML): seria detectável pelos
 * sites. Funções puras: o script de build lê e grava os arquivos.
 */
import { domainToASCII } from 'node:url'

/** Ambiente das condições `!#if` (o mesmo de um bloqueador Manifest V3 no Chromium). */
export const ENVIRONMENT = Object.freeze({
  env_chromium: true,
  env_mv3: true,
  ext_ublock: true,
  ext_ubol: true,
  cap_user_stylesheet: true,
  native_css_has: true,
  env_firefox: false,
  env_safari: false,
  env_mobile: false,
  env_edge: false,
  cap_html_filtering: false,
  cap_ipaddress: false,
  ext_devbuild: false,
  adguard: false,
  false: false,
})

function evaluate(expression, environment) {
  const tokens = expression.match(/\(|\)|!|&&|\|\||[a-z0-9_]+/gi) ?? []
  let index = 0
  const primary = () => {
    const token = tokens[index++]
    if (token === '!') return !primary()
    if (token === '(') {
      const value = disjunction()
      index++ // ')'
      return value
    }
    return environment[token] === true
  }
  const conjunction = () => {
    let value = primary()
    while (tokens[index] === '&&') {
      index++
      value = primary() && value
    }
    return value
  }
  const disjunction = () => {
    let value = conjunction()
    while (tokens[index] === '||') {
      index++
      value = conjunction() || value
    }
    return value
  }
  return disjunction()
}

/** Aplica `!#if`/`!#else`/`!#endif` e devolve as linhas ativas (sem espaços nas pontas). */
export function preprocess(text, environment = ENVIRONMENT) {
  const lines = []
  const stack = []
  let active = true
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('!#if ')) {
      const condition = evaluate(line.slice(5), environment)
      stack.push({ parent: active, condition })
      active = active && condition
    } else if (line === '!#else') {
      const top = stack.at(-1)
      if (top) active = top.parent && !top.condition
    } else if (line === '!#endif') {
      const top = stack.pop()
      active = top ? top.parent : true
    } else if (active) lines.push(line)
  }
  return lines
}

const TYPE_ALIASES = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  ping: 'ping',
  beacon: 'ping',
  websocket: 'websocket',
  media: 'media',
  font: 'font',
  other: 'other',
  document: 'main_frame',
  doc: 'main_frame',
}
/** Tipos que valem sem `$document` (o padrão do Chromium também exclui a navegação principal). */
const ALL_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'other',
]
const COSMETIC_EXCEPTIONS = {
  generichide: ['generic'],
  ghide: ['generic'],
  specifichide: ['specific'],
  shide: ['specific'],
  elemhide: ['generic', 'specific'],
  ehide: ['generic', 'specific'],
}
const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put'])
/** Opções que mudam a resposta ou exigem recursos que não temos: o filtro fica de fora. */
const UNSUPPORTED = new Set([
  'redirect',
  'redirect-rule',
  'rewrite',
  'removeparam',
  'queryprune',
  'csp',
  'header',
  'permissions',
  'replace',
  'urlskip',
  'uritransform',
  'urltransform',
  'cname',
  'ipaddress',
  'strict1p',
  'strict3p',
  'strict-first-party',
  'strict-third-party',
  'popup',
  'popunder',
  'empty',
  'mp4',
  'inline-script',
  'inline-font',
  'genericblock',
  'webrtc',
  'cookie',
  'network',
  'jsonprune',
  'hls',
  'app',
  'stealth',
  'content',
  'extension',
  'jsinject',
  'urlblock',
  'specificblock',
  'reason',
])

function asciiHost(value) {
  const host = value.toLowerCase()
  if (!host || host.includes('*') || host.endsWith('.')) return null
  const ascii = /^[a-z0-9.-]+$/.test(host) ? host : domainToASCII(host)
  return ascii && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(ascii)
    ? ascii
    : null
}

/**
 * Lista de domínios de uma opção (`a.com|~b.com`). Entidades (`google.*`) e expressões
 * regulares não existem no declarativeNetRequest: se sobrar só a parte negada de uma lista que
 * tinha domínios incluídos, o filtro ficaria mais amplo, e por isso é descartado.
 */
function domainList(value) {
  const included = []
  const excluded = []
  let dropped = false
  for (const raw of value.split('|')) {
    const entry = raw.trim()
    if (!entry) continue
    const negated = entry.startsWith('~')
    const host = asciiHost(negated ? entry.slice(1) : entry)
    if (!host) {
      if (!negated) dropped = true
      continue
    }
    ;(negated ? excluded : included).push(host)
  }
  if (dropped && included.length === 0) return null
  return { included, excluded }
}

/**
 * Separa padrão e opções pelo último `$` cujo resto parece uma lista de opções (um `$` dentro
 * do padrão, como o fim de uma regex, não separa nada).
 */
function splitOptions(line) {
  const index = line.lastIndexOf('$')
  if (index < 0) return { pattern: line, options: '' }
  const options = line.slice(index + 1)
  if (!/^~?[a-z0-9_-]+(=[^,]*)?(,~?[a-z0-9_-]+(=[^,]*)?)*$/i.test(options))
    return { pattern: line, options: '' }
  return { pattern: line.slice(0, index), options }
}

/**
 * Lê um filtro de rede. Devolve `{ skip }` com o motivo quando o filtro não tem equivalente
 * no declarativeNetRequest, ou a forma intermediária usada por `toRule`.
 */
export function parseNetworkFilter(line) {
  let text = line
  const exception = text.startsWith('@@')
  if (exception) text = text.slice(2)
  const { pattern: rawPattern, options: rawOptions } = splitOptions(text)
  const filter = {
    exception,
    pattern: rawPattern,
    important: false,
    matchCase: false,
    party: null,
    types: new Set(),
    excludedTypes: new Set(),
    initiators: null,
    requestDomains: null,
    excludedRequestDomains: null,
    methods: null,
    excludedMethods: null,
    cosmetic: new Set(),
    badfilter: false,
    denyallow: false,
  }
  if (rawOptions) {
    for (const option of rawOptions.split(',')) {
      const [rawName, ...rest] = option.split('=')
      const negated = rawName.startsWith('~')
      const name = (negated ? rawName.slice(1) : rawName).toLowerCase()
      const value = rest.join('=')
      if (name === 'important') filter.important = true
      else if (name === 'match-case') filter.matchCase = true
      else if (name === 'badfilter') filter.badfilter = true
      else if (name === 'third-party' || name === '3p') filter.party = negated ? 'firstParty' : 'thirdParty'
      else if (name === 'first-party' || name === '1p') filter.party = negated ? 'thirdParty' : 'firstParty'
      else if (name === 'all') ALL_TYPES.forEach((type) => filter.types.add(type))
      else if (name in TYPE_ALIASES) {
        const type = TYPE_ALIASES[name]
        ;(negated ? filter.excludedTypes : filter.types).add(type)
        if (type === 'main_frame' && !negated && exception) filter.types.add('sub_frame')
      } else if (name in COSMETIC_EXCEPTIONS) {
        if (!exception || negated) return { skip: 'cosmetic-option' }
        COSMETIC_EXCEPTIONS[name].forEach((kind) => filter.cosmetic.add(kind))
      } else if (name === 'domain' || name === 'from') {
        const list = domainList(value)
        if (!list) return { skip: 'entity-domain' }
        filter.initiators = list
      } else if (name === 'to') {
        const list = domainList(value)
        if (!list) return { skip: 'entity-domain' }
        filter.requestDomains = list.included.length ? list.included : null
        filter.excludedRequestDomains = list.excluded.length ? list.excluded : null
      } else if (name === 'denyallow') {
        const list = domainList(value)
        if (!list || list.excluded.length) return { skip: 'entity-domain' }
        filter.excludedRequestDomains = list.included
        filter.denyallow = true
      } else if (name === 'method') {
        const methods = value.split('|').map((method) => method.toLowerCase())
        const included = methods.filter((method) => !method.startsWith('~'))
        const excluded = methods.filter((method) => method.startsWith('~')).map((method) => method.slice(1))
        if ([...included, ...excluded].some((method) => !METHODS.has(method)))
          return { skip: 'option-method' }
        filter.methods = included.length ? included : null
        filter.excludedMethods = excluded.length ? excluded : null
      } else if (UNSUPPORTED.has(name)) return { skip: `option-${name}` }
      else return { skip: `option-unknown` }
    }
  }
  return filter
}

/** `||host^`: o host inteiro (prefixos como `||site.` ou `||1.2.3.` seguem como urlFilter). */
const HOST_ONLY = /^\|\|([a-z0-9-]+(?:\.[a-z0-9-]+)+)\^$/

/**
 * Regra declarativeNetRequest de um filtro já lido (sem `id`), `{ hostOnly }` quando é um
 * bloqueio de host inteiro sem outras condições (agrupado depois em `requestDomains`), ou
 * `{ skip }` com o motivo.
 */
export function toRule(filter) {
  if (filter.skip) return filter
  if (filter.cosmetic.size > 0) return { skip: 'cosmetic-exception' }
  let pattern = filter.pattern
  if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) return { skip: 'regex' }
  // asteriscos nas pontas não mudam nada
  pattern = pattern.replace(/^\*+/, '').replace(/\*+$/, '')
  if (pattern.startsWith('||*')) pattern = pattern.slice(3)
  if (pattern === '|' || pattern === '||') pattern = ''
  if (/[^\x20-\x7e]/.test(pattern)) {
    const host = HOST_ONLY.exec(pattern.toLowerCase())
    if (!host) return { skip: 'non-ascii' }
  }
  if (/\s/.test(pattern)) return { skip: 'whitespace' }
  const condition = {}
  const lower = pattern.toLowerCase()
  const hostOnly = HOST_ONLY.exec(lower)
  let host = null
  if (hostOnly) {
    host = asciiHost(hostOnly[1])
    if (!host) return { skip: 'invalid-host' }
  } else if (pattern) {
    condition.urlFilter = pattern
  }
  // sem `$match-case`, o padrão do Chromium (desde a versão 118) já ignora maiúsculas
  if (filter.matchCase && condition.urlFilter) condition.isUrlFilterCaseSensitive = true
  if (filter.party) condition.domainType = filter.party
  if (filter.initiators) {
    if (filter.initiators.included.length) condition.initiatorDomains = [...filter.initiators.included].sort()
    if (filter.initiators.excluded.length)
      condition.excludedInitiatorDomains = [...filter.initiators.excluded].sort()
  }
  if (filter.requestDomains) condition.requestDomains = [...filter.requestDomains].sort()
  if (filter.excludedRequestDomains) {
    // `$denyallow` só vale junto de `$domain` (o uBlock Origin recusa o filtro sem ele)
    if (filter.denyallow && !condition.initiatorDomains) return { skip: 'denyallow-without-domain' }
    condition.excludedRequestDomains = [...filter.excludedRequestDomains].sort()
  }
  if (filter.methods) condition.requestMethods = filter.methods
  if (filter.excludedMethods) condition.excludedRequestMethods = filter.excludedMethods
  let types = [...filter.types]
  if (types.length && filter.excludedTypes.size)
    types = types.filter((type) => !filter.excludedTypes.has(type))
  if (filter.types.size && types.length === 0) return { skip: 'no-type' }
  if (types.length) condition.resourceTypes = types.sort()
  else if (filter.excludedTypes.size) condition.excludedResourceTypes = [...filter.excludedTypes].sort()
  if (!condition.urlFilter && !host && !condition.requestDomains && !condition.initiatorDomains)
    return { skip: 'too-broad' }

  let action = { type: filter.exception ? 'allow' : 'block' }
  let priority = filter.exception ? 2 : filter.important ? 3 : 1
  if (filter.exception && condition.resourceTypes?.includes('main_frame')) {
    // exceção de página inteira (`@@||site^$document`): vale para tudo o que a página carregar
    action = { type: 'allowAllRequests' }
    condition.resourceTypes = condition.resourceTypes.filter(
      (type) => type === 'main_frame' || type === 'sub_frame',
    )
  }
  const rule = { priority, action, condition }
  if (host) {
    const keys = Object.keys(condition).filter((key) => key !== 'isUrlFilterCaseSensitive')
    if (
      keys.every((key) =>
        [
          'domainType',
          'resourceTypes',
          'excludedResourceTypes',
          'initiatorDomains',
          'excludedInitiatorDomains',
        ].includes(key),
      )
    )
      return { hostOnly: host, rule }
    condition.urlFilter = `||${host}^`
  }
  return { rule }
}

/** Linha de lista no formato hosts (`0.0.0.0 dominio`) ou só o domínio. */
function hostsLine(line, format) {
  if (!line || line.startsWith('#') || line.startsWith('!')) return null
  const parts = line.split(/\s+/)
  const host =
    format === 'hosts' ? (/^(0\.0\.0\.0|127\.0\.0\.1|::1?)$/.test(parts[0]) ? parts[1] : null) : parts[0]
  if (!host || host === 'localhost' || host === '0.0.0.0') return null
  return host
}

const PROCEDURAL =
  /:(has-text|matches-css(-before|-after)?|matches-attr|matches-media|matches-path|matches-prop|min-text-length|others|upward|watch-attr|xpath|remove|remove-attr|remove-class|style|contains|if|if-not|nth-ancestor|spath|-abp-[a-z-]+)\(/i

/**
 * Lê um filtro cosmético. `null` = não é cosmético; `{ skip }` = cosmético que não aplicamos
 * (scriptlets, CSS estendido, HTML); senão hosts incluídos/excluídos e o seletor.
 */
export function parseCosmeticFilter(line) {
  const match = /^([^#]*?)(#@?(?:\$\?|[?$%])?#)(.*)$/.exec(line)
  if (!match) return null
  const [, domains, separator, body] = match
  // `##` no meio de uma URL de filtro de rede (ex.: `||site/#anchor##`) é raro; exige hosts sem "/"
  if (domains.includes('/')) return null
  const exception = separator.includes('@')
  if (/[?$%]/.test(separator)) return { skip: 'extended' }
  if (body.startsWith('+js(')) return { skip: 'scriptlet' }
  if (body.startsWith('^')) return { skip: 'html' }
  const selector = body.trim()
  if (!selector) return { skip: 'empty' }
  if (PROCEDURAL.test(selector)) return { skip: 'procedural' }
  if (/[{}]/.test(selector)) return { skip: 'invalid-selector' }
  const included = []
  const excluded = []
  for (const raw of domains.split(',')) {
    const entry = raw.trim()
    if (!entry) continue
    const negated = entry.startsWith('~')
    const host = asciiHost(negated ? entry.slice(1) : entry)
    if (!host) {
      if (!negated) return { skip: 'entity-domain' }
      continue
    }
    ;(negated ? excluded : included).push(host)
  }
  return { exception, included, excluded, selector }
}

/** Token de classe ou id do último composto do seletor (o elemento escondido precisa tê-lo). */
export function genericToken(selector) {
  // último composto: depois do último combinador fora de colchetes/parênteses
  let depth = 0
  let start = 0
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i]
    if (char === '\\') {
      i++
      continue
    }
    if (char === '[' || char === '(') depth++
    else if (char === ']' || char === ')') depth--
    else if (depth === 0 && (char === ' ' || char === '>' || char === '+' || char === '~' || char === ',')) {
      if (char === ',') return null
      start = i + 1
    }
  }
  const compound = selector.slice(start)
  let level = 0
  for (let i = 0; i < compound.length; i++) {
    const char = compound[i]
    if (char === '[' || char === '(') level++
    else if (char === ']' || char === ')') level--
    else if (level === 0 && (char === '.' || char === '#')) {
      const name = /^[A-Za-z_-][A-Za-z0-9_-]*/.exec(compound.slice(i + 1))?.[0]
      if (name && !/[\\]/.test(compound.slice(i + 1, i + 1 + name.length + 1))) return `${char}${name}`
    }
  }
  return null
}

function push(map, key, value) {
  const list = map.get(key)
  if (list) list.add(value)
  else map.set(key, new Set([value]))
}

/**
 * Compila as listas. `lists`: `[{ id, ruleset, format: 'filters' | 'hosts' | 'domains', text }]`.
 * Devolve as regras por ruleset (com ids sequenciais), os dados cosméticos e as contagens.
 */
export function compile(lists, options = {}) {
  const chunk = options.domainsPerRule ?? 1000
  const stats = { network: 0, cosmetic: 0, skipped: {} }
  const skip = (reason) => (stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1)
  const network = []
  const cosmetic = {
    generic: new Set(),
    genericExceptions: new Set(),
    specific: new Map(),
    exceptions: new Map(),
  }
  const cosmeticOff = { generic: new Set(), specific: new Set() }
  const badfilters = new Set()

  for (const list of lists) {
    for (const line of preprocess(list.text)) {
      if (!line || line.startsWith('!') || line.startsWith('[')) continue
      if (list.format !== 'filters') {
        const host = hostsLine(line, list.format)
        if (!host) continue
        network.push({ ruleset: list.ruleset, text: `||${host}^${list.format === 'domains' ? '$all' : ''}` })
        continue
      }
      const parsedCosmetic = parseCosmeticFilter(line)
      if (parsedCosmetic) {
        if (parsedCosmetic.skip) {
          skip(`cosmetic-${parsedCosmetic.skip}`)
          continue
        }
        stats.cosmetic++
        const { exception, included, excluded, selector } = parsedCosmetic
        if (exception) {
          if (included.length === 0) cosmetic.genericExceptions.add(selector)
          for (const host of included) push(cosmetic.exceptions, host, selector)
        } else if (included.length === 0) {
          cosmetic.generic.add(selector)
          for (const host of excluded) push(cosmetic.exceptions, host, selector)
        } else {
          for (const host of included) push(cosmetic.specific, host, selector)
          for (const host of excluded) push(cosmetic.exceptions, host, selector)
        }
        continue
      }
      if (line.startsWith('#') || line.includes('##')) {
        skip('cosmetic-unparsed')
        continue
      }
      const parsed = parseNetworkFilter(line)
      if (parsed.skip) {
        skip(parsed.skip)
        continue
      }
      if (parsed.badfilter) {
        badfilters.add(normalizeFilter(line))
        continue
      }
      if (parsed.cosmetic.size > 0) {
        const host = HOST_ONLY.exec(parsed.pattern.toLowerCase())?.[1]
        const ascii = host ? asciiHost(host) : null
        if (ascii) for (const kind of parsed.cosmetic) cosmeticOff[kind].add(ascii)
        else skip('cosmetic-exception-pattern')
        continue
      }
      network.push({ ruleset: list.ruleset, text: line, parsed })
    }
  }

  const rulesets = new Map()
  const seen = new Set()
  const hostGroups = new Map()
  for (const entry of network) {
    if (badfilters.has(normalizeFilter(entry.text))) {
      skip('badfilter')
      continue
    }
    const converted = toRule(entry.parsed ?? parseNetworkFilter(entry.text))
    if (converted.skip) {
      skip(converted.skip)
      continue
    }
    stats.network++
    if (converted.hostOnly) {
      const key = `${entry.ruleset}\u0000${JSON.stringify(converted.rule)}`
      const group = hostGroups.get(key) ?? { ruleset: entry.ruleset, rule: converted.rule, hosts: new Set() }
      group.hosts.add(converted.hostOnly)
      hostGroups.set(key, group)
      continue
    }
    const key = JSON.stringify(converted.rule)
    if (seen.has(key)) continue
    seen.add(key)
    const list = rulesets.get(entry.ruleset) ?? []
    list.push(converted.rule)
    rulesets.set(entry.ruleset, list)
  }
  for (const group of hostGroups.values()) {
    const hosts = [...group.hosts].sort()
    const list = rulesets.get(group.ruleset) ?? []
    for (let i = 0; i < hosts.length; i += chunk)
      list.push({
        ...group.rule,
        condition: { ...group.rule.condition, requestDomains: hosts.slice(i, i + chunk) },
      })
    rulesets.set(group.ruleset, list)
  }
  const output = {}
  for (const [name, rules] of [...rulesets.entries()].sort()) {
    output[name] = rules.map((rule, index) => ({ id: index + 1, ...rule }))
  }

  // cosméticos: exceções genéricas removem o seletor; genéricos viram índice por classe/id
  const lowly = {}
  const highly = []
  for (const selector of [...cosmetic.generic].sort()) {
    if (cosmetic.genericExceptions.has(selector)) continue
    const token = genericToken(selector)
    if (token) (lowly[token] ??= []).push(selector)
    else highly.push(selector)
  }
  const specific = Object.fromEntries(
    [...cosmetic.specific.entries()].sort().map(([host, selectors]) => [host, [...selectors].sort()]),
  )
  const exceptions = Object.fromEntries(
    [...cosmetic.exceptions.entries()].sort().map(([host, selectors]) => [host, [...selectors].sort()]),
  )
  return {
    rulesets: output,
    cosmetic: {
      highly,
      lowly,
      specific,
      exceptions,
      generichide: [...cosmeticOff.generic].sort(),
      specifichide: [...cosmeticOff.specific].sort(),
    },
    stats,
  }
}

/** Texto do filtro sem `badfilter` (para achar o filtro que ele desliga). */
function normalizeFilter(line) {
  const { pattern, options } = splitOptions(line)
  if (!options) return pattern
  const kept = options
    .split(',')
    .filter((option) => option.toLowerCase() !== 'badfilter')
    .sort()
  return kept.length ? `${pattern}$${kept.join(',')}` : pattern
}
