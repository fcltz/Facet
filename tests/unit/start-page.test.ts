import fs from 'node:fs'
import path, { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { preparePreferences } from '@main/browser/preferences'
import { silentLogger } from '@main/logger'
import { appSettingsSchema, DEFAULT_SETTINGS, settingsPatchSchema } from '@shared/schemas/settings'

describe('página inicial dos perfis', () => {
  const startPage = appSettingsSchema.shape.startPage
  const problem = (value: string): string | undefined => {
    const parsed = startPage.safeParse(value)
    return parsed.success ? undefined : parsed.error.issues[0]?.message
  }

  it('padrão browserscan.net; aceita vazio (página em branco) e http/https, sem espaços nas pontas', () => {
    expect(DEFAULT_SETTINGS.startPage).toBe('https://browserscan.net/')
    expect(appSettingsSchema.parse(DEFAULT_SETTINGS).startPage).toBe('https://browserscan.net/')
    expect(startPage.parse('')).toBe('')
    expect(startPage.parse('   ')).toBe('')
    expect(startPage.parse('  https://example.com/teste?a=1  ')).toBe('https://example.com/teste?a=1')
    expect(startPage.parse('http://127.0.0.1:8080/')).toBe('http://127.0.0.1:8080/')
    expect(settingsPatchSchema.parse({ startPage: '' })).toEqual({ startPage: '' })
  })

  it('recusa endereço sem http/https e texto longo demais', () => {
    for (const value of [
      'browserscan.net',
      'about:blank',
      'javascript:alert(1)',
      'file:///C:/Windows/win.ini',
      'chrome://settings',
      'ftp://example.com/',
    ])
      expect(problem(value)).toBe('invalidUrl')
    expect(problem(`https://example.com/${'a'.repeat(2048)}`)).toBe('tooLong')
  })
})

describe('aviso P3A do Brave', () => {
  let root: string
  beforeAll(() => {
    fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
    root = fs.mkdtempSync(resolve('.tmp-tests', 'start-page-'))
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  it('marca o aviso como visto e desliga a coleta, sem perder o resto do Local State', () => {
    const directory = path.join(root, 'perfil')
    fs.mkdirSync(directory, { recursive: true })
    const file = path.join(directory, 'Local State')
    fs.writeFileSync(
      file,
      JSON.stringify({ brave: { p3a: { enabled: true, outro: 1 }, stats: { x: 2 } }, outro: true }),
    )
    preparePreferences(directory, ['pt-BR'], silentLogger, { browser: 'brave' })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      background_mode: { enabled: false },
      brave: { p3a: { enabled: false, notice_acknowledged: true, outro: 1 }, stats: { x: 2 } },
      outro: true,
    })
  })
})
