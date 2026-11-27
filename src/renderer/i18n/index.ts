import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { isLanguage } from '@shared/constants'
import type { Language } from '@shared/schemas/settings'
import { en } from './en'
import { es } from './es'
import { ptBR, type Translation } from './pt-BR'

export const resources = {
  'pt-BR': { translation: ptBR },
  en: { translation: en },
  es: { translation: es },
} as const

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: Translation }
  }
}

export function initI18n(language: Language): void {
  void i18next.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: 'pt-BR',
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false,
  })
  document.documentElement.lang = language
}

export function setLanguage(language: Language): void {
  if (i18next.language !== language) void i18next.changeLanguage(language)
  document.documentElement.lang = language
}

export function currentLanguage(): Language {
  return isLanguage(i18next.language) ? i18next.language : 'pt-BR'
}

/**
 * Tradução de chave montada em tempo de execução (códigos de erro, mensagens de
 * validação). Se a chave não existir, devolve o `fallback` (ou a própria chave).
 */
export function tr(key: string, fallback?: string, options?: Record<string, unknown>): string {
  if (!i18next.exists(key)) return fallback ?? key
  const translate = i18next.t as unknown as (k: string, o?: Record<string, unknown>) => string
  return translate(key, options)
}
