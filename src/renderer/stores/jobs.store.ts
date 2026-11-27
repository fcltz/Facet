import { create } from 'zustand'
import { AppError } from '@shared/ipc/result'
import type { JobKind, JobProgressEvent } from '@shared/schemas/jobs'
import { invoke } from '@renderer/lib/ipc'

interface JobsState {
  current: JobProgressEvent | null
  cancelling: boolean
  apply: (event: JobProgressEvent) => void
  cancel: () => Promise<void>
}

export const useJobsStore = create<JobsState>()((set, get) => ({
  current: null,
  cancelling: false,
  apply: (event) => {
    if (get().current?.jobId === event.jobId) set({ current: event })
  },
  cancel: async () => {
    const job = get().current
    if (!job || get().cancelling) return
    set({ cancelling: true })
    try {
      await invoke('jobs.cancel', { jobId: job.jobId })
    } catch (error) {
      set({ cancelling: false })
      throw error
    }
  },
}))

/** Registra antes do IPC para não perder o primeiro evento; libera inclusive em erro/cancelamento. */
export async function runJob<T>(kind: JobKind, action: (jobId: string) => Promise<T>): Promise<T> {
  if (useJobsStore.getState().current) throw new AppError('JOB_BUSY', 'Outra operação em andamento')
  const jobId = crypto.randomUUID()
  useJobsStore.setState({
    current: { jobId, kind, phase: 'preparing', done: 0, total: 0, label: null },
    cancelling: false,
  })
  try {
    return await action(jobId)
  } finally {
    useJobsStore.setState({ current: null, cancelling: false })
  }
}
