import fs from 'node:fs'
import path from 'node:path'

export interface AppPaths {
  userData: string
  /** Banco e configurações. */
  dataDir: string
  logsDir: string
  /** Uma pasta `--user-data-dir` por perfil (criada na 1ª abertura, a partir da Etapa 2). */
  profilesDir: string
  /** Biblioteca de extensões: extensions/<id>/<pasta-da-versão>/, compartilhada pelos perfis. */
  extensionsDir: string
  settingsFile: string
  databaseFile: string
  /** Arquivos temporários (pacotes sendo montados ou decifrados); limpa ao iniciar. */
  tempDir: string
  /** Backups automáticos quando nenhuma pasta foi escolhida. */
  backupsDir: string
  /** Identificação de cada perfil (extensão, ícones): identity/<id>/, refeita a cada abertura. */
  identityDir: string
}

export function resolveAppPaths(userData: string): AppPaths {
  const dataDir = path.join(userData, 'data')
  return {
    userData,
    dataDir,
    logsDir: path.join(userData, 'logs'),
    profilesDir: path.join(userData, 'profiles'),
    extensionsDir: path.join(userData, 'extensions'),
    settingsFile: path.join(dataDir, 'settings.json'),
    databaseFile: path.join(dataDir, 'facet.sqlite'),
    tempDir: path.join(userData, 'tmp'),
    backupsDir: path.join(userData, 'backups'),
    identityDir: path.join(userData, 'identity'),
  }
}

/** Cria só as pastas usadas nesta etapa (dados e logs). */
export function ensureBaseDirs(paths: AppPaths): void {
  for (const dir of [paths.dataDir, paths.logsDir]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}
