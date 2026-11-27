import fs from 'node:fs'
import path from 'node:path'
import { inspect } from 'node:util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string, ...meta: unknown[]): void
  info(message: string, ...meta: unknown[]): void
  warn(message: string, ...meta: unknown[]): void
  error(message: string, ...meta: unknown[]): void
}

export interface LoggerOptions {
  dir: string
  fileName?: string
  /** Tamanho máximo do arquivo antes de rotacionar (mantém 1 arquivo antigo). */
  maxBytes?: number
  mirrorToConsole?: boolean
  minLevel?: LogLevel
}

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

function formatMeta(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  return inspect(value, { depth: 4, breakLength: Infinity })
}

export function createLogger(options: LoggerOptions): Logger {
  const file = path.join(options.dir, options.fileName ?? 'main.log')
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024
  const minWeight = LEVEL_WEIGHT[options.minLevel ?? 'info']
  fs.mkdirSync(options.dir, { recursive: true })

  let size = fs.existsSync(file) ? fs.statSync(file).size : 0
  let stream = fs.createWriteStream(file, { flags: 'a' })

  const rotate = (): void => {
    stream.end()
    try {
      fs.renameSync(file, `${file}.1`)
    } catch {
      // se a rotação falhar (arquivo travado), continua escrevendo no mesmo arquivo
    }
    stream = fs.createWriteStream(file, { flags: 'a' })
    size = 0
  }

  if (size > maxBytes) rotate()

  const write = (level: LogLevel, message: string, meta: unknown[]): void => {
    if (LEVEL_WEIGHT[level] < minWeight) return
    const suffix = meta.length > 0 ? ` ${meta.map(formatMeta).join(' ')}` : ''
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}${suffix}\n`
    stream.write(line)
    size += Buffer.byteLength(line)
    if (size > maxBytes) rotate()
    if (options.mirrorToConsole) {
      const target = level === 'error' || level === 'warn' ? process.stderr : process.stdout
      target.write(line)
    }
  }

  return {
    debug: (message, ...meta) => write('debug', message, meta),
    info: (message, ...meta) => write('info', message, meta),
    warn: (message, ...meta) => write('warn', message, meta),
    error: (message, ...meta) => write('error', message, meta),
  }
}

/** Logger que descarta tudo (usado nos testes). */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}
