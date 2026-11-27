import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@shared/ipc/result'

const exec = promisify(execFile)
export interface ProcessIdentity {
  pid: number
  startedAt: string
  executablePath: string
  args: string[]
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
async function windowsProcesses(pid?: number): Promise<ProcessIdentity[]> {
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
  const rows = (Array.isArray(raw) ? raw : [raw]) as {
    ProcessId: number
    ExecutablePath: string | null
    CommandLine: string | null
    Started: string
  }[]
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
