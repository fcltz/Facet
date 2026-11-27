import { dialog, shell } from 'electron'
import { existsSync } from 'node:fs'
import type { BrowserKind } from '@shared/constants'
import type { Container } from '../../container'
import { emit } from '../emit'
import type { HandlerMap } from '../register'
import { AppError } from '@shared/ipc/result'

export function browserHandlers(
  container: Container,
): Pick<
  HandlerMap,
  | 'browser.getInfo'
  | 'browser.detect'
  | 'browser.validate'
  | 'browser.selectExecutable'
  | 'browser.openProfileFolder'
> {
  const { browsers } = container
  const { settings } = container.services
  const setPath = (kind: BrowserKind, path: string): void => {
    settings.update({ browserPaths: { ...settings.get().browserPaths, [kind]: path } })
  }
  // Guarda o caminho escolhido, e não o resolvido: o lançador do Opera continua valendo depois que
  // ele se atualiza (a pasta da versão antiga some).
  const validate = async (kind: BrowserKind, path: string) => {
    const info = await browsers.get(kind).validate(path, 'custom')
    if (info.available) setPath(kind, path)
    changed()
    return info
  }
  // A interface inteira (tabela, criação de perfil) acompanha o estado novo do navegador.
  const changed = (): void => emit('browsers.changed', browsers.infos())
  return {
    'browser.getInfo': () => browsers.infos(),
    'browser.detect': async ({ kind }) => {
      setPath(kind, '')
      const info = await browsers.get(kind).detect()
      changed()
      return info
    },
    'browser.validate': ({ kind, path }) => validate(kind, path),
    'browser.selectExecutable': async ({ kind }) => {
      const result = await dialog.showOpenDialog({
        properties: ['openFile'],
        ...(process.platform === 'win32' ? { filters: [{ name: 'Executável', extensions: ['exe'] }] } : {}),
      })
      const path = result.filePaths[0]
      return result.canceled || !path ? null : validate(kind, path)
    },
    'browser.openProfileFolder': async ({ id }) => {
      container.services.profiles.get(id)
      const directory = container.files.directory(id)
      if (!existsSync(directory)) throw new AppError('NOT_FOUND', 'A pasta será criada na primeira abertura')
      const error = await shell.openPath(directory)
      if (error) throw new AppError('IO_ERROR', error)
    },
  }
}
