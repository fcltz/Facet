// Garante o binário do Electron antes de rodar o app, o pacote ou os testes E2E.
// O .npmrc desliga os scripts de instalação (o better-sqlite3 tentaria compilar com o
// Visual Studio), então o download do Electron, que seria um postinstall, é feito aqui.
// O install.js do Electron sai na hora quando a versão certa já está instalada.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const installer = join(root, 'node_modules', 'electron', 'install.js')

if (!existsSync(installer)) {
  console.error('Dependências ausentes: rode "npm ci" antes deste comando.')
  process.exit(1)
}

const result = spawnSync(process.execPath, [installer], { cwd: root, stdio: 'inherit' })
if (result.error) {
  console.error('Não foi possível baixar o Electron:', result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 1)
