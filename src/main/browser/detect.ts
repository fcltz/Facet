import { constants } from 'node:fs'
import { access, readdir, realpath, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const exec = promisify(execFile)

/**
 * Caminho registrado em `App Paths` (HKCU e HKLM), como o Windows encontra `chrome.exe` ou
 * `opera.exe`. O valor pode vir entre aspas (o Opera grava assim).
 */
export async function registeredAppPaths(executable: string): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const found: string[] = []
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const { stdout } = await exec(
        'reg.exe',
        ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executable}`, '/ve'],
        { windowsHide: true, timeout: 5000 },
      )
      const value = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(stdout)?.[1]?.trim()
      if (value) found.push(value.replace(/^"(.*)"$/, '$1'))
    } catch {
      /* instalação por usuário ou registro pode não existir */
    }
  }
  return found
}

/** Primeiro nome encontrado no PATH (Linux). */
async function which(names: readonly string[]): Promise<string[]> {
  const found: string[] = []
  for (const name of names) {
    try {
      const out = (await exec('which', [name], { timeout: 3000 })).stdout.trim()
      if (out) found.push(out)
    } catch {
      /* tenta o próximo nome */
    }
  }
  return found
}

/** Primeiro candidato que existe (e é executável fora do Windows), com o caminho real. */
export async function firstExisting(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
      if (!(await stat(candidate)).isFile()) continue
      return await realpath(candidate)
    } catch {
      /* tenta a próxima instalação */
    }
  }
  return null
}

function roots(...variables: (string | undefined)[]): string[] {
  return variables.filter((value): value is string => Boolean(value))
}

/** Onde cada navegador costuma ficar instalado (o registro vem antes, quando existe). */
export async function installCandidates(kind: 'chrome' | 'brave' | 'opera'): Promise<string[]> {
  const env = process.env
  if (process.platform === 'win32') {
    const programFiles = roots(env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA)
    switch (kind) {
      case 'chrome':
        return [
          ...(await registeredAppPaths('chrome.exe')),
          ...programFiles.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
        ].filter((candidate) => !/chromium/i.test(candidate))
      case 'brave':
        return [
          ...programFiles.map((root) =>
            path.join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
          ),
          ...(await registeredAppPaths('brave.exe')),
        ]
      case 'opera':
        // Instalação por usuário em Programs\Opera (padrão) ou para todos em Arquivos de Programas.
        return [
          ...(await registeredAppPaths('opera.exe')),
          ...roots(env.LOCALAPPDATA).map((root) => path.join(root, 'Programs', 'Opera', 'opera.exe')),
          ...roots(env.LOCALAPPDATA).map((root) => path.join(root, 'Programs', 'Opera', 'launcher.exe')),
          ...roots(env.PROGRAMFILES, env['PROGRAMFILES(X86)']).map((root) =>
            path.join(root, 'Opera', 'opera.exe'),
          ),
          ...roots(env.PROGRAMFILES, env['PROGRAMFILES(X86)']).map((root) =>
            path.join(root, 'Opera', 'launcher.exe'),
          ),
        ]
    }
  }
  if (process.platform === 'darwin') {
    const app = {
      chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome',
      brave: 'Brave Browser.app/Contents/MacOS/Brave Browser',
      opera: 'Opera.app/Contents/MacOS/Opera',
    }[kind]
    return [
      path.join('/Applications', app),
      ...roots(env.HOME).map((home) => path.join(home, 'Applications', app)),
    ]
  }
  return which(
    {
      chrome: ['google-chrome', 'google-chrome-stable'],
      brave: ['brave-browser', 'brave-browser-stable', 'brave'],
      opera: ['opera', 'opera-stable'],
    }[kind],
  )
}

const VERSION_DIR = /^\d+\.\d+\.\d+\.\d+$/

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 4; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * O Opera instala um lançador na raiz (`opera.exe` ou `launcher.exe`) e o navegador numa pasta
 * por versão (`140.0.6074.36\opera.exe`). O lançador abre o navegador e sai: o Facet precisa do
 * processo do navegador (ele identifica o perfil pelo processo que iniciou). Devolve o
 * `opera.exe` da versão mais nova instalada; um caminho que já é o navegador volta igual.
 */
export async function operaBrowserExecutable(candidate: string): Promise<string> {
  if (process.platform !== 'win32') return candidate
  const directory = path.dirname(candidate)
  let versions: string[]
  try {
    versions = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && VERSION_DIR.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersions)
      .reverse()
  } catch {
    return candidate
  }
  for (const version of versions) {
    const browser = await firstExisting([path.join(directory, version, 'opera.exe')])
    if (browser) return browser
  }
  return candidate
}
