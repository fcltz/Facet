import path from 'node:path'
import fs from 'node:fs/promises'
import { LIMITS } from '@shared/constants'
import { AppError } from '@shared/ipc/result'
import type { Container } from '../../container'
import { inDocuments, pickOpenFile, pickSaveFile, safeFileName, writeFileAtomic } from '../dialogs'
import type { HandlerMap } from '../register'

type CookieChannels =
  'cookies.status' | 'cookies.pickFile' | 'cookies.import' | 'cookies.export' | 'cookies.clearPending'

export function cookieHandlers({ services }: Container): Pick<HandlerMap, CookieChannels> {
  const { cookies, profiles } = services
  return {
    'cookies.pickFile': async () => {
      const file = await pickOpenFile({
        title: 'Importar cookies',
        properties: ['openFile'],
        filters: [{ name: 'Cookies JSON / Netscape', extensions: ['json', 'txt'] }],
      })
      if (!file) return null
      const handle = await fs.open(file, 'r')
      try {
        if ((await handle.stat()).size > LIMITS.cookiesImportMaxBytes)
          throw new AppError('VALIDATION_ERROR', 'Arquivo de cookies grande demais', [
            { path: 'cookies', message: 'cookieFileTooLarge' },
          ])
        // Leitura limitada mesmo se outro processo aumentar o arquivo após stat.
        const buffer = Buffer.alloc(LIMITS.cookiesImportMaxBytes + 1)
        let size = 0
        while (size < buffer.length) {
          const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null)
          if (!bytesRead) break
          size += bytesRead
        }
        if (size > LIMITS.cookiesImportMaxBytes)
          throw new AppError('VALIDATION_ERROR', 'Arquivo de cookies grande demais', [
            { path: 'cookies', message: 'cookieFileTooLarge' },
          ])
        return { name: path.basename(file), text: buffer.subarray(0, size).toString('utf8') }
      } finally {
        await handle.close()
      }
    },
    'cookies.status': ({ id }) => cookies.status(id),
    'cookies.import': ({ id, cookies: list }) => cookies.import(id, list),
    'cookies.export': async ({ id, format, target }) => {
      const profile = profiles.get(id)
      const { text, count } = await cookies.export(id, format)
      if (target === 'clipboard') return { count, file: null, text }
      const json = format === 'json'
      const file = await pickSaveFile({
        title: 'Exportar cookies',
        defaultPath: inDocuments(`${safeFileName(profile.name, 'perfil')}-cookies.${json ? 'json' : 'txt'}`),
        filters: [
          json ? { name: 'JSON', extensions: ['json'] } : { name: 'cookies.txt', extensions: ['txt'] },
        ],
      })
      if (!file) return { count, file: null, text: null }
      writeFileAtomic(file, text)
      return { count, file: path.basename(file), text: null }
    },
    'cookies.clearPending': ({ id }) => cookies.clearPending(id),
  }
}
