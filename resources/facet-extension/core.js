/*
 * Funções puras da extensão Facet, usadas pelo service worker, pelo content script, pelo popup
 * e pelos testes. Nada da navegação é coletado nem enviado: só o IP de saída, a velocidade e o
 * gasto da proxy (que o proxy local do Facet informa) são consultados.
 */
globalThis.FacetCore = (() => {
  const DEFAULTS = Object.freeze({ enabled: true, adblock: true, optimize: true, indicator: true })
  /** Posição do indicador: frações da tela a partir do canto inferior esquerdo (0 a 1). */
  const DEFAULT_POSITION = Object.freeze({ x: 0, y: 0 })
  /** Rulesets compilados das listas do uBlock Origin (scripts/build-facet-filters.mjs). */
  const FILTER_RULESETS = Object.freeze(['ads', 'privacy', 'malware', 'unbreak'])
  /** Margem do indicador até a borda da janela, em px. */
  const MARGIN = 8
  /** Consultas feitas pelo próprio navegador: passam pelo proxy do perfil. */
  const ENDPOINTS = Object.freeze({
    trace: 'https://www.cloudflare.com/cdn-cgi/trace',
    speed: 'https://speed.cloudflare.com/__down?bytes=',
    /** Proxy local do Facet: responde só a esta extensão, sem repassar à proxy (sem proxy, falha). */
    usage: 'http://usage.facet.test/',
  })
  /** Id da regra de sessão que libera os pedidos da própria extensão (ver `ownRequestsRule`). */
  const OWN_REQUESTS_RULE_ID = 1

  /**
   * Regra de sessão que libera as consultas da própria extensão. O EasyPrivacy (lista de
   * privacidade) bloqueia `||cloudflare.com/cdn-cgi/trace` vindo de terceiros, e o service
   * worker da extensão conta como terceiro: sem esta regra o indicador ficava "Sem conexão".
   * `tabIds: [-1]` = pedidos que não vêm de nenhuma aba (só o service worker): nas páginas, o
   * trace continua bloqueado. Prioridade acima das regras das listas (1 a 3).
   */
  function ownRequestsRule() {
    return {
      id: OWN_REQUESTS_RULE_ID,
      priority: 100,
      action: { type: 'allow' },
      condition: {
        tabIds: [-1],
        requestDomains: [...new Set(Object.values(ENDPOINTS).map((url) => new URL(url).hostname))],
      },
    }
  }

  /** Preferências salvas, completadas com os padrões (tudo ligado). */
  function settings(value) {
    return Object.fromEntries(
      Object.entries(DEFAULTS).map(([key, fallback]) => [
        key,
        typeof value?.[key] === 'boolean' ? value[key] : fallback,
      ]),
    )
  }

  /** Patch válido do popup: só chaves conhecidas e valores booleanos. */
  function validPatch(patch) {
    return (
      patch !== null &&
      typeof patch === 'object' &&
      !Array.isArray(patch) &&
      Object.keys(patch).length > 0 &&
      Object.entries(patch).every(([key, value]) => key in DEFAULTS && typeof value === 'boolean')
    )
  }

  function clamp(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  }

  function position(value) {
    return { x: clamp(value?.x), y: clamp(value?.y) }
  }

  function ip(value) {
    if (typeof value !== 'string' || value.length > 45) return null
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(value))
      return value.split('.').every((part) => Number(part) <= 255) ? value : null
    if (!value.includes(':') || !/^[a-f0-9:.]+$/i.test(value)) return null
    try {
      new URL(`http://[${value}]/`)
      return value.toLowerCase()
    } catch {
      return null
    }
  }

  /** Resposta do /cdn-cgi/trace da Cloudflare: `ip=…` e `loc=XX` (país). */
  function trace(text) {
    if (typeof text !== 'string') return null
    const address = ip(/^ip=(.+)$/m.exec(text)?.[1]?.trim())
    if (!address) return null
    const country = /^loc=([A-Z]{2})$/m.exec(text)?.[1] ?? null
    return { ip: address, country: country === 'XX' ? null : country }
  }

  /** Resposta do proxy local do Facet com o gasto da proxy (null = inválida). */
  function usage(value) {
    if (!value || typeof value !== 'object') return null
    const total = Number(value.total)
    const rate = Number(value.bytesPerSecond)
    if (!Number.isFinite(total) || total < 0) return null
    return { total, bytesPerSecond: Number.isFinite(rate) && rate >= 0 ? rate : 0 }
  }

  function mbps(bytes, elapsedMs) {
    return Number.isFinite(bytes) && bytes > 0 && Number.isFinite(elapsedMs) && elapsedMs > 0
      ? (bytes * 8) / elapsedMs / 1000
      : null
  }

  function fresh(result, now, ttl) {
    return Boolean(result) && Number.isFinite(result.at) && result.at <= now && now - result.at < ttl
  }

  /** Idioma dos textos: português, espanhol ou inglês (o resto). */
  function locale(language) {
    const value = String(language || '').toLowerCase()
    return value.startsWith('pt') ? 'pt' : value.startsWith('es') ? 'es' : 'en'
  }

  function number(value, digits, language) {
    return value.toLocaleString({ pt: 'pt-BR', es: 'es-ES', en: 'en-US' }[locale(language)], {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
  }

  /** "23,4" / "23.4"; a partir de 100 Mbps, sem casas decimais. */
  function formatMbps(value, language) {
    return number(value, value >= 100 ? 0 : 1, language)
  }

  /** Bytes em base 1024 ("152 MB", "1,4 GB"). */
  function formatBytes(bytes, language) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024
      unit++
    }
    return `${number(value, unit === 0 || value >= 100 ? 0 : 1, language)} ${units[unit]}`
  }

  function words(language) {
    const current = locale(language)
    if (current === 'es')
      return {
        title: 'Facet',
        scope: 'Opciones de este perfil',
        enabled: 'Facet activada',
        adblock: 'Bloquear anuncios',
        adblockHint:
          'Filtros de uBlock Origin (uBlock filters, EasyList, EasyPrivacy, Peter Lowe y URLhaus): anuncios, rastreadores y sitios maliciosos, incluidos los espacios vacíos de los anuncios.',
        optimize: 'Ahorrar recursos',
        optimizeHint:
          'Desactiva la precarga de páginas y las balizas de rastreo de terceros: menos CPU, memoria y datos del proxy.',
        indicator: 'Mostrar IP y conexión',
        indicatorHint:
          'En una esquina de la página, sin cambiar su contenido. Mantén pulsado y arrastra para moverlo.',
        connection: 'Conexión de este perfil',
        ip: 'IP pública',
        latency: 'Latencia',
        speed: 'Descarga',
        usage: 'Consumo del proxy (sesión)',
        noProxy: 'Sin proxy',
        measure: 'Medir velocidad',
        measuring: 'Midiendo…',
        reset: 'Devolver el indicador a la esquina',
        checking: 'Consultando…',
        offline: 'Sin conexión',
        disabled: 'Desactivada',
        failed: 'No se pudo medir',
        cooldown: 'Espera unos segundos para medir de nuevo.',
        note: 'La velocidad se mide al abrir el perfil y cuando lo pides: descarga 1 MiB a través del proxy de este perfil (Cloudflare).',
        notice: 'Listas de filtros: uBlock Origin, EasyList, Peter Lowe y URLhaus (licencias)',
      }
    return current === 'pt'
      ? {
          title: 'Facet',
          scope: 'Opções deste perfil',
          enabled: 'Facet ligada',
          adblock: 'Bloquear anúncios',
          adblockHint:
            'Filtros do uBlock Origin (uBlock filters, EasyList, EasyPrivacy, Peter Lowe e URLhaus): anúncios, rastreadores e sites maliciosos, inclusive os espaços vazios dos anúncios.',
          optimize: 'Economizar recursos',
          optimizeHint:
            'Desliga o pré-carregamento de páginas e os beacons de rastreio de terceiros: menos CPU, memória e dados do proxy.',
          indicator: 'Mostrar IP e conexão',
          indicatorHint:
            'Num canto da página, sem alterar o conteúdo dela. Segure e arraste para mudar de lugar.',
          connection: 'Conexão deste perfil',
          ip: 'IP público',
          latency: 'Latência',
          speed: 'Download',
          usage: 'Gasto da proxy (sessão)',
          noProxy: 'Sem proxy',
          measure: 'Medir velocidade',
          measuring: 'Medindo…',
          reset: 'Voltar o indicador ao canto',
          checking: 'Consultando…',
          offline: 'Sem conexão',
          disabled: 'Desligada',
          failed: 'Não foi possível medir',
          cooldown: 'Aguarde alguns segundos para medir de novo.',
          note: 'A velocidade é medida ao abrir o perfil e quando você pede: baixa 1 MiB pelo proxy deste perfil (Cloudflare).',
          notice: 'Listas de filtros: uBlock Origin, EasyList, Peter Lowe e URLhaus (licenças)',
        }
      : {
          title: 'Facet',
          scope: 'Options for this profile',
          enabled: 'Facet on',
          adblock: 'Block ads',
          adblockHint:
            "uBlock Origin's filters (uBlock filters, EasyList, EasyPrivacy, Peter Lowe and URLhaus): ads, trackers and malicious sites, including the empty ad slots.",
          optimize: 'Save resources',
          optimizeHint:
            'Turns off page preloading and third-party tracking beacons: less CPU, memory and proxy data.',
          indicator: 'Show IP and connection',
          indicatorHint: 'In a corner of the page, without changing its content. Hold and drag to move it.',
          connection: "This profile's connection",
          ip: 'Public IP',
          latency: 'Latency',
          speed: 'Download',
          usage: 'Proxy data (session)',
          noProxy: 'No proxy',
          measure: 'Measure speed',
          measuring: 'Measuring…',
          reset: 'Move the indicator back to the corner',
          checking: 'Checking…',
          offline: 'No connection',
          disabled: 'Off',
          failed: 'Measurement failed',
          cooldown: 'Wait a few seconds to measure again.',
          note: "Speed is measured when the profile opens and on request: it downloads 1 MiB through this profile's proxy (Cloudflare).",
          notice: 'Filter lists: uBlock Origin, EasyList, Peter Lowe and URLhaus (licenses)',
        }
  }

  /** Texto e tom do indicador: "BR 203.0.113.7 · 45 ms · ↓ 23,4 Mbps · ⇅ 152 MB". */
  function indicatorText(metrics, speed, measuring, traffic, language) {
    const text = words(language)
    if (!metrics) return { text: text.checking, tone: 'muted' }
    // Sem IP (consulta falhou), velocidade e gasto da proxy continuam aparecendo.
    const offline = Boolean(metrics.error || !metrics.ip)
    const parts = offline
      ? [text.offline]
      : [metrics.country ? `${metrics.country} ${metrics.ip}` : metrics.ip]
    if (!offline && Number.isFinite(metrics.latency)) parts.push(`${metrics.latency} ms`)
    if (speed && Number.isFinite(speed.mbps)) parts.push(`↓ ${formatMbps(speed.mbps, language)} Mbps`)
    else if (measuring) parts.push('↓ …')
    if (traffic && Number.isFinite(traffic.total)) parts.push(`⇅ ${formatBytes(traffic.total, language)}`)
    return { text: parts.join(' · '), tone: offline ? 'warning' : 'normal' }
  }

  /** Texto seguro dentro de uma string CSS (sem controles; aspas e barras escapadas). */
  function cssString(value) {
    const printable = [...String(value)].filter((char) => char >= ' ' && char !== '\u007f').join('')
    return `"${printable.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }

  /**
   * Folha de estilo de usuário do indicador: um pseudo-elemento da raiz, sem nenhum nó no
   * DOM da página e fora das folhas de estilo que ela enxerga. A posição é uma fração da área livre: o
   * indicador nunca sai da janela, qualquer que seja o tamanho dela ou o dele.
   */
  function indicatorCss(indicator, where = DEFAULT_POSITION, dragging = false) {
    const { x, y } = position(where)
    const color =
      indicator.tone === 'warning'
        ? '#fbbf24'
        : indicator.tone === 'muted'
          ? 'rgba(236, 238, 245, 0.7)'
          : 'rgba(236, 238, 245, 0.94)'
    return [
      'html::after {',
      '  all: initial !important;',
      `  content: ${cssString(indicator.text)} !important;`,
      '  position: fixed !important;',
      `  left: calc(${MARGIN}px + (100% - ${MARGIN * 2}px) * ${x.toFixed(4)}) !important;`,
      `  bottom: calc(${MARGIN}px + (100% - ${MARGIN * 2}px) * ${y.toFixed(4)}) !important;`,
      `  transform: translate(calc(-100% * ${x.toFixed(4)}), calc(100% * ${y.toFixed(4)})) !important;`,
      '  z-index: 2147483647 !important;',
      '  display: block !important;',
      '  box-sizing: border-box !important;',
      `  max-width: calc(100% - ${MARGIN * 2}px) !important;`,
      '  padding: 2px 7px !important;',
      '  border-radius: 6px !important;',
      `  background: rgba(15, 18, 30, ${dragging ? '0.86' : '0.68'}) !important;`,
      `  color: ${color} !important;`,
      '  font: 500 11px/16px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;',
      '  font-variant-numeric: tabular-nums !important;',
      '  white-space: nowrap !important;',
      '  overflow: hidden !important;',
      '  text-overflow: ellipsis !important;',
      `  cursor: ${dragging ? 'grabbing' : 'grab'} !important;`,
      '  user-select: none !important;',
      '  direction: ltr !important;',
      ...(dragging
        ? ['  transition: left 60ms linear, bottom 60ms linear, transform 60ms linear !important;']
        : []),
      '}',
      '@media print { html::after { content: none !important; display: none !important; } }',
    ].join('\n')
  }

  /**
   * Retângulo do indicador na janela (para o content script saber se o clique foi nele), a
   * partir do tamanho dele e da área visível. Mesmo cálculo do CSS acima.
   */
  function indicatorRect(where, size, viewport) {
    const { x, y } = position(where)
    const left = MARGIN + (viewport.width - MARGIN * 2) * x - size.width * x
    const bottomOffset = MARGIN + (viewport.height - MARGIN * 2) * y - size.height * y
    const top = viewport.height - bottomOffset - size.height
    return { left, top, right: left + size.width, bottom: top + size.height }
  }

  /** Posição em que o indicador fica com o canto superior esquerdo em (left, top). */
  function positionAt(left, top, size, viewport) {
    const freeX = viewport.width - MARGIN * 2 - size.width
    const freeY = viewport.height - MARGIN * 2 - size.height
    const bottomOffset = viewport.height - top - size.height
    return {
      x: freeX > 0 ? clamp((left - MARGIN) / freeX) : 0,
      y: freeY > 0 ? clamp((bottomOffset - MARGIN) / freeY) : 0,
    }
  }

  /** Rulesets ligados conforme as preferências (todos desligados com a Facet desligada). */
  function rulesets(value) {
    const current = settings(value)
    const enable = []
    if (current.enabled && current.adblock) enable.push(...FILTER_RULESETS)
    if (current.enabled && current.optimize) enable.push('optimize')
    return {
      enableRulesetIds: enable,
      disableRulesetIds: [...FILTER_RULESETS, 'optimize'].filter((id) => !enable.includes(id)),
    }
  }

  /** O host e os domínios acima dele ("a.b.com" → a.b.com, b.com, com). */
  function hostSuffixes(hostname) {
    const parts = String(hostname || '')
      .toLowerCase()
      .split('.')
      .filter(Boolean)
    return parts.map((_, index) => parts.slice(index).join('.'))
  }

  /**
   * Seletores cosméticos (como os do uBlock Origin) para um host: `tokens` null = os da carga
   * da página (do próprio site e genéricos amplos); com tokens (classes ".x" e ids "#y"
   * presentes na página), os genéricos que dependem deles. Exceções da lista ficam de fora.
   */
  function cosmeticSelectors(data, hostname, tokens) {
    const suffixes = hostSuffixes(hostname)
    const has = (list) => suffixes.some((host) => list.includes(host))
    const excepted = new Set(suffixes.flatMap((host) => data.exceptions[host] ?? []))
    const selected = new Set()
    if (tokens === null) {
      if (!has(data.specifichide))
        for (const host of suffixes) for (const s of data.specific[host] ?? []) selected.add(s)
      if (!has(data.generichide)) for (const s of data.highly) selected.add(s)
    } else if (!has(data.generichide)) {
      for (const token of tokens) for (const s of data.lowly[token] ?? []) selected.add(s)
    }
    return [...selected].filter((selector) => !excepted.has(selector))
  }

  /** Cada seletor numa regra própria: um seletor inválido não derruba os outros. */
  function hidingCss(selectors) {
    return selectors.map((selector) => `${selector}{display:none!important}`).join('\n')
  }

  return Object.freeze({
    DEFAULTS,
    DEFAULT_POSITION,
    FILTER_RULESETS,
    ENDPOINTS,
    OWN_REQUESTS_RULE_ID,
    ownRequestsRule,
    locale,
    settings,
    validPatch,
    position,
    ip,
    trace,
    usage,
    mbps,
    fresh,
    formatMbps,
    formatBytes,
    words,
    indicatorText,
    indicatorCss,
    indicatorRect,
    positionAt,
    cssString,
    rulesets,
    hostSuffixes,
    cosmeticSelectors,
    hidingCss,
  })
})()
