import type { Container } from '../../container'
import { inDocuments, pickOpenFile, pickSaveFile, safeFileName } from '../dialogs'
import type { HandlerMap } from '../register'

type TransferChannels =
  | 'transfer.export'
  | 'transfer.pickImport'
  | 'transfer.unlock'
  | 'transfer.import'
  | 'transfer.discard'
  | 'jobs.cancel'

const FILTERS = [{ name: 'Pacote de perfis do Facet', extensions: ['zip'] }]

export function transferHandlers({ services, jobs }: Container): Pick<HandlerMap, TransferChannels> {
  const { transfer, profiles } = services
  return {
    'transfer.export': async ({ jobId, ids, options }) => {
      const name =
        ids.length === 1 ? safeFileName(profiles.get(ids[0]!).name, 'perfil') : `facet-${ids.length}-perfis`
      const file = await pickSaveFile({
        title: 'Exportar perfis',
        defaultPath: inDocuments(`${name}.zip`),
        filters: FILTERS,
      })
      if (!file) return { file: null, profiles: 0, bytes: 0, cookies: 0, stopped: 0 }
      return transfer.export(jobId, ids, options, file)
    },
    'transfer.pickImport': async () => {
      const file = await pickOpenFile({
        title: 'Importar perfis',
        properties: ['openFile'],
        filters: FILTERS,
      })
      return file ? transfer.open(file) : null
    },
    'transfer.unlock': ({ token, password }) => transfer.unlock(token, password),
    'transfer.import': ({ jobId, token, keys }) => transfer.import(jobId, token, keys),
    'transfer.discard': ({ token }) => transfer.discard(token),
    'jobs.cancel': ({ jobId }) => jobs.cancel(jobId),
  }
}
