import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import readline from 'node:readline'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@shared/ipc/result'
import type { Logger } from '../logger'

const exec = promisify(execFile)
export interface ProcessIdentity {
  pid: number
  startedAt: string
  executablePath: string
  args: string[]
}
/** Linha do Win32_Process (Get-CimInstance) ou do utilitário nativo, com os mesmos campos. */
interface ProcessRow {
  ProcessId: number
  ExecutablePath: string | null
  CommandLine: string | null
  Started: string
}
interface PendingQuery {
  resolve: (rows: ProcessRow[]) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
export interface ProcessHelperOptions {
  /** `facet-win-helper.exe` (modo --processes). */
  path: string
  logger?: Logger
  /** Prazo de cada consulta; passou disso, a consulta vai para o PowerShell. */
  timeoutMs?: number
  /** Espera antes de tentar iniciar de novo um utilitário que falhou. */
  retryMs?: number
  /** Troca o processo do utilitário nos testes. */
  spawnHelper?: (file: string) => ChildProcess
}

/**
 * Consultas de processos pelo utilitário nativo (`facet-win-helper.exe --processes`): o PowerShell
 * leva ~2-3 s só para iniciar, e cada abertura e cada fechamento de perfil faziam várias consultas
 * seguidas. Um processo para todas as consultas, iniciado sob demanda e encerrado junto com o
 * Facet (a entrada fecha). Sem ele, ou se ele falhar, as consultas voltam para o PowerShell.
 */
export class ProcessHelper {
  private child: ChildProcess | null = null
  private readonly pending = new Map<string, PendingQuery>()
  private nextId = 1
  private failedAt = Number.NEGATIVE_INFINITY
  private warned = false
  private closed = false

  constructor(private readonly options: ProcessHelperOptions) {}

  /** Linhas do processo `pid` (ou de todos com --user-data-dir=); null = utilitário indisponível. */
  async list(pid?: number): Promise<ProcessRow[] | null> {
    const child = this.ensure()
    if (!child?.stdin?.writable) return null
    const id = String(this.nextId++)
    try {
      return await new Promise<ProcessRow[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error('o utilitário de processos não respondeu a tempo'))
        }, this.options.timeoutMs ?? 5000)
        this.pending.set(id, { resolve, reject, timer })
        child.stdin!.write(`list\t${id}\t${pid === undefined ? '*' : Math.trunc(pid)}\n`)
      })
    } catch (error) {
      this.fail(error)
      return null
    }
  }

  /** Inicia o utilitário em segundo plano: a primeira abertura de perfil não espera por ele. */
  warm(): void {
    void this.list(process.pid)
  }

  close(): void {
    this.closed = true
    this.stop(new Error('utilitário de processos encerrado'))
  }

  private ensure(): ChildProcess | null {
    if (this.child) return this.child
    if (this.closed || Date.now() - this.failedAt < (this.options.retryMs ?? 30000)) return null
    if (!this.options.spawnHelper && !existsSync(this.options.path)) {
      this.fail(new Error(`utilitário não encontrado: ${this.options.path}`))
      return null
    }
    let child: ChildProcess
    try {
      child = this.options.spawnHelper
        ? this.options.spawnHelper(this.options.path)
        : spawn(this.options.path, ['--processes'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (error) {
      this.fail(error)
      return null
    }
    this.child = child
    child.once('error', (error) => this.fail(error))
    child.once('exit', (code) => {
      if (this.child === child) this.fail(new Error(`utilitário de processos encerrou (código ${code ?? '?'})`))
    })
    child.stdin?.on('error', () => undefined)
    if (child.stdout) readline.createInterface({ input: child.stdout }).on('line', (line) => this.receive(line))
    // Não segura o Facet (nem os testes) aberto: só as consultas em andamento, pelos prazos.
    child.unref()
    for (const stream of [child.stdin, child.stdout] as ({ unref?: () => void } | null)[]) stream?.unref?.()
    return child
  }

  private receive(line: string): void {
    const [kind, id = '', payload = ''] = line.split('\t')
    const query = this.pending.get(id)
    if (!query) return
    this.pending.delete(id)
    clearTimeout(query.timer)
    if (kind !== 'ok') {
      query.reject(new Error(payload || line))
      return
    }
    try {
      query.resolve(JSON.parse(payload) as ProcessRow[])
    } catch (error) {
      query.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Falha do utilitário: as consultas vão para o PowerShell até a próxima tentativa. */
  private fail(error: unknown): void {
    if (!this.closed) {
      this.failedAt = Date.now()
      if (!this.warned)
        this.options.logger?.warn('Consultas de processos voltaram para o PowerShell (mais lento)', error)
      this.warned = true
    }
    this.stop(error instanceof Error ? error : new Error(String(error)))
  }

  private stop(error: Error): void {
    const child = this.child
    this.child = null
    for (const [id, query] of this.pending) {
      clearTimeout(query.timer)
      this.pending.delete(id)
      query.reject(error)
    }
    if (child) {
      child.stdin?.end()
      if (child.exitCode === null) child.kill()
    }
  }
}

let processHelper: ProcessHelper | null = null
/** Utilitário nativo das consultas de processos no Windows (null = só o PowerShell). */
export function useProcessHelper(helper: ProcessHelper | null): void {
  if (processHelper && processHelper !== helper) processHelper.close()
  processHelper = helper
}
export function splitCommandLine(command: string): string[] {
  const args: string[] = []
  let current = ''
  let quoted = false
  for (const char of command) {
    if (char === '"') quoted = !quoted
    else if (/\s/.test(char) && !quoted) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else current += char
  }
  if (current) args.push(current)
  return args
}
export function samePath(a: string, b: string): boolean {
  const normalize = (value: string): string =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
  return normalize(a) === normalize(b)
}
export function processUsesDirectory(identity: ProcessIdentity, directory: string): boolean {
  const value = identity.args.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
  return Boolean(value && samePath(value, directory)) && !identity.args.some((a) => a.startsWith('--type='))
}
async function powershellProcesses(pid?: number): Promise<ProcessRow[]> {
  const filter =
    pid === undefined ? "CommandLine LIKE '%--user-data-dir=%'" : `ProcessId = ${Math.trunc(pid)}`
  // Sem UTF-8 explícito o PowerShell 5.1 escreve na página de código OEM e caminhos com
  // acento (ex.: C:\Users\José) chegam corrompidos, quebrando a identificação do processo.
  const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ExecutablePath,CommandLine,@{Name='Started';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}}) | ConvertTo-Json -Compress`
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    timeout: 12000,
    maxBuffer: 4 * 1024 * 1024,
  })
  const raw: unknown = stdout.trim() ? JSON.parse(stdout) : []
  return (Array.isArray(raw) ? raw : [raw]) as ProcessRow[]
}
async function windowsProcesses(pid?: number): Promise<ProcessIdentity[]> {
  // O utilitário devolve exatamente o mesmo que o PowerShell (inclusive o texto de Started).
  const rows = (await processHelper?.list(pid)) ?? (await powershellProcesses(pid))
  return rows
    .filter((r) => r.ExecutablePath && r.CommandLine)
    .map((r) => ({
      pid: r.ProcessId,
      executablePath: r.ExecutablePath!,
      startedAt: r.Started,
      args: splitCommandLine(r.CommandLine!),
    }))
}
export async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform === 'win32') return (await windowsProcesses(pid))[0] ?? null
  if (process.platform === 'linux') {
    try {
      const [cmdline, stat, executablePath] = await Promise.all([
        fs.readFile(`/proc/${pid}/cmdline`, 'utf8'),
        fs.readFile(`/proc/${pid}/stat`, 'utf8'),
        fs.readlink(`/proc/${pid}/exe`),
      ])
      return {
        pid,
        executablePath,
        args: cmdline.split('\0').filter(Boolean),
        startedAt: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
      timeout: 5000,
    })
    const match = /^(.{24})\s+(.+)$/s.exec(stdout.trim())
    if (!match) return null
    const command = match[2]!
    const executablePath = command.split(' --')[0]!.trim()
    return { pid, startedAt: match[1]!, executablePath, args: splitCommandLine(command) }
  } catch {
    return null
  }
}
export async function findProcesses(directory: string): Promise<ProcessIdentity[]> {
  let processes: ProcessIdentity[]
  if (process.platform === 'win32') processes = await windowsProcesses()
  else {
    const ids =
      process.platform === 'linux'
        ? (await fs.readdir('/proc')).filter((id) => /^\d+$/.test(id)).map(Number)
        : (await exec('ps', ['-axo', 'pid='])).stdout.trim().split(/\s+/).map(Number)
    const found = await Promise.all(ids.map((id) => inspectProcess(id)))
    processes = found.filter((p): p is ProcessIdentity => p !== null)
  }
  return processes.filter((p) => processUsesDirectory(p, directory))
}
export async function identityStillMatches(identity: ProcessIdentity, directory: string): Promise<boolean> {
  const current = await inspectProcess(identity.pid)
  return matchesIdentity(current, identity, directory)
}
export function matchesIdentity(
  current: ProcessIdentity | null,
  expected: ProcessIdentity,
  directory: string,
): boolean {
  return Boolean(
    current &&
    current.pid === expected.pid &&
    current.startedAt === expected.startedAt &&
    samePath(current.executablePath, expected.executablePath) &&
    processUsesDirectory(current, directory),
  )
}
export async function terminateOwnedProcess(identity: ProcessIdentity, directory: string): Promise<void> {
  if (!(await identityStillMatches(identity, directory))) return
  if (process.platform === 'win32')
    await exec('taskkill.exe', ['/PID', String(identity.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10000,
    })
  else process.kill(identity.pid, 'SIGKILL')
}
export async function waitForExit(
  identity: ProcessIdentity,
  directory: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await identityStillMatches(identity, directory))) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}
export async function assertDirectoryIdle(directory: string): Promise<void> {
  try {
    await fs.access(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if ((await findProcesses(directory)).length)
    throw new AppError('PROFILE_IN_USE', 'Esta pasta já está aberta em outro processo')
}
