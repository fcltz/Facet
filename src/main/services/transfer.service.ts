import type {
  ExportOptions,
  TransferExportResult,
  TransferImportResult,
  TransferPreview,
} from '@shared/schemas/transfer'
import type { JobRunner } from '../jobs'
import { exportProfiles, type ExportDeps } from '../transfer/export'
import { TransferImports, type ImportDeps } from '../transfer/import'

/** Exportar e importar pacotes de perfis como tarefas longas (progresso e cancelamento). */
export class TransferService {
  private readonly imports: TransferImports

  constructor(private readonly deps: { jobs: JobRunner; export: ExportDeps; import: ImportDeps }) {
    this.imports = new TransferImports(deps.import)
  }

  export(
    jobId: string,
    ids: readonly string[],
    options: ExportOptions,
    file: string,
  ): Promise<TransferExportResult> {
    return this.deps.jobs.run(jobId, 'export', (job) =>
      exportProfiles(this.deps.export, ids, options, file, job),
    )
  }

  open(file: string): Promise<TransferPreview> {
    return this.imports.inspect(file)
  }

  unlock(token: string, password: string): Promise<TransferPreview> {
    return this.imports.unlock(token, password)
  }

  import(jobId: string, token: string, keys: readonly string[]): Promise<TransferImportResult> {
    return this.deps.jobs.run(jobId, 'import', (job) => this.imports.import(token, keys, job))
  }

  discard(token: string): void {
    this.imports.discard(token)
  }

  close(): void {
    this.imports.close()
  }
}
