import fs from 'node:fs'
import path, { resolve } from 'node:path'
import type { Protocol } from 'devtools-protocol'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { preparePreferences } from '@main/browser/preferences'
import { replaceStartupTab } from '@main/browser/launcher'
import type { CdpClient } from '@main/browser/cdp/client'
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

/** Navegador falso: abas da janela e as chamadas recebidas, na ordem. */
function fakeBrowser(initial: Protocol.Target.TargetInfo[], options: { createFails?: boolean } = {}) {
  let pages = [...initial]
  let next = 0
  const calls: string[] = []
  const send = vi.fn(async (method: string, params?: { targetId?: string; url?: string }) => {
    calls.push(method === 'Target.getTargets' ? method : `${method} ${params?.targetId ?? params?.url}`)
    switch (method) {
      case 'Target.getTargets':
        return { targetInfos: [...pages] }
      case 'Target.createTarget': {
        if (options.createFails) throw new Error('sem janela')
        const targetId = `nova-${++next}`
        pages.push(page(targetId, params!.url!))
        return { targetId }
      }
      case 'Target.closeTarget':
        pages = pages.filter((target) => target.targetId !== params!.targetId)
        return { success: true }
      default:
        throw new Error(`inesperado: ${method}`)
    }
  })
  return {
    client: { send } as unknown as CdpClient,
    calls,
    pages: () => pages.map((target) => `${target.targetId} ${target.url}`),
    open: (target: Protocol.Target.TargetInfo) => pages.push(target),
  }
}
function page(targetId: string, url: string, type = 'page'): Protocol.Target.TargetInfo {
  return { targetId, type, url, title: url, attached: false, canAccessOpener: false }
}

describe('troca da primeira aba do Brave (barra do flag)', () => {
  it('abre a aba nova antes de fechar a primeira e não mexe nas outras abas', async () => {
    const browser = fakeBrowser([
      page('worker', 'chrome-extension://abc/bg.js', 'service_worker'),
      page('inicial', 'about:blank'),
      page('boas-vindas', 'chrome-extension://abc/welcome.html'),
    ])
    const warn = vi.fn()
    // devolve a aba fechada: ela ainda pode aparecer na lista seguinte e precisa ser ignorada
    expect(
      await replaceStartupTab(browser.client, new AbortController().signal, { ...silentLogger, warn }),
    ).toEqual(['inicial'])
    expect(browser.calls).toEqual([
      'Target.getTargets',
      'Target.createTarget about:blank',
      'Target.closeTarget inicial',
    ])
    expect(browser.pages()).toEqual([
      'worker chrome-extension://abc/bg.js',
      'boas-vindas chrome-extension://abc/welcome.html',
      'nova-1 about:blank',
    ])
    expect(warn).not.toHaveBeenCalled()
  })

  it('espera a primeira aba aparecer', async () => {
    const browser = fakeBrowser([])
    setTimeout(() => browser.open(page('inicial', 'about:blank')), 150)
    expect(await replaceStartupTab(browser.client, new AbortController().signal, silentLogger)).toEqual([
      'inicial',
    ])
    expect(browser.pages()).toEqual(['nova-1 about:blank'])
  })

  it('sem a primeira aba no prazo, ou se a aba nova falha, só avisa (a janela nunca fica sem aba)', async () => {
    const empty = fakeBrowser([page('site', 'https://example.com/')])
    const warn = vi.fn()
    expect(
      await replaceStartupTab(empty.client, new AbortController().signal, { ...silentLogger, warn }, 200),
    ).toEqual([])
    expect(empty.calls.every((call) => call === 'Target.getTargets')).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)

    const failing = fakeBrowser([page('inicial', 'about:blank')], { createFails: true })
    expect(
      await replaceStartupTab(failing.client, new AbortController().signal, { ...silentLogger, warn }),
    ).toEqual([])
    expect(failing.pages()).toEqual(['inicial about:blank'])
    expect(failing.calls.some((call) => call.startsWith('Target.closeTarget'))).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('abertura cancelada interrompe a troca com o erro do cancelamento', async () => {
    const browser = fakeBrowser([])
    const controller = new AbortController()
    const replacing = replaceStartupTab(browser.client, controller.signal, silentLogger)
    controller.abort(new Error('cancelada'))
    await expect(replacing).rejects.toThrow('cancelada')
    expect(browser.calls.some((call) => call.startsWith('Target.createTarget'))).toBe(false)
  })
})
