import { useEffect, useState } from 'react'

export type EffectiveTheme = 'light' | 'dark'

const QUERY = '(prefers-color-scheme: dark)'

/**
 * O processo principal define `nativeTheme.themeSource` a partir da
 * configuração (claro, escuro ou sistema), e o Chromium reflete isso no
 * `prefers-color-scheme`. Este hook só acompanha a media query e mantém a
 * classe `dark` do <html> em sincronia.
 */
export function useThemeSync(): EffectiveTheme {
  const [dark, setDark] = useState(() => window.matchMedia(QUERY).matches)

  useEffect(() => {
    const media = window.matchMedia(QUERY)
    const onChange = (): void => setDark(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('dark', dark)
    root.style.colorScheme = dark ? 'dark' : 'light'
  }, [dark])

  return dark ? 'dark' : 'light'
}
