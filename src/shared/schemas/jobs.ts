import { z } from 'zod'

/** Operações longas do processo principal: uma pesada por vez, com progresso e cancelamento. */
export const JOB_KINDS = ['export', 'import', 'backup', 'restore', 'relocate'] as const
export type JobKind = (typeof JOB_KINDS)[number]

/** Gerado pelo renderer, para acompanhar o progresso antes de a chamada responder. */
export const jobIdSchema = z.uuid('invalidId')

export const jobCancelSchema = z.object({ jobId: jobIdSchema })

export interface JobProgressEvent {
  jobId: string
  kind: JobKind
  /** Etapa atual (chave de tradução em `jobs.phases`). */
  phase: string
  done: number
  total: number
  /** Item em andamento (nome do perfil, por exemplo). */
  label: string | null
}
