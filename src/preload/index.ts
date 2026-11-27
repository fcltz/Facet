import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { isLanguage } from '@shared/constants'
import { isEventChannel, isInvokeChannel } from '@shared/ipc/channels'
import type { FacetBridge } from '@shared/ipc/contract'
import type { Result } from '@shared/ipc/result'
import type { Language } from '@shared/schemas/settings'

/**
 * Ponte mínima entre a interface e o processo principal. Nada de Node é exposto:
 * só `invoke` e `on` para os canais declarados no contrato.
 */

function readArgument(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

const languageArg = readArgument('facet-language')
const initialLanguage: Language = isLanguage(languageArg) ? languageArg : 'pt-BR'
const initialWelcome = process.argv.includes('--facet-welcome')

const bridge = {
  invoke(channel: string, input?: unknown): Promise<Result<unknown>> {
    if (!isInvokeChannel(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: 'UNKNOWN_CHANNEL', message: `Canal não permitido: ${channel}` },
      })
    }
    return ipcRenderer.invoke(channel, input) as Promise<Result<unknown>>
  },
  on(event: string, listener: (payload: unknown) => void): () => void {
    if (!isEventChannel(event)) throw new Error(`Evento não permitido: ${event}`)
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => {
      ipcRenderer.removeListener(event, wrapped)
    }
  },
  platform: process.platform,
  initialLanguage,
  initialWelcome,
} as FacetBridge

contextBridge.exposeInMainWorld('api', bridge)
