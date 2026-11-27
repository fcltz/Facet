import { BrowserWindow } from 'electron'
import type { EventChannel } from '@shared/ipc/channels'
import type { EmitFn, EventPayloads } from '@shared/ipc/events'

/** Envia um evento tipado para todas as janelas abertas do app. */
export const emit: EmitFn = <E extends EventChannel>(event: E, payload: EventPayloads[E]): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(event, payload)
    }
  }
}
