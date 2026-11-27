import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron'

/**
 * Seletores nativos abertos no processo principal: o renderer nunca informa caminhos do
 * disco. Nos testes E2E, `dialog.show*Dialog` é trocado dentro do processo principal.
 */
function owner(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

export async function pickSaveFile(options: SaveDialogOptions): Promise<string | null> {
  const window = owner()
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}

export async function pickOpenFile(options: OpenDialogOptions): Promise<string | null> {
  const window = owner()
  const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  const file = result.filePaths[0]
  return result.canceled || !file ? null : file
}

export async function pickFolder(options: Omit<OpenDialogOptions, 'properties'>): Promise<string | null> {
  return pickOpenFile({ ...options, properties: ['openDirectory', 'createDirectory'] })
}

/** Nome de arquivo seguro a partir de um nome livre (nome do perfil, por exemplo). */
export function safeFileName(name: string, fallback: string): string {
  let cleaned = ''
  for (const char of name) cleaned += char.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(char) ? '_' : char
  cleaned = cleaned
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
  return cleaned || fallback
}

export function inDocuments(file: string): string {
  return path.join(app.getPath('documents'), file)
}

/** Grava num temporário ao lado e troca pelo destino: um arquivo pela metade nunca fica no lugar. */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, data, { flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}
