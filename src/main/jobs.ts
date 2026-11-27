import type { EmitFn } from '@shared/ipc/events'
import { AppError } from '@shared/ipc/result'
import type { JobKind, JobProgressEvent } from '@shared/schemas/jobs'

export interface JobContext {
  readonly signal: AbortSignal
  /** No máximo um evento a cada 150 ms; o último estado sempre é enviado ao terminar. */
  progress(phase: string, done: number, total: number, label?: string | null): void
}

const THROTTLE_MS = 150

/**
 * Operações longas (exportar, importar, backup, restaurar, mudar a pasta dos perfis):
 * uma pesada por vez, com progresso por evento e cancelamento pelo id da tarefa.
 */
export class JobRunner {
  private current: { id: string; kind: JobKind; controller: AbortController } | null = null

  constructor(private readonly emit: EmitFn) {}

  busy(): JobKind | null {
    return this.current?.kind ?? null
  }

  async run<T>(jobId: string, kind: JobKind, action: (job: JobContext) => Promise<T>): Promise<T> {
    if (this.current) {
      throw new AppError('JOB_BUSY', 'Outra operação longa está em andamento', { kind: this.current.kind })
    }
    const controller = new AbortController()
    this.current = { id: jobId, kind, controller }
    let last = 0
    let pending: JobProgressEvent | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = (): void => {
      if (!pending) return
      this.emit('jobs.progress', pending)
      pending = null
      last = Date.now()
    }
    const job: JobContext = {
      signal: controller.signal,
      progress: (phase, done, total, label = null) => {
        pending = { jobId, kind, phase, done, total, label }
        const wait = THROTTLE_MS - (Date.now() - last)
        if (wait <= 0) {
          clearTimeout(timer)
          timer = undefined
          flush()
        } else if (!timer) {
          timer = setTimeout(() => {
            timer = undefined
            flush()
          }, wait)
        }
      },
    }
    try {
      return await action(job)
    } finally {
      clearTimeout(timer)
      flush()
      this.current = null
    }
  }

  cancel(jobId: string): void {
    if (this.current?.id === jobId)
      this.current.controller.abort(new AppError('CANCELLED', 'Operação cancelada'))
  }
}
