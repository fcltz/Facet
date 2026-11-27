import { BROWSER_KINDS } from '@shared/constants'
import type { Container } from '../../container'
import { pickFolder } from '../dialogs'
import type { HandlerMap } from '../register'
import { AppError } from '@shared/ipc/result'

type SettingsChannels =
  | 'settings.get'
  | 'settings.update'
  | 'settings.getGeoIpToken'
  | 'settings.setGeoIpToken'
  | 'profilesRoot.pick'
  | 'profilesRoot.move'

export function settingsHandlers({
  services,
  browsers,
  geoIpToken,
  files,
  paths,
}: Container): Pick<HandlerMap, SettingsChannels> {
  const { settings, profilesRoot } = services
  return {
    'settings.get': () => settings.get(),
    'settings.update': async (patch) => {
      const before = settings.get().browserPaths
      // Executável trocado: só entra se a sondagem confirmar que é o navegador.
      const changed = patch.browserPaths
        ? BROWSER_KINDS.filter((kind) => patch.browserPaths![kind] !== before[kind])
        : []
      for (const kind of changed) {
        const path = patch.browserPaths![kind]
        if (!path) continue
        const info = await browsers.get(kind).validate(path, 'custom')
        if (!info.available) throw new AppError('BROWSER_NOT_FOUND', info.error ?? 'Executável inválido')
      }
      const next = settings.update(patch)
      // Caminho apagado: volta a procurar a instalação.
      for (const kind of changed) if (!patch.browserPaths![kind]) await browsers.get(kind).detect()
      return next
    },
    // O token fica cifrado no processo principal; a interface só sabe se existe um.
    'settings.getGeoIpToken': () => ({ configured: geoIpToken.configured() }),
    'settings.setGeoIpToken': ({ token }) => {
      geoIpToken.set(token ? token : null)
      return { configured: geoIpToken.configured() }
    },
    'profilesRoot.pick': async ({ target }) => {
      if (target === 'default') return profilesRoot.inspect(paths.profilesDir, true)
      const folder = await pickFolder({ title: 'Pasta dos perfis', defaultPath: files.root })
      return folder ? profilesRoot.inspect(folder, false) : null
    },
    'profilesRoot.move': ({ jobId, token }) => profilesRoot.move(jobId, token),
  }
}
