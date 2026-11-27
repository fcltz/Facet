importScripts('core.js')

const core = globalThis.FacetCore
const ENDPOINTS = core.ENDPOINTS
/** Cabeçalho que o proxy local exige (um site não consegue enviá-lo para outra origem). */
const USAGE_HEADER = 'x-facet-usage'
const SAMPLE_BYTES = 1048576
const PROBE_TTL_MS = 60000
const USAGE_TTL_MS = 4000
const SPEED_COOLDOWN_MS = 20000
/** Documentos registrados, com o CSS inserido em cada um (removido depois pelo texto exato). */
const MAX_DOCUMENTS = 200
const language = navigator.language
const controllers = new Set()
let queue = Promise.resolve()
let probePending = null
let speedPending = null
let usagePending = null
let cosmeticData = null
/** Cosméticos já inseridos por documento: '' = os da carga da página; o resto, tokens genéricos. */
const cosmeticDocuments = new Map()
/** Posição provisória do indicador num documento enquanto o usuário o arrasta. */
const dragging = new Map()

/** Uma operação de cada vez: preferências, CSS dos documentos e regras não se atropelam. */
function serial(task) {
  const next = queue.catch(() => undefined).then(task)
  queue = next.catch(() => undefined)
  return next
}

async function preferences() {
  const { settings } = await chrome.storage.local.get('settings')
  return core.settings(settings)
}

async function savedPosition() {
  const { position } = await chrome.storage.local.get('position')
  return core.position(position)
}

async function session(keys) {
  return chrome.storage.session.get(keys)
}

/** Regras de bloqueio, contador do ícone e pré-carregamento conforme as preferências. */
async function applyBrowserSettings(settings) {
  await chrome.declarativeNetRequest.updateEnabledRulesets(core.rulesets(settings))
  try {
    // contador de bloqueios no ícone, como no uBlock Origin (interface do navegador, não da página)
    await chrome.declarativeNetRequest.setExtensionActionOptions({
      displayActionCountAsBadgeText: settings.enabled && settings.adblock,
    })
  } catch {
    // versão do navegador sem o contador
  }
  const prediction = chrome.privacy.network.networkPredictionEnabled
  try {
    if (settings.enabled && settings.optimize) await prediction.set({ value: false })
    else await prediction.clear({})
  } catch {
    // outra extensão controla a preferência: as regras continuam valendo
  }
}

/** Regra de sessão que libera as consultas da extensão (uma vez por vida do service worker). */
let ownRequests = null
function allowOwnRequests() {
  ownRequests ??= chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [core.OWN_REQUESTS_RULE_ID], addRules: [core.ownRequestsRule()] })
    .catch((error) => {
      ownRequests = null
      throw error
    })
  return ownRequests
}

async function initialize() {
  // O Brave trata extensões de --load-extension como recém-instaladas a cada abertura:
  // reaplica as escolhas salvas (nunca as sobrescreve).
  await chrome.action.setBadgeBackgroundColor({ color: '#5b5bf7' }).catch(() => undefined)
  await allowOwnRequests().catch(() => undefined)
  await applyBrowserSettings(await preferences())
}
chrome.runtime.onInstalled.addListener(() => void serial(initialize))
chrome.runtime.onStartup.addListener(() => void serial(initialize))

async function request(url, timeoutMs, consume, headers = {}) {
  // as listas de filtros não podem bloquear a consulta da própria extensão
  await allowOwnRequests().catch(() => undefined)
  const controller = new AbortController()
  controllers.add(controller)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await consume(response)
  } finally {
    clearTimeout(timer)
    controllers.delete(controller)
  }
}

/** IP de saída, país e latência; no máximo uma consulta por minuto. */
async function probe() {
  const { metrics } = await session('metrics')
  if (core.fresh(metrics, Date.now(), PROBE_TTL_MS)) return metrics
  if (probePending) return probePending
  probePending = (async () => {
    let result
    try {
      const started = performance.now()
      const parsed = core.trace(await request(ENDPOINTS.trace, 8000, (response) => response.text()))
      if (!parsed) throw new Error('Resposta sem IP')
      result = { ...parsed, latency: Math.round(performance.now() - started), at: Date.now(), error: false }
    } catch {
      result = { ip: null, country: null, latency: null, at: Date.now(), error: true }
    }
    await chrome.storage.session.set({ metrics: result })
    return result
  })().finally(() => {
    probePending = null
  })
  return probePending
}

/** Gasto da proxy nesta sessão, informado pelo proxy local do Facet (null = sem proxy). */
async function usage() {
  const { usage: cached } = await session('usage')
  if (core.fresh(cached, Date.now(), USAGE_TTL_MS)) return cached.data
  if (usagePending) return usagePending
  usagePending = (async () => {
    let data = null
    try {
      data = core.usage(
        await request(ENDPOINTS.usage, 3000, (response) => response.json(), {
          [USAGE_HEADER]: chrome.runtime.id,
        }),
      )
    } catch {
      // perfil sem proxy: o endereço não existe fora do proxy local
    }
    await chrome.storage.session.set({ usage: { data, at: Date.now() } })
    return data
  })().finally(() => {
    usagePending = null
  })
  return usagePending
}

/** Baixa 1 MiB pelo proxy e mede a taxa do corpo (sem contar a conexão e a espera do servidor). */
async function measure() {
  if (speedPending) return speedPending
  const { speedStartedAt } = await session('speedStartedAt')
  if (core.fresh({ at: speedStartedAt }, Date.now(), SPEED_COOLDOWN_MS)) throw new Error('cooldown')
  speedPending = (async () => {
    await chrome.storage.session.set({ speedStartedAt: Date.now() })
    void renderAll()
    let result
    try {
      const { bytes, elapsed } = await request(
        `${ENDPOINTS.speed}${SAMPLE_BYTES}`,
        20000,
        async (response) => {
          const reader = response.body.getReader()
          const started = performance.now()
          let total = 0
          try {
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              total += value.byteLength
              if (total > SAMPLE_BYTES) throw new Error('Amostra maior que o pedido')
            }
          } finally {
            await reader.cancel().catch(() => undefined)
          }
          if (total !== SAMPLE_BYTES) throw new Error('Amostra incompleta')
          return { bytes: total, elapsed: performance.now() - started }
        },
      )
      result = { mbps: core.mbps(bytes, elapsed), at: Date.now(), error: false }
    } catch {
      result = { mbps: null, at: Date.now(), error: true }
    }
    await chrome.storage.session.set({ speed: result })
    return result
  })().finally(() => {
    speedPending = null
    void renderAll()
  })
  return speedPending
}

/** Uma medição automática por sessão do navegador, na primeira página com o indicador. */
async function measureOnce() {
  const { autoSpeed } = await session('autoSpeed')
  if (autoSpeed) return
  await chrome.storage.session.set({ autoSpeed: true })
  measure().catch(() => undefined)
}

/** CSS do indicador (null = desligado); `documentId` com posição provisória durante o arrasto. */
async function indicatorStyle(documentId = null) {
  const settings = await preferences()
  if (!settings.enabled || !settings.indicator) return null
  const { metrics = null, speed = null, usage: traffic = null } = await session(['metrics', 'speed', 'usage'])
  const temporary = documentId ? dragging.get(documentId) : undefined
  const text = core.indicatorText(metrics, speed, speedPending !== null, traffic?.data ?? null, language)
  return core.indicatorCss(text, temporary ?? (await savedPosition()), Boolean(temporary))
}

/**
 * Troca o CSS de um documento (remove o anterior pelo texto exato). Todo documento aberto fica
 * registrado, mesmo sem indicador: ligar o indicador depois alcança também as abas em segundo
 * plano. Precisa estar em serial().
 */
async function setDocumentStyle(documents, tabId, documentId, css) {
  const target = { tabId, documentIds: [documentId] }
  const known = documents[documentId]
  const previous = known?.css ?? null
  if (known && previous === css) return
  if (previous)
    await chrome.scripting.removeCSS({ target, css: previous, origin: 'USER' }).catch(() => undefined)
  documents[documentId] = { tabId, css: null, at: Date.now() }
  if (!css) return
  try {
    await chrome.scripting.insertCSS({ target, css, origin: 'USER' })
    documents[documentId].css = css
  } catch {
    // o documento já foi embora (navegação ou aba fechada)
    delete documents[documentId]
  }
}

async function saveDocuments(documents) {
  const entries = Object.entries(documents).sort((a, b) => b[1].at - a[1].at)
  await chrome.storage.session.set({ documents: Object.fromEntries(entries.slice(0, MAX_DOCUMENTS)) })
}

function renderDocument(tabId, documentId) {
  return serial(async () => {
    const { documents = {} } = await session('documents')
    await setDocumentStyle(documents, tabId, documentId, await indicatorStyle(documentId))
    await saveDocuments(documents)
  })
}

function renderAll() {
  return serial(async () => {
    const { documents = {} } = await session('documents')
    const css = await indicatorStyle()
    for (const [documentId, entry] of Object.entries({ ...documents })) {
      const own = dragging.has(documentId) ? await indicatorStyle(documentId) : css
      await setDocumentStyle(documents, entry.tabId, documentId, own)
    }
    await saveDocuments(documents)
  })
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void serial(async () => {
    const { documents = {} } = await session('documents')
    for (const [documentId, entry] of Object.entries(documents))
      if (entry.tabId === tabId) delete documents[documentId]
    await saveDocuments(documents)
  })
})

/**
 * Página aberta ou de volta à frente (e a cada 10 s com ela visível): mostra o indicador na
 * hora e atualiza todos quando a consulta (com cache) traz algo novo.
 */
async function onPage(sender) {
  await renderDocument(sender.tab.id, sender.documentId)
  const settings = await preferences()
  if (!settings.enabled || !settings.indicator) return
  await Promise.all([probe(), usage()])
  void measureOnce()
  // o CSS só é trocado nos documentos em que o texto mudou
  await renderAll()
}

function cosmetics() {
  cosmeticData ??= fetch(chrome.runtime.getURL('cosmetic.json'))
    .then((response) => response.json())
    .catch((error) => {
      cosmeticData = null
      throw error
    })
  return cosmeticData
}

/**
 * Esconde os espaços de anúncio como o uBlock Origin: na carga da página, os seletores do
 * próprio site e os genéricos amplos; depois, os genéricos das classes e ids que a página tem
 * (o content script só lê o DOM). Folha de estilo de usuário: a página não ganha nenhum nó.
 */
async function onCosmetic(sender, tokens) {
  const settings = await preferences()
  if (!settings.enabled || !settings.adblock) return
  let hostname
  try {
    hostname = new URL(sender.url).hostname
  } catch {
    return
  }
  if (!hostname) return
  const data = await cosmetics()
  let done = cosmeticDocuments.get(sender.documentId)
  if (!done) {
    done = new Set()
    cosmeticDocuments.set(sender.documentId, done)
    if (cosmeticDocuments.size > MAX_DOCUMENTS)
      cosmeticDocuments.delete(cosmeticDocuments.keys().next().value)
  }
  let selectors = []
  if (!done.has('')) {
    done.add('')
    selectors = core.cosmeticSelectors(data, hostname, null)
  }
  const fresh = (Array.isArray(tokens) ? tokens : []).filter(
    (token) => typeof token === 'string' && token.length < 200 && !done.has(token),
  )
  for (const token of fresh) done.add(token)
  if (fresh.length) selectors = selectors.concat(core.cosmeticSelectors(data, hostname, fresh))
  if (selectors.length === 0) return
  await chrome.scripting
    .insertCSS({
      target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
      css: core.hidingCss(selectors),
      origin: 'USER',
    })
    .catch(() => undefined)
}

/** Arrasto do indicador: posição provisória neste documento e, ao soltar, salva para todos. */
async function onMove(sender, message) {
  const where = core.position(message.position)
  if (message.done) {
    dragging.delete(sender.documentId)
    await chrome.storage.local.set({ position: where })
    await renderAll()
    return
  }
  dragging.set(sender.documentId, where)
  await renderDocument(sender.tab.id, sender.documentId)
}

async function status(refresh) {
  const settings = await preferences()
  if (refresh && settings.enabled) {
    await Promise.all([probe(), usage()])
    void renderAll()
  }
  const { metrics = null, speed = null, usage: traffic = null } = await session(['metrics', 'speed', 'usage'])
  return { settings, metrics, speed, usage: traffic?.data ?? null, measuring: speedPending !== null }
}

async function update(patch) {
  if (!core.validPatch(patch)) throw new Error('Preferências inválidas')
  await serial(async () => {
    const previous = await preferences()
    const settings = core.settings({ ...previous, ...patch })
    await applyBrowserSettings(settings)
    try {
      await chrome.storage.local.set({ settings })
    } catch (error) {
      await applyBrowserSettings(previous)
      throw error
    }
    if (!settings.enabled) for (const controller of controllers) controller.abort()
  })
  await renderAll()
  return status(false)
}

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object')
    throw new Error('Remetente inválido')
  if (sender.tab && sender.frameId === 0 && sender.documentId) {
    if (message.type === 'PAGE') return onPage(sender).then(() => null)
    if (message.type === 'COSMETIC') return onCosmetic(sender, message.tokens).then(() => null)
    if (message.type === 'MOVE') return onMove(sender, message).then(() => null)
  }
  if (sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('Mensagem não permitida')
  if (message.type === 'STATUS') return status(message.refresh === true)
  if (message.type === 'SET') return update(message.settings)
  if (message.type === 'RESET_POSITION') {
    await chrome.storage.local.set({ position: core.DEFAULT_POSITION })
    await renderAll()
    return status(false)
  }
  if (message.type === 'MEASURE') {
    if (!(await preferences()).enabled) throw new Error('disabled')
    await measure()
    return status(false)
  }
  throw new Error('Mensagem desconhecida')
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(
    (data) => respond({ ok: true, data }),
    (error) => respond({ ok: false, error: error?.message === 'cooldown' ? 'cooldown' : 'unavailable' }),
  )
  return true
})
