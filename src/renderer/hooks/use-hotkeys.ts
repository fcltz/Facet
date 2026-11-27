import { useEffect, useRef } from 'react'

export interface Hotkey {
  /** Ex.: "mod+n", "mod+shift+n", "delete", "escape", "mod+1", "?". `mod` = Ctrl (Cmd no macOS). */
  combo: string
  handler: (event: KeyboardEvent) => void
  /** Por padrão atalhos não disparam enquanto o usuário digita num campo. */
  allowInInputs?: boolean
  enabled?: boolean
}

const isMac = window.api.platform === 'darwin'

interface ParsedCombo {
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
}

const KEY_ALIASES: Record<string, string> = { del: 'delete', esc: 'escape', space: ' ' }

function parseCombo(combo: string): ParsedCombo {
  const parts = combo.toLowerCase().split('+')
  const rawKey = parts[parts.length - 1] ?? ''
  return {
    key: KEY_ALIASES[rawKey] ?? rawKey,
    mod: parts.includes('mod'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt'),
  }
}

function matches(parsed: ParsedCombo, event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  const mod = isMac ? event.metaKey : event.ctrlKey
  if (parsed.mod !== mod || parsed.alt !== event.altKey) return false
  // símbolos como "?" já exigem Shift no teclado; só letras/dígitos conferem o Shift
  const isSymbol = parsed.key.length === 1 && !/[a-z0-9]/.test(parsed.key)
  if (!isSymbol && parsed.shift !== event.shiftKey) return false
  if (key === parsed.key) return true
  // Ctrl+1 com layouts que alteram event.key: confere pelo código físico da tecla
  return /^[0-9]$/.test(parsed.key) && event.code === `Digit${parsed.key}`
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(type)
  }
  return target.getAttribute('role') === 'combobox'
}

/** Atalhos globais (registrados uma vez; os handlers sempre veem o estado mais recente). */
export function useHotkeys(hotkeys: Hotkey[]): void {
  const ref = useRef(hotkeys)

  useEffect(() => {
    ref.current = hotkeys
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      for (const hotkey of ref.current) {
        if (hotkey.enabled === false) continue
        if (!matches(parseCombo(hotkey.combo), event)) continue
        if (!hotkey.allowInInputs && isEditableTarget(event.target)) continue
        event.preventDefault()
        hotkey.handler(event)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

/** Teclas para exibir num <Kbd>: "mod+shift+n" → ["Ctrl", "Shift", "N"]. */
export function comboKeys(combo: string): string[] {
  const labels: Record<string, string> = {
    mod: isMac ? '⌘' : 'Ctrl',
    shift: isMac ? '⇧' : 'Shift',
    alt: isMac ? '⌥' : 'Alt',
    delete: 'Del',
    escape: 'Esc',
    enter: 'Enter',
  }
  return combo.split('+').map((part) => labels[part.toLowerCase()] ?? part.toUpperCase())
}
