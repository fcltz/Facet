import fs from 'node:fs'
import path from 'node:path'
import type { DirectoryFilter } from '../archive/zip-writer'

/**
 * O que entra de uma pasta de perfil (verificado no Brave 158): na raiz só `Local State`
 * e `Default/`. O resto da raiz são métricas, caches de GPU e componentes que o Brave
 * baixa de novo. Dentro de `Default/` ficam de fora os caches e os arquivos de trabalho.
 *
 * - `portable` (pacote de exportação): também sem o banco de cookies e as senhas salvas,
 *   cifrados com a chave DPAPI do usuário do Windows (ilegíveis em outra máquina). Os
 *   cookies vão em `cookies.json`, lidos via CDP.
 * - `backup` (restauração no mesmo usuário): tudo menos caches.
 */
export type ProfileDataMode = 'portable' | 'backup'

const CACHE_DIRS = new Set([
  'cache',
  'code cache',
  'gpucache',
  'dawngraphitecache',
  'dawnwebgpucache',
  'graphitedawncache',
  'grshadercache',
  'shadercache',
  'blob_storage',
  'download service',
  // Sessão nativa: o Facet apaga antes de cada abertura e restaura as abas por conta própria.
  'sessions',
  'sessions_encrypted',
])
const SERVICE_WORKER_CACHES = new Set(['cachestorage', 'scriptcache'])
const WORK_FILES = new Set(['lock', 'log', 'log.old', 'lockfile'])
const PORTABLE_EXCLUDED = new Set(['network/cookies', 'login data', 'login data for account'])

function same(value: string | undefined, expected: string): boolean {
  return value?.toLowerCase() === expected.toLowerCase()
}

export function profileDataFilter(mode: ProfileDataMode): DirectoryFilter {
  return (segments, isDirectory) => {
    const [top, ...rest] = segments
    if (rest.length === 0) return isDirectory ? same(top, 'Default') : same(top, 'Local State')
    if (!same(top, 'Default')) return false
    const name = segments[segments.length - 1]!.toLowerCase()
    if (!isDirectory && (WORK_FILES.has(name) || name.endsWith('-journal'))) return false
    if (isDirectory && rest.length === 1 && CACHE_DIRS.has(name)) return false
    if (
      isDirectory &&
      rest.length === 2 &&
      same(rest[0], 'Service Worker') &&
      SERVICE_WORKER_CACHES.has(name)
    )
      return false
    if (mode === 'portable' && !isDirectory && PORTABLE_EXCLUDED.has(rest.join('/').toLowerCase()))
      return false
    return true
  }
}

/** `Local State` sem a chave dos dados cifrados (DPAPI): o Brave cria uma nova na 1ª abertura. */
export function sanitizeLocalState(raw: Buffer): Buffer | null {
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    delete (parsed as Record<string, unknown>).os_crypt
    return Buffer.from(JSON.stringify(parsed), 'utf8')
  } catch {
    return null
  }
}

/**
 * Pasta importada de um pacote: garante que nada cifrado com a chave de outro usuário
 * fique no lugar (mesmo de um pacote montado à mão). Os cookies entram via CDP.
 */
export function sanitizeImportedProfile(directory: string): void {
  const localState = path.join(directory, 'Local State')
  if (fs.existsSync(localState)) {
    const clean = sanitizeLocalState(fs.readFileSync(localState))
    if (clean) fs.writeFileSync(localState, clean)
    else fs.rmSync(localState, { force: true })
  }
  const defaultDir = path.join(directory, 'Default')
  for (const relative of [
    ['Network', 'Cookies'],
    ['Network', 'Cookies-journal'],
    ['Login Data'],
    ['Login Data-journal'],
    ['Login Data For Account'],
    ['Login Data For Account-journal'],
  ]) {
    fs.rmSync(path.join(defaultDir, ...relative), { force: true })
  }
}
