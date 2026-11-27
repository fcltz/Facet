import { toast } from 'sonner'
import type { EventChannel, InvokeChannel } from '@shared/ipc/channels'
import type { ChannelOutput, InvokeArgs } from '@shared/ipc/contract'
import type { EventPayloads } from '@shared/ipc/events'
import { AppError, isValidationIssueList } from '@shared/ipc/result'
import { tr } from '@renderer/i18n'

/**
 * Cliente tipado do IPC. Desembrulha o envelope Result: em caso de erro lança
 * um AppError com o código vindo do processo principal.
 */
export async function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<ChannelOutput<C>> {
  const result = await window.api.invoke(channel, args[0])
  if (result.ok) return result.data
  throw AppError.fromPayload(result.error)
}

export function subscribe<E extends EventChannel>(
  event: E,
  listener: (payload: EventPayloads[E]) => void,
): () => void {
  return window.api.on(event, listener)
}

/** Erros cujo motivo exato (manifest inválido, falha no chrome.storage…) vem do processo principal. */
const DETAILED_CODES = new Set(['EXTENSION_INVALID', 'EXTENSION_CONFIG_FAILED'])

/** Valores dos detalhes do erro usados nas traduções (ex.: nomes das extensões, IP real). */
function interpolation(details: unknown): Record<string, unknown> | undefined {
  const { names, ip } = (details ?? {}) as { names?: unknown; ip?: unknown }
  const values: Record<string, unknown> = {}
  if (Array.isArray(names)) values.names = names.join(', ')
  if (typeof ip === 'string') values.ip = ip
  return Object.keys(values).length ? values : undefined
}

/** Mensagem traduzida para qualquer erro vindo do IPC. */
export function describeError(error: unknown): string {
  if (error instanceof AppError) {
    if (error.code === 'PROFILES_ROOT_INVALID') {
      const problem = (error.details as { problem?: string } | undefined)?.problem
      if (problem) return tr(`storageSettings.problems.${problem}`, error.message)
    }
    const reason = (error.details as { reason?: unknown } | undefined)?.reason
    const options = interpolation(error.details)
    if (error.code === 'CONFLICT' && reason === 'duplicateName') return tr('validation.duplicateName')
    if (error.code === 'CONFLICT' && reason === 'trashed') return tr('errors.trashed')
    if (error.code === 'CONFLICT' && reason === 'duplicateEndpoint') return tr('validation.duplicateEndpoint')
    // motivo específico (ex.: porta do proxy local ocupada) tem mensagem própria
    if (typeof reason === 'string') {
      const specific = tr(`errorReasons.${reason}`, '', options)
      if (specific) return specific
    }
    if (error.code === 'VALIDATION_ERROR' && isValidationIssueList(error.details)) {
      const issue = error.details[0]
      if (issue) {
        const message = tr(`validation.${issue.message}`, issue.message)
        return issue.path ? `${issue.path}: ${message}` : message
      }
    }
    const translated = tr(`errors.${error.code}`, error.message, options)
    if (DETAILED_CODES.has(error.code) && translated !== error.message)
      return `${translated}: ${error.message}`
    return translated
  }
  return error instanceof Error ? error.message : String(error)
}

export function toastError(error: unknown, title?: string): void {
  const message = describeError(error)
  if (title) toast.error(title, { description: message })
  else toast.error(message)
}
