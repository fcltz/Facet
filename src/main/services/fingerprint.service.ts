import type { BrowserKind } from '@shared/constants'
import type { OsName } from '@shared/schemas/common'
import type {
  FingerprintConfig,
  FingerprintSessionState,
  FingerprintUsage,
} from '@shared/schemas/fingerprint'
import type { BrowserRuntime } from '../browser/launcher'
import { fallbackBrands, previewCapabilities } from '../browser/fingerprint/capabilities'
import { emptyUsage, generateFingerprint } from '../browser/fingerprint/generator'
import type { BrowserRegistry } from '../browser/registry'

export class FingerprintService {
  constructor(
    private readonly browsers: Pick<BrowserRegistry, 'info'> & {
      infos(): { defaultBrowser: BrowserKind }
    },
    private readonly runtime: BrowserRuntime,
    /** Hardware emulado que os perfis já usam ou usaram: o gerador não o repete. */
    private readonly usage: () => FingerprintUsage = emptyUsage,
  ) {}
  /**
   * `fresh` = rascunho novo (perfil novo, troca de sistema ou de modo): os campos que não são de
   * hardware vêm de `current`, sem tela a evitar. Sem ele, a tela de `current` sempre muda.
   */
  async generate(
    os: OsName,
    current?: FingerprintConfig,
    fresh = false,
    browser?: BrowserKind,
  ): Promise<FingerprintConfig> {
    // Versão já sondada (na inicialização, ao trocar o executável e a cada abertura): sondar de
    // novo custaria duas consultas ao registro do Windows a cada sorteio. Sem o navegador, a versão
    // de pré-visualização; UA e Client Hints são recalculados pela versão real em cada abertura.
    const kind = browser ?? this.browsers.infos().defaultBrowser
    const capabilities = this.browsers.info(kind).fingerprintCapabilities ?? previewFor(kind)
    const usage = this.usage()
    return generateFingerprint(os, capabilities, fresh ? { base: current, usage } : { current, usage })
  }
  session(id: string): Promise<FingerprintSessionState> {
    return this.runtime.fingerprintState(id)
  }
}

/** Pré-visualização com as marcas que o navegador costuma informar. */
export function previewFor(kind: BrowserKind, engineMajor?: number) {
  const preview = previewCapabilities(engineMajor)
  return { ...preview, browser: kind, ...fallbackBrands(kind, preview) }
}
