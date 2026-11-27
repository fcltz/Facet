import { app } from 'electron'
import { APP_NAME, CURRENT_STAGE, PREVIEW_ENGINE_MAJOR } from '@shared/constants'
import type { HandlerMap } from '../register'

export function appHandlers(hostTimezone: string): Pick<HandlerMap, 'app.getInfo'> {
  return {
    'app.getInfo': () => ({
      name: APP_NAME,
      version: app.getVersion(),
      stage: CURRENT_STAGE,
      platform: process.platform,
      arch: process.arch,
      versions: {
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node,
        v8: process.versions.v8,
      },
      userDataDir: app.getPath('userData'),
      isPackaged: app.isPackaged,
      hostTimezone,
      previewEngineMajor: PREVIEW_ENGINE_MAJOR,
    }),
  }
}
