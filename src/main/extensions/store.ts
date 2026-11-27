import { randomBytes, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/ipc/result'
import { isExtensionId } from '@shared/schemas/extension'
import type { Logger } from '../logger'
import { validateEntryName, type UnpackLimits, type UnpackResult } from './zip'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const DIR_NAME = /^[0-9a-f]{8}$/

export interface TreeInfo {
  files: number
  bytes: number
  /** Maior caminho relativo (em caracteres), para checar o limite do Windows. */
  longest: number
}

function assertRealDirectory(directory: string): void {
  const info = fs.lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AppError('IO_ERROR', `Pasta inválida ou link: ${directory}`)
}

/** O antivírus do Windows às vezes segura arquivos recém-extraídos por alguns instantes. */
async function renameWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(source, target)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 6 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) throw error
      await sleep(250)
    }
  }
}

/**
 * Pastas das extensões: extensions/<id>/<pasta-da-versão>/, compartilhadas por todos
 * os perfis. Cada instalação ou atualização cria uma pasta nova; as antigas só são
 * apagadas quando nem a biblioteca nem um perfil aberto as usam.
 */
export class ExtensionStore {
  readonly root: string
  private readonly staging: string
  /** Pastas já movidas mas ainda não gravadas no banco: a limpeza não pode apagá-las. */
  private readonly pending = new Set<string>()

  constructor(
    root: string,
    private readonly logger: Logger,
  ) {
    this.root = path.resolve(root)
    this.staging = path.join(this.root, '.staging')
    fs.mkdirSync(this.staging, { recursive: true })
    assertRealDirectory(this.root)
    assertRealDirectory(this.staging)
  }

  /** Pasta temporária vazia para montar um pacote. */
  createStaging(): string {
    const directory = path.join(this.staging, randomUUID())
    fs.mkdirSync(directory)
    return directory
  }

  discardStaging(directory: string): void {
    const resolved = path.resolve(directory)
    if (!resolved.startsWith(this.staging + path.sep)) return
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      this.logger.warn('Pasta temporária de extensão será apagada depois', error)
    }
  }

  /** Restos de importações interrompidas (o app fechou no meio). */
  cleanStaging(): void {
    for (const name of fs.readdirSync(this.staging)) this.discardStaging(path.join(this.staging, name))
  }

  /** Comprimento do caminho final de um arquivo cujo caminho relativo tem `relative` caracteres. */
  finalPathLength(id: string, relative: number): number {
    return path.join(this.root, id, 'x'.repeat(8)).length + 1 + relative
  }

  directory(id: string, dirName: string): string {
    if (!isExtensionId(id) || !DIR_NAME.test(dirName))
      throw new AppError('IO_ERROR', `Pasta de extensão inválida: ${id}/${dirName}`)
    return path.join(this.root, id, dirName)
  }

  /** Move a pasta montada para o lugar definitivo e devolve o nome da pasta da versão. */
  async commit(source: string, id: string): Promise<string> {
    if (!isExtensionId(id)) throw new AppError('IO_ERROR', `ID de extensão inválido: ${id}`)
    const parent = path.join(this.root, id)
    fs.mkdirSync(parent, { recursive: true })
    assertRealDirectory(parent)
    let dirName = randomBytes(4).toString('hex')
    while (fs.existsSync(path.join(parent, dirName))) dirName = randomBytes(4).toString('hex')
    const key = `${id}/${dirName}`
    this.pending.add(key)
    try {
      await renameWithRetry(source, path.join(parent, dirName))
    } catch (error) {
      this.pending.delete(key)
      throw new AppError(
        'IO_ERROR',
        `Não foi possível mover a extensão para a pasta do app: ${(error as Error).message}`,
      )
    }
    return dirName
  }

  /** A pasta já consta do banco (ou a instalação desistiu dela). */
  settle(id: string, dirName: string): void {
    this.pending.delete(`${id}/${dirName}`)
  }

  /** Caminhos para --load-extension; lança EXTENSION_UNAVAILABLE se faltar algum. */
  resolveForLaunch(items: readonly { id: string; dirName: string; name: string }[]): string[] {
    const missing: string[] = []
    const directories = items.map((item) => {
      const directory = this.directory(item.id, item.dirName)
      if (!fs.existsSync(path.join(directory, 'manifest.json'))) missing.push(item.name)
      return directory
    })
    if (missing.length > 0) {
      throw new AppError(
        'EXTENSION_UNAVAILABLE',
        `Arquivos de extensão não encontrados: ${missing.join(', ')}. Reinstale ou remova do perfil.`,
        { reason: 'missingFiles', names: missing },
      )
    }
    if (directories.some((directory) => directory.includes(','))) {
      throw new AppError(
        'EXTENSION_UNAVAILABLE',
        'O caminho da pasta de extensões tem vírgula, que o navegador não aceita em --load-extension',
        { reason: 'commaInPath' },
      )
    }
    return directories
  }

  /** Apaga pastas que ninguém usa; devolve quantas foram removidas. Nunca lança. */
  collectGarbage(inUse: ReadonlySet<string>): number {
    let removed = 0
    let ids: string[]
    try {
      ids = fs.readdirSync(this.root)
    } catch (error) {
      this.logger.warn('Não foi possível listar a pasta de extensões', error)
      return 0
    }
    for (const id of ids) {
      if (!isExtensionId(id)) continue
      const parent = path.join(this.root, id)
      try {
        if (!fs.lstatSync(parent).isDirectory()) continue
        for (const dirName of fs.readdirSync(parent)) {
          const key = `${id}/${dirName}`
          if (inUse.has(key) || this.pending.has(key)) continue
          fs.rmSync(path.join(parent, dirName), { recursive: true, force: true, maxRetries: 3 })
          removed++
        }
        if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent)
      } catch (error) {
        this.logger.warn('Pasta de extensão antiga será apagada depois', id, error)
      }
    }
    return removed
  }

  /** Tamanho e maior caminho relativo de uma pasta já montada. */
  scanTree(directory: string): TreeInfo {
    const info: TreeInfo = { files: 0, bytes: 0, longest: 0 }
    const walk = (current: string, relative: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        const child = path.join(current, entry.name)
        info.longest = Math.max(info.longest, childRelative.length)
        if (entry.isDirectory()) walk(child, childRelative)
        else if (entry.isFile()) {
          info.files++
          info.bytes += fs.statSync(child).size
        }
      }
    }
    walk(directory, '')
    return info
  }

  /**
   * Copia uma pasta descompactada para a área temporária. Recusa links e junções (a
   * extensão poderia apontar para fora da pasta) e respeita os mesmos limites do ZIP.
   * Pastas .git ficam de fora: nunca fazem parte da extensão.
   */
  copyFolder(source: string, target: string, limits: UnpackLimits): UnpackResult {
    const root = path.resolve(source)
    const rootInfo = fs.lstatSync(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
      throw new AppError('EXTENSION_INVALID', 'Selecione uma pasta comum (não um atalho ou link)', {
        reason: 'package',
      })
    let entries = 0
    let bytes = 0
    let files = 0
    const walk = (current: string, relative: string): void => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        if (entry.name === '.git') continue
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name
        const sourcePath = path.join(current, entry.name)
        const targetPath = path.join(target, ...validateEntryName(childRelative))
        const stat = fs.lstatSync(sourcePath)
        if (stat.isSymbolicLink())
          throw new AppError('EXTENSION_INVALID', `Links e atalhos não são aceitos: ${childRelative}`, {
            reason: 'package',
          })
        if (++entries > limits.maxEntries)
          throw new AppError('EXTENSION_INVALID', 'Pasta com arquivos demais', { reason: 'tooLarge' })
        if (stat.isDirectory()) {
          fs.mkdirSync(targetPath, { recursive: true })
          walk(sourcePath, childRelative)
        } else if (stat.isFile()) {
          bytes += stat.size
          if (bytes > limits.maxTotalBytes)
            throw new AppError('EXTENSION_INVALID', 'Pasta grande demais', { reason: 'tooLarge' })
          fs.mkdirSync(path.dirname(targetPath), { recursive: true })
          fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
          files++
        }
      }
    }
    walk(root, '')
    return { files, bytes }
  }
}
