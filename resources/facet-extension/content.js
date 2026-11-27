/*
 * Content script da Facet. Não altera a página: só lê o DOM (classes e ids, para os cosméticos
 * do adblock) e trata o arrasto do indicador, que é uma folha de estilo de usuário inserida pelo
 * service worker. Os eventos de ponteiro sobre o indicador não chegam aos scripts da página.
 */
;(() => {
  if (window !== window.top) return
  const core = globalThis.FacetCore
  let alive = true
  let settings = core.settings(null)
  let where = core.DEFAULT_POSITION
  const send = (message) =>
    chrome.runtime.sendMessage(message).catch(() => {
      // extensão recarregada ou desligada: esta página para de falar com ela
      alive = false
    })

  // Indicador: a página está aberta e visível (o service worker atualiza o texto).
  const notify = () => {
    if (alive && !document.hidden) void send({ type: 'PAGE' })
  }

  // Cosméticos: cada classe e id presentes na página vai uma vez ao service worker.
  const sent = new Set()
  let pending = new Set()
  let flushTimer = null
  let observer = null
  const add = (token) => {
    if (!sent.has(token)) pending.add(token)
  }
  const collectElement = (element) => {
    if (element.id) add(`#${element.id}`)
    for (const name of element.classList ?? []) add(`.${name}`)
  }
  const collectTree = (node) => {
    if (node.nodeType !== 1) return
    collectElement(node)
    for (const element of node.querySelectorAll('[id],[class]')) collectElement(element)
  }
  const flush = () => {
    flushTimer = null
    if (!alive || pending.size === 0) return
    const tokens = [...pending]
    pending = new Set()
    for (const token of tokens) sent.add(token)
    void send({ type: 'COSMETIC', tokens })
  }
  const schedule = () => {
    flushTimer ??= setTimeout(flush, 250)
  }
  const startCosmetics = () => {
    if (observer || !alive) return
    const survey = () => {
      if (document.documentElement) collectTree(document.documentElement)
      schedule()
    }
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', survey, { once: true })
    else survey()
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') collectElement(record.target)
        else for (const node of record.addedNodes) collectTree(node)
      }
      if (pending.size) schedule()
    })
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'id'],
    })
  }
  const stopCosmetics = () => {
    observer?.disconnect()
    observer = null
  }

  // Arrasto do indicador (segurar e arrastar). Nada é escrito na página: a posição vai para o
  // service worker, que troca a folha de estilo.
  let press = null
  let lastMove = 0
  let swallowClick = false
  const viewport = () => ({
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
  })
  const indicatorBox = () => {
    if (!settings.enabled || !settings.indicator || !document.documentElement) return null
    const computed = getComputedStyle(document.documentElement, '::after')
    if (!computed.content || computed.content === 'none' || computed.content === 'normal') return null
    const size = { width: parseFloat(computed.width), height: parseFloat(computed.height) }
    if (!(size.width > 0 && size.height > 0)) return null
    const view = viewport()
    return { size, rect: core.indicatorRect(where, size, view) }
  }
  const inside = (event, rect) =>
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  const swallow = (event) => {
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (!alive || event.button !== 0 || !event.isPrimary) return
      const box = indicatorBox()
      if (!box || !inside(event, box.rect)) return
      swallow(event)
      swallowClick = true
      press = {
        size: box.size,
        offsetX: event.clientX - box.rect.left,
        offsetY: event.clientY - box.rect.top,
        startX: event.clientX,
        startY: event.clientY,
        moved: false,
        position: where,
      }
    },
    true,
  )
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!press) return
      swallow(event)
      if (!press.moved && Math.hypot(event.clientX - press.startX, event.clientY - press.startY) < 3) return
      press.moved = true
      press.position = core.positionAt(
        event.clientX - press.offsetX,
        event.clientY - press.offsetY,
        press.size,
        viewport(),
      )
      const now = performance.now()
      if (now - lastMove >= 40) {
        lastMove = now
        void send({ type: 'MOVE', position: press.position })
      }
    },
    true,
  )
  const finish = (event) => {
    if (!press) return
    if (event) swallow(event)
    const { moved, position } = press
    press = null
    if (moved) {
      where = position
      void send({ type: 'MOVE', position, done: true })
    }
    // o clique que fecha o gesto chega logo depois do pointerup
    setTimeout(() => {
      swallowClick = false
    }, 0)
  }
  window.addEventListener('pointerup', finish, true)
  window.addEventListener('pointercancel', finish, true)
  window.addEventListener('blur', () => finish(null))
  window.addEventListener(
    'click',
    (event) => {
      if (swallowClick) swallow(event)
    },
    true,
  )
  for (const type of ['dblclick', 'auxclick'])
    window.addEventListener(
      type,
      (event) => {
        const box = indicatorBox()
        if (box && inside(event, box.rect)) swallow(event)
      },
      true,
    )
  window.addEventListener(
    'selectstart',
    (event) => {
      if (press) swallow(event)
    },
    true,
  )

  // Preferências do perfil (popup) e posição salva.
  const applySettings = (value) => {
    settings = core.settings(value)
    if (settings.enabled && settings.adblock) startCosmetics()
    else stopCosmetics()
  }
  // os cosméticos da carga da página vão na hora (o service worker confere as preferências)
  void send({ type: 'COSMETIC', tokens: [] })
  chrome.storage.local
    .get(['settings', 'position'])
    .then((stored) => {
      where = core.position(stored.position)
      applySettings(stored.settings)
    })
    .catch(() => undefined)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes.position) where = core.position(changes.position.newValue)
    if (changes.settings) {
      applySettings(changes.settings.newValue)
      if (settings.enabled && settings.adblock) void send({ type: 'COSMETIC', tokens: [] })
      notify()
    }
  })
  notify()
  setInterval(notify, 10000)
  document.addEventListener('visibilitychange', notify)
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) notify()
  })
})()
