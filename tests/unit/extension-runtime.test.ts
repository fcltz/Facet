import type { Protocol } from 'devtools-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { CdpClient } from '@main/browser/cdp/client'
import { canonicalJson } from '@main/extensions/autoconfig'
import { ExtensionRuntime, type ExtensionLaunch } from '@main/extensions/runtime'
import { StartupTabGuard } from '@main/extensions/startup-tabs'
import type { ExtensionStore } from '@main/extensions/store'
import { silentLogger } from '@main/logger'
import { createMemoryRepositories } from '@main/repositories/mock/memory'
import { createMockSeed } from '@main/repositories/mock/seed'
import { FACET_EXTENSION_ID } from '@shared/facet-extension'
import { DEFAULT_SETTINGS } from '@shared/schemas/settings'

type Listener = (params: unknown) => void

/** CDP falso: só o necessário para a guarda de abas e a conferência das extensões. */
class FakeClient {
  targets: Protocol.Target.TargetInfo[] = []
  extensions: { id: string; enabled: boolean }[] = []
  closed: string[] = []
  private listeners = new Map<string, Set<Listener>>()

  on(method: string, listener: Listener): () => void {
    const set = this.listeners.get(method) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(method, set)
    return () => set.delete(listener)
  }

  send(method: string, params?: { targetId?: string }): Promise<unknown> {
    switch (method) {
      case 'Target.setDiscoverTargets':
        return Promise.resolve({})
      case 'Target.getTargets':
        return Promise.resolve({ targetInfos: this.targets })
      case 'Target.closeTarget':
        this.closed.push(params?.targetId ?? '')
        this.targets = this.targets.filter((target) => target.targetId !== params?.targetId)
        return Promise.resolve({ success: true })
      case 'Extensions.getExtensions':
        return Promise.resolve({ extensions: this.extensions })
      default:
        return Promise.reject(new Error(`Método não simulado: ${method}`))
    }
  }

  page(targetId: string, url: string, openerId?: string): Protocol.Target.TargetInfo {
    const info = {
      targetId,
      type: 'page',
      title: '',
      url,
      attached: false,
      canAccessOpener: false,
      ...(openerId ? { openerId } : {}),
    } as Protocol.Target.TargetInfo
    this.targets.push(info)
    for (const listener of this.listeners.get('Target.targetCreated') ?? []) listener({ targetInfo: info })
    return info
  }

  asClient(): CdpClient {
    return this as unknown as CdpClient
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('guarda das abas de boas-vindas', () => {
  it('fecha as abas abertas pelas extensões e mantém as do Facet, do usuário e popups', async () => {
    const client = new FakeClient()
    client.page('blank', 'about:blank')
    client.page('welcome', 'chrome-extension://aaaa/welcome.html')
    const guard = new StartupTabGuard(client.asClient(), { windowMs: 10_000, logger: silentLogger })
    await guard.start()
    client.page('start', 'http://127.0.0.1:8080/')
    guard.keep('start')
    client.page('popup', 'https://site.example/popup', 'start')
    client.page('newtab', 'chrome://newtab/')
    guard.arm()
    client.page('external', 'https://extension.example/obrigado')
    // o popup do ícone da Facet (aba no CDP, sem opener) aberto pelo usuário nos primeiros segundos
    client.page('facet', `chrome-extension://${FACET_EXTENSION_ID}/popup.html`)
    await vi.waitFor(() => expect(client.closed.sort()).toEqual(['external', 'welcome']))
    expect(client.targets.map((target) => target.targetId).sort()).toEqual([
      'blank',
      'facet',
      'newtab',
      'popup',
      'start',
    ])
    guard.stop()
    client.page('later', 'https://extension.example/depois')
    await flush()
    expect(client.closed).not.toContain('later')
  })

  it('nunca fecha a última aba e não faz nada antes de armar', async () => {
    const client = new FakeClient()
    client.page('only-welcome', 'chrome-extension://aaaa/welcome.html')
    client.page('second-welcome', 'https://extension.example/bem-vindo')
    const guard = new StartupTabGuard(client.asClient(), { windowMs: 10_000, logger: silentLogger })
    await guard.start()
    await flush()
    expect(client.closed).toEqual([])
    guard.arm()
    await vi.waitFor(() => expect(client.closed).toHaveLength(1))
    expect(client.targets).toHaveLength(1)
    guard.stop()
  })
})

describe('conferência das extensões carregadas', () => {
  function setup(closeTabs = true) {
    const repos = createMemoryRepositories(
      createMockSeed({ now: 1, activeProfiles: 0, trashedProfiles: 0 }),
      {
        load: () => ({ ...DEFAULT_SETTINGS }),
        save: () => undefined,
      },
    )
    const runtime = new ExtensionRuntime({
      repos,
      store: {} as ExtensionStore,
      sessions: { list: () => [] },
      settings: () => ({ ...DEFAULT_SETTINGS, closeExtensionStartupTabs: closeTabs }),
      emit: vi.fn(),
      logger: silentLogger,
      now: () => 1,
      timing: { verifyMs: 300 },
    })
    const launch: ExtensionLaunch = {
      items: [
        { id: 'a'.repeat(32), name: 'Alfa', dirKey: `${'a'.repeat(32)}/00000000`, config: null },
        { id: 'b'.repeat(32), name: 'Beta', dirKey: `${'b'.repeat(32)}/00000000`, config: null },
      ],
      directories: [],
      dirKeys: [],
      firstLoad: false,
    }
    return { runtime, launch }
  }

  it('falha fechada quando o Brave não carregou alguma extensão', async () => {
    const { runtime, launch } = setup()
    const client = new FakeClient()
    client.extensions = [
      { id: 'a'.repeat(32), enabled: true },
      { id: 'b'.repeat(32), enabled: false },
    ]
    await expect(
      runtime.afterConnect('perfil', client.asClient(), launch, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'EXTENSION_NOT_LOADED', details: { names: ['Beta'] } })
  })

  it('com tudo carregado, liga a guarda só fora da 1ª abertura e com a opção ligada', async () => {
    const signal = new AbortController().signal
    const client = new FakeClient()
    client.extensions = [
      { id: 'a'.repeat(32), enabled: true },
      { id: 'b'.repeat(32), enabled: true },
    ]
    const { runtime, launch } = setup()
    expect(await runtime.afterConnect('p', client.asClient(), launch, signal)).toBeInstanceOf(StartupTabGuard)
    expect(
      await runtime.afterConnect('p', client.asClient(), { ...launch, firstLoad: true }, signal),
    ).not.toBeInstanceOf(StartupTabGuard)
    const off = setup(false)
    expect(await off.runtime.afterConnect('p', client.asClient(), off.launch, signal)).not.toBeInstanceOf(
      StartupTabGuard,
    )
  })

  it('compara configurações sem depender da ordem das chaves', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 }),
    )
  })
})
