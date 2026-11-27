import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import readline from 'node:readline'
import type { Logger } from '../logger'

/** Janelas de um Brave aberto pelo Facet que recebem a identidade do perfil. */
export interface WindowIdentityTarget {
  pid: number
  /** AppUserModelID próprio: cada perfil vira um botão separado na barra de tarefas. */
  appId: string
  /** .ico com o número do perfil. */
  icon: string
  /** "01 · Nome" (nome do botão na barra de tarefas). */
  name: string
  /** Comando de reabertura gravado na janela (a fixação na barra fica bloqueada). */
  command: string
}

export interface WindowIdentityOptions {
  /** Executável do utilitário; null = desligado (fora do Windows). */
  helperPath: string | null
  logger: Logger
  /** Troca o processo do utilitário nos testes. */
  spawnHelper?: (file: string) => ChildProcess
  /** Espera antes de tentar iniciar de novo um utilitário que falhou. */
  retryMs?: number
}

const clean = (value: string | number): string => String(value).replace(/[\t\r\n]+/g, ' ')

/**
 * Cliente do utilitário da barra de tarefas (`facet-win-helper.exe`). Inicia sob demanda, um
 * para todos os perfis; se ele cair, a próxima chamada o inicia de novo e reenvia os perfis
 * acompanhados. Sem o utilitário, os perfis abrem normalmente (só sem o botão próprio).
 */
export class WindowIdentity {
  private child: ChildProcess | null = null
  private readonly targets = new Map<number, WindowIdentityTarget>()
  private readonly listeners = new Set<(pid: number, windows: number) => void>()
  private failedAt = Number.NEGATIVE_INFINITY
  private warnedMissing = false
  private closing = false

  constructor(private readonly options: WindowIdentityOptions) {}

  get enabled(): boolean {
    return this.options.helperPath !== null
  }

  track(target: WindowIdentityTarget): void {
    if (!this.enabled) return
    this.targets.set(target.pid, { ...target })
    this.send(['track', target.pid, target.appId, target.icon, target.name, target.command])
  }

  rename(pid: number, name: string): void {
    const target = this.targets.get(pid)
    if (!target) return
    target.name = name
    this.send(['rename', pid, name])
  }

  untrack(pid: number): void {
    if (!this.targets.delete(pid)) return
    this.send(['untrack', pid])
  }

  /** Janelas marcadas pelo utilitário (registro e testes). */
  onTagged(listener: (pid: number, windows: number) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Ao sair do app: fecha a entrada do utilitário, que encerra sozinho. */
  close(): void {
    this.closing = true
    this.targets.clear()
    this.child?.stdin?.end()
    this.child = null
  }

  private send(fields: (string | number)[]): void {
    if (this.closing) return
    const fresh = this.child === null
    const child = this.ensure()
    // Utilitário recém-iniciado já recebeu todos os perfis acompanhados (com nomes atuais).
    if (!child || fresh) return
    this.write(child, fields)
  }

  private write(child: ChildProcess, fields: (string | number)[]): void {
    if (!child.stdin?.writable) return
    child.stdin.write(`${fields.map(clean).join('\t')}\n`)
  }

  private ensure(): ChildProcess | null {
    if (this.child) return this.child
    const file = this.options.helperPath
    if (!file) return null
    if (Date.now() - this.failedAt < (this.options.retryMs ?? 30000)) return null
    if (!this.options.spawnHelper && !fs.existsSync(file)) {
      if (!this.warnedMissing)
        this.options.logger.warn(`Utilitário da barra de tarefas não encontrado: ${file}`)
      this.warnedMissing = true
      this.failedAt = Date.now()
      return null
    }
    let child: ChildProcess
    try {
      child = this.options.spawnHelper
        ? this.options.spawnHelper(file)
        : spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (error) {
      this.options.logger.warn('Não foi possível iniciar o utilitário da barra de tarefas', error)
      this.failedAt = Date.now()
      return null
    }
    this.child = child
    child.once('error', (error) => {
      this.options.logger.warn('Utilitário da barra de tarefas falhou', error)
    })
    child.once('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      if (!this.closing) {
        this.failedAt = Date.now()
        this.options.logger.warn(`Utilitário da barra de tarefas encerrou (código ${code ?? '?'})`)
      }
    })
    child.stdin?.on('error', () => undefined)
    if (child.stdout) {
      readline.createInterface({ input: child.stdout }).on('line', (line) => this.receive(line))
    }
    for (const target of this.targets.values()) {
      this.write(child, ['track', target.pid, target.appId, target.icon, target.name, target.command])
    }
    return child
  }

  private receive(line: string): void {
    const [kind, first, second] = line.split('\t')
    if (kind === 'tagged') {
      const pid = Number(first)
      const windows = Number(second)
      for (const listener of this.listeners) listener(pid, windows)
    } else if (kind === 'error') {
      this.options.logger.warn(`Utilitário da barra de tarefas: ${first ?? line}`)
    }
  }
}
