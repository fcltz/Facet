export const ERROR_CODES = [
  'FINGERPRINT_UNSUPPORTED',
  'FINGERPRINT_FAILED',
  'FINGERPRINT_GEO_REQUIRED',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'CONFLICT',
  'PROFILE_RUNNING',
  'UNKNOWN_CHANNEL',
  'FORBIDDEN_SENDER',
  'INTERNAL',
  'BROWSER_NOT_FOUND',
  'BROWSER_START_FAILED',
  'BROWSER_STOP_FAILED',
  'BROWSER_DISCONNECTED',
  'PROFILE_IN_USE',
  'PROXY_UNAVAILABLE',
  'PROXY_AUTH_FAILED',
  'PROXY_UNREACHABLE',
  'PROXY_TIMEOUT',
  'PROXY_IN_USE',
  'PROXY_ROTATE_FAILED',
  'PROXY_REAL_IP',
  'GEOIP_FAILED',
  'EXTENSION_INVALID',
  'EXTENSION_DOWNLOAD_FAILED',
  'EXTENSION_UNAVAILABLE',
  'EXTENSION_NOT_LOADED',
  'EXTENSION_CONFIG_FAILED',
  'EXTENSION_IN_USE',
  'SECRET_UNAVAILABLE',
  'IO_ERROR',
  'CANCELLED',
  'JOB_BUSY',
  'TRANSFER_INVALID',
  'TRANSFER_PASSWORD',
  'BACKUP_INVALID',
  'PROFILES_ROOT_INVALID',
] as const
export type ErrorCode = (typeof ERROR_CODES)[number]

export interface ValidationIssue {
  path: string
  message: string
}

/** Erro serializável que atravessa o IPC (o renderer traduz pelo `code`). */
export interface AppErrorPayload {
  code: ErrorCode
  message: string
  details?: unknown
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorPayload }

export class AppError extends Error {
  readonly code: ErrorCode
  readonly details: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.details = details
  }

  toPayload(): AppErrorPayload {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }

  static fromPayload(payload: AppErrorPayload): AppError {
    return new AppError(payload.code, payload.message, payload.details)
  }
}

export function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

export function fail(error: AppErrorPayload): { ok: false; error: AppErrorPayload } {
  return { ok: false, error }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

export function isValidationIssueList(value: unknown): value is ValidationIssue[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as ValidationIssue).path === 'string' &&
        typeof (item as ValidationIssue).message === 'string',
    )
  )
}
