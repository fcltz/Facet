import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LaunchQueue } from '@main/browser/launcher'
import {
  inspectProcess,
  matchesIdentity,
  processUsesDirectory,
  splitCommandLine,
  type ProcessIdentity,
} from '@main/browser/process'
import { clearNativeSession, patchPreferences, preparePreferences } from '@main/browser/preferences'
import { ProfileFiles } from '@main/browser/profile-files'
import { silentLogger } from '@main/logger'

describe('fila e identidade de processos', () => {
  it('limita a três aberturas e remove um item cancelado sem bloquear a fila', async () => {
    const queue = new LaunchQueue()
    const release: (() => void)[] = []
    let active = 0
    let maximum = 0
    const work = async (): Promise<void> => {
      maximum = Math.max(maximum, ++active)
      await new Promise<void>((done) => release.push(done))
      active--
    }
    const running = Array.from({ length: 3 }, () => queue.run(new AbortController().signal, work))
    const abort = new AbortController()
    const cancelled = queue.run(abort.signal, work).catch((error: unknown) => error)
    const last = queue.run(new AbortController().signal, work)
    expect(release).toHaveLength(3)
    abort.abort()
    expect(await cancelled).toMatchObject({ code: 'CANCELLED' })
    release.shift()!()
    await vi.waitFor(() => expect(release).toHaveLength(3))
    release.forEach((done) => done())
    await Promise.all([...running, last])
    expect(maximum).toBe(3)
    expect(active).toBe(0)
  })

  it('não confunde PID reutilizado, outro executável, pasta pessoal ou subprocesso com o dono', () => {
    const directory = resolve('.tmp-tests', 'perfil com espaços')
    const owner: ProcessIdentity = {
      pid: 1234,
      startedAt: '2026-11-25T01:00:00.000Z',
      executablePath: resolve('Brave', 'brave.exe'),
      args: [`--user-data-dir=${directory}`],
    }
    expect(matchesIdentity({ ...owner }, owner, directory)).toBe(true)
    for (const current of [
      null,
      { ...owner, pid: 4321 },
      { ...owner, startedAt: 'mais recente' },
      { ...owner, executablePath: resolve('other.exe') },
      { ...owner, args: [`--user-data-dir=${resolve('.tmp-tests', 'personal')}`] },
      { ...owner, args: [...owner.args, '--type=renderer'] },
    ]) {
      expect(matchesIdentity(current, owner, directory)).toBe(false)
    }
    const parsed = splitCommandLine(
      `"C:\\Program Files\\Brave\\brave.exe" "--user-data-dir=${directory}" --remote-debugging-port=0`,
    )
    expect(parsed).toHaveLength(3)
    expect(processUsesDirectory({ ...owner, args: parsed }, directory)).toBe(true)
  })
})

describe('arquivos de perfil', () => {
  let directory: string | undefined
  const temporary = (): string => {
    fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
    directory = fs.mkdtempSync(resolve('.tmp-tests', 'files-'))
    return directory
  }
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true })
    directory = undefined
  })

  it('preserva preferências existentes e mantém cópia do JSON corrompido', () => {
    const root = temporary()
    const file = join(root, 'Preferences')
    fs.writeFileSync(file, JSON.stringify({ custom: { retained: true }, brave: { setting: 42 } }))
    patchPreferences(file, { brave: { news: false } }, silentLogger)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      custom: { retained: true },
      brave: { setting: 42, news: false },
    })
    fs.writeFileSync(file, '{corrompido')
    patchPreferences(file, { valid: true }, silentLogger)
    const backup = fs.readdirSync(root).find((name) => name.startsWith('Preferences.corrupt-'))!
    expect(fs.readFileSync(join(root, backup), 'utf8')).toBe('{corrompido')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ valid: true })
  })

  it('recusa caminhos externos, links de perfil e links nas preferências', () => {
    const root = temporary()
    const files = new ProfileFiles(join(root, 'managed'))
    expect(() => files.directory('../outside')).toThrow()
    const outside = join(root, 'outside')
    fs.mkdirSync(outside)
    const id = randomUUID()
    fs.symlinkSync(outside, join(files.root, id), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => files.stageDeletion(id)).toThrow()
    const safe = files.prepare(randomUUID())
    fs.symlinkSync(outside, join(safe, 'Default'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => preparePreferences(safe, ['en-US'], silentLogger)).toThrow()
    expect(() => clearNativeSession(safe)).toThrow()
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it('apaga só a sessão nativa (o Facet restaura as abas) e preserva os dados do perfil', () => {
    const root = temporary()
    const profile = join(root, 'Default')
    fs.mkdirSync(join(profile, 'Sessions'), { recursive: true })
    for (const name of ['Session_13370000000000000', 'Tabs_13370000000000000'])
      fs.writeFileSync(join(profile, 'Sessions', name), 'x')
    for (const name of ['Current Session', 'Last Tabs', 'Preferences', 'Cookies'])
      fs.writeFileSync(join(profile, name), 'x')
    clearNativeSession(root)
    expect(fs.readdirSync(join(profile, 'Sessions'))).toEqual([])
    expect(fs.readdirSync(profile).sort()).toEqual(['Cookies', 'Preferences', 'Sessions'])
    expect(() => clearNativeSession(join(root, 'sem-perfil'))).not.toThrow()
  })
})

describe.runIf(process.platform === 'win32')('identificação de processos no Windows', () => {
  it('lê a linha de comando com acentos sem corromper o caminho (C:\\Users\\José…)', async () => {
    const directory = resolve('.tmp-tests', 'perfil-José-çãõ')
    // "--" impede o Node de tratar --user-data-dir como opção dele (sairia com código 9).
    const child = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 20000)', '--', `--user-data-dir=${directory}`],
      { stdio: 'ignore', windowsHide: true },
    )
    try {
      await new Promise<void>((done, fail) => {
        child.once('spawn', done)
        child.once('error', fail)
      })
      const identity = await inspectProcess(child.pid!)
      expect(identity?.args, JSON.stringify(identity)).toContain(`--user-data-dir=${directory}`)
      expect(processUsesDirectory(identity!, directory)).toBe(true)
    } finally {
      child.kill()
    }
  }, 30000)
})
