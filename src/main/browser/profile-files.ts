import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/ipc/result'
import { idSchema } from '@shared/schemas/common'
import { samePath } from './process'

export class ProfileFiles {
  private current!: string
  private pending!: string
  /**
   * @param companions pastas com uma subpasta por perfil fora da raiz (ex.: arquivos de
   * identificação em `<dados do app>/identity`), apagadas junto na exclusão definitiva.
   */
  constructor(
    root: string,
    private readonly companions: readonly string[] = [],
  ) {
    this.setRoot(root)
  }
  get root(): string {
    return this.current
  }
  /** Troca a raiz (mudança da pasta dos perfis, com todos os perfis parados). */
  setRoot(root: string): void {
    const resolved = path.resolve(root)
    const pending = path.join(resolved, '.pending-delete')
    fs.mkdirSync(resolved, { recursive: true })
    this.assertDirectory(resolved)
    fs.mkdirSync(pending, { recursive: true })
    this.assertDirectory(pending)
    this.current = resolved
    this.pending = pending
  }
  private assertDirectory(directory: string): void {
    const info = fs.lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new AppError('IO_ERROR', `Pasta inválida ou link: ${directory}`)
    if (!samePath(fs.realpathSync(directory), directory)) {
      throw new AppError('IO_ERROR', `A pasta não pode atravessar um link: ${directory}`)
    }
  }
  directory(id: string): string {
    idSchema.parse(id)
    this.assertDirectory(this.root)
    const directory = path.join(this.root, id)
    if (fs.existsSync(directory)) this.assertDirectory(directory)
    return directory
  }
  prepare(id: string): string {
    const directory = this.directory(id)
    fs.mkdirSync(directory, { recursive: true })
    this.assertDirectory(directory)
    return directory
  }
  stageDeletion(id: string): void {
    const directory = this.directory(id)
    this.assertDirectory(this.pending)
    const target = path.join(this.pending, id)
    if (fs.existsSync(target)) throw new AppError('IO_ERROR', 'Exclusão anterior ainda pendente')
    if (fs.existsSync(directory)) fs.renameSync(directory, target)
  }
  rollbackDeletion(id: string): void {
    const directory = this.directory(id)
    this.assertDirectory(this.pending)
    const source = path.join(this.pending, id)
    if (!fs.existsSync(source)) return
    this.assertDirectory(source)
    if (fs.existsSync(directory)) throw new AppError('IO_ERROR', 'Conflito ao recuperar pasta excluída')
    fs.renameSync(source, directory)
  }
  finishDeletion(id: string): void {
    idSchema.parse(id)
    // Arquivos recriáveis a cada abertura: somem mesmo que o perfil nunca tenha criado pasta.
    for (const base of this.companions)
      fs.rmSync(path.join(base, id), { recursive: true, force: true, maxRetries: 2 })
    this.assertDirectory(this.root)
    this.assertDirectory(this.pending)
    const target = path.join(this.pending, id)
    if (!fs.existsSync(target)) return
    this.assertDirectory(target)
    fs.rmSync(target, { recursive: true, force: false, maxRetries: 2 })
  }
  /** Área de importação dentro da raiz: o `adopt` final é um rename na mesma unidade. */
  importStaging(token: string): string {
    if (!/^[0-9a-f-]{36}$/.test(token)) throw new AppError('IO_ERROR', 'Identificador de importação inválido')
    this.assertDirectory(this.root)
    const directory = path.join(this.root, '.import-staging', token)
    fs.mkdirSync(directory, { recursive: true })
    this.assertDirectory(directory)
    return directory
  }
  /** Move uma pasta da área de importação para a pasta (ainda inexistente) do perfil. */
  adopt(source: string, id: string): void {
    const target = this.directory(id)
    const staging = path.join(this.root, '.import-staging')
    if (!path.resolve(source).startsWith(staging + path.sep))
      throw new AppError('IO_ERROR', 'Origem fora da área de importação')
    this.assertDirectory(source)
    if (fs.existsSync(target)) throw new AppError('IO_ERROR', 'A pasta do perfil já existe')
    fs.renameSync(source, target)
  }
  discardImportStaging(token?: string): void {
    const staging = path.join(this.root, '.import-staging')
    const target = token ? path.join(staging, token) : staging
    if (!fs.existsSync(target)) return
    this.assertDirectory(target)
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 })
  }
  recover(exists: (id: string) => boolean): void {
    for (const id of fs.readdirSync(this.pending)) {
      if (!idSchema.safeParse(id).success)
        throw new AppError('IO_ERROR', 'Arquivo desconhecido na área de exclusão pendente')
      if (exists(id)) this.rollbackDeletion(id)
      else this.finishDeletion(id)
    }
  }
}
