import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import type { ExtensionFileKind } from '@shared/schemas/extension'
import type { Container } from '../../container'
import type { HandlerMap } from '../register'

type ExtensionChannels =
  | 'extensions.list'
  | 'extensions.importFile'
  | 'extensions.importWebStore'
  | 'extensions.refresh'
  | 'extensions.replace'
  | 'extensions.setDefault'
  | 'extensions.setPreferences'
  | 'extensions.assign'
  | 'extensions.delete'
  | 'extensions.getConfig'
  | 'extensions.setConfig'
  | 'extensions.captureConfig'
  | 'extensions.profileState'
  | 'extensions.reapplyConfig'

/**
 * O seletor de arquivo abre aqui no processo principal: o renderer nunca informa
 * caminhos do disco, só escolhe entre arquivo (.zip/.crx) e pasta.
 */
async function pickPath(kind: ExtensionFileKind): Promise<string | null> {
  const options: OpenDialogOptions =
    kind === 'folder'
      ? { title: 'Pasta da extensão (descompactada)', properties: ['openDirectory'] }
      : {
          title: 'Extensão (.zip ou .crx)',
          properties: ['openFile'],
          filters: [{ name: 'Extensão', extensions: ['zip', 'crx'] }],
        }
  const window = BrowserWindow.getFocusedWindow()
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  const path = result.filePaths[0]
  return result.canceled || !path ? null : path
}

export function extensionHandlers({ services }: Container): Pick<HandlerMap, ExtensionChannels> {
  const { extensions } = services
  return {
    'extensions.list': () => extensions.list(),
    'extensions.importFile': async ({ kind }) => {
      const path = await pickPath(kind)
      if (!path) return null
      return kind === 'folder' ? extensions.importFolder(path) : extensions.importArchive(path)
    },
    'extensions.importWebStore': ({ input }) => extensions.importWebStore(input),
    'extensions.refresh': ({ id }) => extensions.refresh(id),
    'extensions.replace': async ({ id, kind }) => {
      const path = await pickPath(kind)
      return path ? extensions.replace(id, kind, path) : null
    },
    'extensions.setDefault': ({ ids, isDefault }) => extensions.setDefault(ids, isDefault),
    'extensions.setPreferences': ({ id, mode, isDefault }) => extensions.setPreferences(id, mode, isDefault),
    'extensions.assign': ({ extensionId, profileIds, enabled }) =>
      extensions.assign(extensionId, profileIds, enabled),
    'extensions.delete': ({ ids, confirmInUse }) => extensions.delete(ids, confirmInUse),
    'extensions.getConfig': ({ id }) => extensions.getConfig(id),
    'extensions.setConfig': ({ id, config, reapply }) => extensions.setConfig(id, config, reapply),
    'extensions.captureConfig': ({ id, profileId, area }) => extensions.captureConfig(id, profileId, area),
    'extensions.profileState': ({ profileId }) => extensions.profileState(profileId),
    'extensions.reapplyConfig': ({ profileId, extensionIds }) =>
      extensions.reapplyConfig(profileId, extensionIds),
  }
}
