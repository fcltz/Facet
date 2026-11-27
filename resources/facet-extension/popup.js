const core = globalThis.FacetCore
const language = navigator.language
const words = core.words(language)
const keys = Object.keys(core.DEFAULTS)
const element = (id) => document.getElementById(id)

document.documentElement.lang = { pt: 'pt-BR', es: 'es', en: 'en' }[core.locale(language)]
for (const node of document.querySelectorAll('[data-text]')) node.textContent = words[node.dataset.text]
element('enabled').setAttribute('aria-label', words.enabled)

let busy = false
let current = core.settings(null)

function render(data) {
  current = data.settings
  for (const key of keys) {
    const input = element(key)
    input.checked = current[key]
    input.disabled = busy || (key !== 'enabled' && !current.enabled)
  }
  const { metrics, speed } = data
  const ip = element('ip')
  ip.classList.toggle('warning', Boolean(current.enabled && metrics?.error))
  ip.textContent = !current.enabled
    ? words.disabled
    : !metrics
      ? words.checking
      : metrics.error
        ? words.offline
        : [metrics.country, metrics.ip].filter(Boolean).join(' · ')
  element('latency').textContent =
    current.enabled && Number.isFinite(metrics?.latency) ? `${metrics.latency} ms` : '—'
  element('speed').textContent = !current.enabled
    ? '—'
    : data.measuring
      ? words.measuring
      : Number.isFinite(speed?.mbps)
        ? `${core.formatMbps(speed.mbps, language)} Mbps`
        : speed?.error
          ? words.failed
          : '—'
  element('usage').textContent = !current.enabled
    ? '—'
    : data.usage
      ? `${core.formatBytes(data.usage.total, language)} · ${core.formatBytes(data.usage.bytesPerSecond, language)}/s`
      : words.noProxy
  const measure = element('measure')
  measure.disabled = busy || !current.enabled || data.measuring
  measure.textContent = data.measuring ? words.measuring : words.measure
  element('reset').disabled = busy || !current.enabled || !current.indicator
}

async function send(message) {
  const result = await chrome.runtime.sendMessage(message)
  if (!result?.ok) throw new Error(result?.error === 'cooldown' ? words.cooldown : words.failed)
  return result.data
}

async function run(message) {
  busy = true
  element('error').textContent = ''
  for (const input of document.querySelectorAll('input, button')) input.disabled = true
  if (message.type === 'MEASURE') element('measure').textContent = words.measuring
  try {
    const data = await send(message)
    busy = false
    render(data)
    if (message.type === 'MEASURE' && data.speed?.error) element('error').textContent = words.failed
  } catch (error) {
    busy = false
    element('error').textContent = error.message
    try {
      render(await send({ type: 'STATUS', refresh: false }))
    } catch {
      // janela do popup fechando
    }
  }
}

for (const key of keys)
  element(key).addEventListener('change', (event) => {
    void run({ type: 'SET', settings: { [key]: event.target.checked } })
  })
element('measure').addEventListener('click', () => void run({ type: 'MEASURE' }))
element('reset').addEventListener('click', () => void run({ type: 'RESET_POSITION' }))
void run({ type: 'STATUS', refresh: true })
