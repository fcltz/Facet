import i18next from 'i18next'
import { create } from 'zustand'
import type { BrowserKind } from '@shared/constants'
import type { BrowserInfo, BrowsersInfo } from '@shared/schemas/browser'
import {
  DEFAULT_SETTINGS,
  type AppInfo,
  type AppSettings,
  type SettingsPatch,
} from '@shared/schemas/settings'
import { setLanguage } from '@renderer/i18n'
import { invoke, toastError } from '@renderer/lib/ipc'

interface SettingsState {
  settings: AppSettings
  appInfo: AppInfo | null
  /** Navegadores suportados: instalados, versão sondada e capacidades de fingerprint. */
  browsers: BrowserInfo[]
  setBrowsers: (info: BrowsersInfo) => void
  /** Atualiza um navegador (depois de detectar ou validar o executável). */
  setBrowser: (info: BrowserInfo) => void
  loaded: boolean
  load: () => Promise<void>
  update: (patch: SettingsPatch) => Promise<void>
  /** Aplica configurações vindas do processo principal (evento ou resposta). */
  apply: (settings: AppSettings) => void
}

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  // Idioma e boas-vindas vêm do processo principal antes do 1º render (sem piscar a tela errada).
  settings: {
    ...DEFAULT_SETTINGS,
    language: window.api.initialLanguage,
    onboardingCompleted: !window.api.initialWelcome,
  },
  appInfo: null,
  browsers: [],
  setBrowsers: (info) => set({ browsers: info.browsers }),
  setBrowser: (info) =>
    set((state) => ({
      browsers: state.browsers.some((browser) => browser.kind === info.kind)
        ? state.browsers.map((browser) => (browser.kind === info.kind ? info : browser))
        : [...state.browsers, info],
    })),
  loaded: false,

  load: async () => {
    try {
      const [settings, appInfo, browsers] = await Promise.all([
        invoke('settings.get'),
        invoke('app.getInfo'),
        invoke('browser.getInfo'),
      ])
      get().apply(settings)
      set({ appInfo, browsers: browsers.browsers, loaded: true })
    } catch (error) {
      set({ loaded: true })
      toastError(error, i18next.t('errors.loadFailed'))
    }
  },

  update: async (patch) => {
    const previous = get().settings
    // Idioma e tema respondem na hora. Só sai das boas-vindas depois de gravar: uma
    // falha não pode desmontar a tela e perder a etapa e o navegador escolhidos.
    if (patch.onboardingCompleted !== true) get().apply({ ...previous, ...patch })
    try {
      get().apply(await invoke('settings.update', patch))
    } catch (error) {
      get().apply(previous)
      toastError(error)
    }
  },

  apply: (settings) => {
    if (get().settings.profilesRoot !== settings.profilesRoot) {
      void invoke('browser.getInfo')
        .then((info) => set({ browsers: info.browsers }))
        .catch(toastError)
    }
    set({ settings })
    setLanguage(settings.language)
  },
}))

/** Estado de um navegador (null antes de carregar). */
export function useBrowser(kind: BrowserKind): BrowserInfo | null {
  return useSettingsStore((state) => state.browsers.find((browser) => browser.kind === kind) ?? null)
}
