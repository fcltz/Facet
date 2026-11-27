import fs from 'node:fs'
import { shell } from 'electron'
import { AppError } from '@shared/ipc/result'
import type { Container } from '../../container'
import { pickFolder, pickOpenFile } from '../dialogs'
import type { HandlerMap } from '../register'

type BackupChannels =
  'backup.run' | 'backup.pickFolder' | 'backup.openFolder' | 'backup.pickRestore' | 'backup.restore'

export function backupHandlers(
  { services }: Container,
  options: { restart: () => void },
): Pick<HandlerMap, BackupChannels> {
  const { backup } = services
  return {
    'backup.run': ({ jobId, includeProfiles }) => backup.run(jobId, includeProfiles),
    'backup.pickFolder': async () => {
      const folder = await pickFolder({ title: 'Pasta dos backups', defaultPath: backup.folder() })
      return folder ? backup.setFolder(folder) : null
    },
    'backup.openFolder': async () => {
      const folder = backup.folder()
      fs.mkdirSync(folder, { recursive: true })
      const error = await shell.openPath(folder)
      if (error) throw new AppError('IO_ERROR', error)
    },
    'backup.pickRestore': async () => {
      const file = await pickOpenFile({
        title: 'Restaurar backup',
        defaultPath: backup.folder(),
        properties: ['openFile'],
        filters: [{ name: 'Backup do Facet', extensions: ['zip'] }],
      })
      return file ? backup.inspectRestore(file) : null
    },
    'backup.restore': async ({ token }) => {
      await backup.restore(token)
      // Responde ao renderer antes de reiniciar; a troca acontece no próximo início.
      setTimeout(options.restart, 300)
    },
  }
}
