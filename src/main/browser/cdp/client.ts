import WebSocket from 'ws'
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping'
import { AppError } from '@shared/ipc/result'

type Pending = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}
export class CdpClient {
  private sequence = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
  private closedListeners = new Set<() => void>()
  private closed = false
  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      let message: {
        id?: number
        method?: string
        params?: unknown
        result?: unknown
        error?: { message: string }
        sessionId?: string
      }
      try {
        message = JSON.parse(data.toString()) as typeof message
      } catch {
        return
      }
      if (message.id !== undefined) {
        const request = this.pending.get(message.id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(message.id)
        if (message.error) request.reject(new AppError('BROWSER_START_FAILED', message.error.message))
        else request.resolve(message.result)
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? [])
          listener(message.params, message.sessionId)
      }
    })
    socket.on('close', () => this.didClose())
    socket.on('error', () => this.didClose())
  }
  static async connect(endpoint: string, timeoutMs = 5000, signal?: AbortSignal): Promise<CdpClient> {
    const url = new URL(endpoint)
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1')
      throw new AppError('BROWSER_START_FAILED', 'CDP deve ser local')
    signal?.throwIfAborted()
    const socket = new WebSocket(endpoint, { handshakeTimeout: timeoutMs })
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        socket.terminate()
        reject(new AppError('CANCELLED', 'Abertura cancelada'))
      }
      signal?.addEventListener('abort', abort, { once: true })
      socket.once('error', (error) => {
        signal?.removeEventListener('abort', abort)
        reject(error)
      })
      socket.once('open', () => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) {
          abort()
          return
        }
        resolve(new CdpClient(socket))
      })
    })
  }
  send<M extends keyof ProtocolMapping.Commands>(
    method: M,
    params: ProtocolMapping.Commands[M]['paramsType'][0],
    sessionId?: string,
    timeoutMs = 5000,
  ): Promise<ProtocolMapping.Commands[M]['returnType']> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new AppError('BROWSER_DISCONNECTED', 'Conexão CDP encerrada'))
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new AppError('BROWSER_DISCONNECTED', `Timeout CDP: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, sessionId }), (error) => {
        if (!error) return
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      })
    })
  }
  on<M extends keyof ProtocolMapping.Events>(
    method: M,
    listener: (params: ProtocolMapping.Events[M][0], sessionId?: string) => void,
  ): () => void {
    const wrapped = listener as (params: unknown, sessionId?: string) => void
    const set = this.listeners.get(method) ?? new Set()
    set.add(wrapped)
    this.listeners.set(method, set)
    return () => {
      set.delete(wrapped)
    }
  }
  onClose(listener: () => void): () => void {
    this.closedListeners.add(listener)
    return () => {
      this.closedListeners.delete(listener)
    }
  }
  close(): void {
    this.socket.terminate()
    this.didClose()
  }
  private didClose(): void {
    if (this.closed) return
    this.closed = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new AppError('BROWSER_DISCONNECTED', 'Conexão CDP perdida'))
    }
    this.pending.clear()
    for (const listener of this.closedListeners) listener()
    this.listeners.clear()
    this.closedListeners.clear()
  }
}
