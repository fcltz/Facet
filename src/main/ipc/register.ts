import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { INVOKE_CHANNELS, isInvokeChannel, type InvokeChannel } from '@shared/ipc/channels'
import { ipcContract, type ChannelOutput, type ChannelParsedInput } from '@shared/ipc/contract'
import { AppError, fail, ok, type Result, type ValidationIssue } from '@shared/ipc/result'
import type { Logger } from '../logger'

export type Handler<C extends InvokeChannel> = (
  input: ChannelParsedInput<C>,
) => ChannelOutput<C> | Promise<ChannelOutput<C>>

/** Um handler para cada canal do contrato: falta de handler é erro de compilação. */
export type HandlerMap = { [C in InvokeChannel]: Handler<C> }

export type Invoker = (channel: string, rawInput: unknown) => Promise<Result<unknown>>

/**
 * Núcleo do IPC, sem Electron (testável): valida a entrada com o schema do
 * contrato, executa o handler e devolve sempre um envelope Result serializável.
 */
export function createInvoker(handlers: HandlerMap, logger?: Pick<Logger, 'error'>): Invoker {
  return async (channel, rawInput) => {
    if (!isInvokeChannel(channel)) {
      return fail({ code: 'UNKNOWN_CHANNEL', message: `Canal desconhecido: ${channel}` })
    }
    const parsed = ipcContract[channel].input.safeParse(rawInput)
    if (!parsed.success) {
      const issues: ValidationIssue[] = parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      }))
      return fail({ code: 'VALIDATION_ERROR', message: 'Dados inválidos', details: issues })
    }
    try {
      const handler = handlers[channel] as (input: unknown) => unknown
      return ok(await handler(parsed.data))
    } catch (error) {
      if (error instanceof AppError) return fail(error.toPayload())
      logger?.error(`Falha inesperada no canal ${channel}`, error)
      return fail({ code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) })
    }
  }
}

export interface RegisterOptions {
  logger: Logger
  /** Só a página do próprio app pode chamar o IPC. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean
}

export function registerIpcHandlers(handlers: HandlerMap, options: RegisterOptions): () => void {
  const invoke = createInvoker(handlers, options.logger)
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (event, rawInput: unknown) => {
      if (!options.isTrustedSender(event)) {
        options.logger.warn(`IPC recusado (${channel}) de ${event.senderFrame?.url ?? 'origem desconhecida'}`)
        return fail({ code: 'FORBIDDEN_SENDER', message: 'Origem não autorizada' })
      }
      return invoke(channel, rawInput)
    })
  }
  return () => {
    for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel)
  }
}
