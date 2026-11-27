import { describe, expect, it } from 'vitest'
import { en } from '../../src/renderer/i18n/en'
import { es } from '../../src/renderer/i18n/es'
import { ptBR } from '../../src/renderer/i18n/pt-BR'
import { interfaceLanguageFor } from '@shared/schemas/settings'

function messages(value: object, prefix = ''): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const path = prefix ? `${prefix}.${key}` : key
      return typeof entry === 'string' ? [[path, entry]] : Object.entries(messages(entry, path))
    }),
  )
}

describe('Idiomas da interface', () => {
  it('considera variantes regionais e a ordem de preferência, ignorando idiomas não suportados', () => {
    expect(interfaceLanguageFor(['fr-FR', 'es-MX', 'en-US'])).toBe('es')
    expect(interfaceLanguageFor(['pt_PT', 'es'])).toBe('pt-BR')
    expect(interfaceLanguageFor([' EN-gb ', 'pt-BR'])).toBe('en')
    expect(interfaceLanguageFor(['de-DE', 'fr'])).toBeNull()
    expect(interfaceLanguageFor([])).toBeNull()
  })

  for (const [language, dictionary] of Object.entries({ en, es })) {
    it(`${language}: todas as mensagens existem e preservam os parâmetros interpolados`, () => {
      const source = messages(ptBR)
      const translated = messages(dictionary)
      expect(Object.keys(translated).sort()).toEqual(Object.keys(source).sort())
      for (const [key, value] of Object.entries(source)) {
        expect(translated[key]!.trim(), key).not.toBe('')
        expect(translated[key]!.match(/\{\{[^}]+\}\}/g)?.sort() ?? [], key).toEqual(
          value.match(/\{\{[^}]+\}\}/g)?.sort() ?? [],
        )
      }
    })
  }
})
