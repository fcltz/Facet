import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { uniqueServiceWorker } from '@main/extensions/manifest'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function extension(manifest: Record<string, unknown>, files: Record<string, string> = {}): string {
  fs.mkdirSync(path.resolve('.tmp-tests'), { recursive: true })
  const root = fs.mkdtempSync(path.resolve('.tmp-tests', 'sw-'))
  directories.push(root)
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest))
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true })
    fs.writeFileSync(path.join(root, name), content)
  }
  return root
}
const manifestOf = (root: string) =>
  JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as {
    background?: { service_worker?: string; type?: string }
    name?: string
  }

describe('service worker com nome próprio por versão instalada', () => {
  it('copia o script ao lado do original e aponta o manifest para a cópia', () => {
    const root = extension(
      { name: 'X', background: { service_worker: 'js/sw.js', type: 'module' } },
      { 'js/sw.js': 'import "./lib.js"', 'js/lib.js': '' },
    )
    uniqueServiceWorker(root, 'ab12cd34')
    expect(manifestOf(root)).toEqual({
      name: 'X',
      background: { service_worker: 'js/sw.facet-ab12cd34.js', type: 'module' },
    })
    expect(fs.readFileSync(path.join(root, 'js', 'sw.facet-ab12cd34.js'), 'utf8')).toBe('import "./lib.js"')
    // o original continua lá (outros arquivos podem citá-lo)
    expect(fs.existsSync(path.join(root, 'js', 'sw.js'))).toBe(true)
  })

  it('não mexe sem service worker, com caminho para fora da pasta ou manifest ilegível', () => {
    const plain = extension({ name: 'Sem', background: { scripts: ['a.js'] } })
    uniqueServiceWorker(plain, 'ab12cd34')
    expect(manifestOf(plain).background).toEqual({ scripts: ['a.js'] })
    const outside = extension({ background: { service_worker: '../fora.js' } })
    uniqueServiceWorker(outside, 'ab12cd34')
    expect(manifestOf(outside).background?.service_worker).toBe('../fora.js')
    const missing = extension({ background: { service_worker: 'nao-existe.js' } })
    uniqueServiceWorker(missing, 'ab12cd34')
    expect(manifestOf(missing).background?.service_worker).toBe('nao-existe.js')
    const broken = extension({})
    fs.writeFileSync(path.join(broken, 'manifest.json'), '{ quebrado')
    expect(() => uniqueServiceWorker(broken, 'ab12cd34')).not.toThrow()
  })
})
