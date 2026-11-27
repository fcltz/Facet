import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { LIMITS } from '@shared/constants'
import { FACET_EXTENSION_ID } from '@shared/facet-extension'
import type { AppDatabase } from '../db/client'
import { settings } from '../db/schema'
import type { Logger } from '../logger'
import type { Repositories } from '../repositories/types'
import type { ExtensionService } from '../services/extension.service'
import type { ExtensionStore } from './store'

/** Linha da tabela `settings` (chave interna, ignorada pelas configurações do app). */
const SEEDED_KEY = '_builtinFacetSeeded'

/** Primeira instalação da Facet já feita neste banco (fica junto nos backups). */
export interface SeedMarker {
  get(): boolean
  set(version: string): void
}

export function settingsSeedMarker(db: AppDatabase, now: () => number): SeedMarker {
  return {
    get: () => Boolean(db.select().from(settings).where(eq(settings.key, SEEDED_KEY)).get()),
    set: (version) => {
      db.insert(settings)
        .values({ key: SEEDED_KEY, value: { version }, updatedAt: now() })
        .onConflictDoNothing()
        .run()
    },
  }
}

export interface BuiltinFacetDeps {
  /** Pasta da extensão dentro do app (resources/facet-extension). */
  directory: string
  repos: Repositories
  service: Pick<ExtensionService, 'installBuiltin' | 'setDefault' | 'assign'>
  store: Pick<ExtensionStore, 'resolveForLaunch'>
  seeded: SeedMarker
  logger: Logger
}

function bundledVersion(directory: string): string {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')) as {
    version?: unknown
  }
  if (typeof manifest.version !== 'string') throw new Error('manifest.json da Facet sem versão')
  return manifest.version
}

/**
 * Instala, atualiza ou repara a extensão Facet ao iniciar o app. Na primeira vez ela vira
 * padrão para perfis novos e entra nos perfis que já existem; depois disso, as escolhas do
 * usuário (desmarcar o padrão, tirar de um perfil) valem também nas próximas versões.
 * Falhas só vão para o log: o app abre sem a extensão.
 */
export async function ensureBuiltinFacet(deps: BuiltinFacetDeps): Promise<void> {
  try {
    const version = bundledVersion(deps.directory)
    const existing = deps.repos.extensions.row(FACET_EXTENSION_ID)
    let intact = false
    if (existing) {
      try {
        deps.store.resolveForLaunch([existing])
        intact = true
      } catch {
        // pasta apagada ou incompleta: reinstala abaixo
      }
    }
    // A reinstalação troca só os arquivos: padrão, modo e vínculos com perfis ficam.
    if (!existing || !intact || existing.source !== 'builtin' || existing.version !== version) {
      await deps.service.installBuiltin(deps.directory, FACET_EXTENSION_ID)
    }
    if (deps.seeded.get()) return
    deps.repos.transaction(() => {
      deps.service.setDefault([FACET_EXTENSION_ID], true)
      const eligible = deps.repos.profiles
        .list('active')
        .filter(
          (profile) =>
            !profile.extensionIds.includes(FACET_EXTENSION_ID) &&
            profile.extensionIds.length < LIMITS.extensionsPerProfileMax,
        )
        .map((profile) => profile.id)
      if (eligible.length > 0) deps.service.assign(FACET_EXTENSION_ID, eligible, true)
      deps.seeded.set(version)
    })
    deps.logger.info(`Extensão Facet ${version} instalada como padrão`)
  } catch (error) {
    deps.logger.error('A extensão Facet integrada não pôde ser instalada', error)
  }
}
