// Compila o utilitário da barra de tarefas (native/win-helper/FacetWinHelper.cs) com o csc do
// .NET Framework 4, que acompanha o Windows 10/11. Fora do Windows não faz nada. Só recompila
// quando o código-fonte é mais novo que o executável.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = path.join(root, 'native', 'win-helper', 'FacetWinHelper.cs')
const output = path.join(root, 'build', 'facet-win-helper.exe')

if (process.platform !== 'win32') process.exit(0)
if (existsSync(output) && statSync(output).mtimeMs >= statSync(source).mtimeMs) process.exit(0)

const windows = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows'
const csc = ['Framework64', 'Framework']
  .map((folder) => path.join(windows, 'Microsoft.NET', folder, 'v4.0.30319', 'csc.exe'))
  .find((file) => existsSync(file))
if (!csc) {
  process.stderr.write(
    'csc.exe do .NET Framework 4 não encontrado (vem com o Windows 10/11): o utilitário da barra de tarefas não foi compilado.\n',
  )
  process.exit(1)
}
mkdirSync(path.dirname(output), { recursive: true })
const result = spawnSync(
  csc,
  ['-nologo', '-target:winexe', '-platform:x64', '-optimize+', `-out:${output}`, source],
  { encoding: 'utf8', windowsHide: true },
)
if (result.status !== 0) {
  process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  process.exit(result.status ?? 1)
}
process.stdout.write(`Utilitário da barra de tarefas compilado em ${output}\n`)
