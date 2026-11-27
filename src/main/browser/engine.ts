import type { ChildProcess } from 'node:child_process'
import type { Profile } from '@shared/schemas/profile'
import type { BrowserInfo, BrowserSource } from '@shared/schemas/browser'
import type { CdpClient } from './cdp/client'
import type { FingerprintConfig } from '@shared/schemas/fingerprint'

export interface BrowserVersion {
  product: string
  userAgent: string
}
export interface LaunchedBrowser {
  child: ChildProcess
  client: CdpClient
  port: number
  endpoint: string
  version: BrowserVersion
}
/** O que o Facet prepara antes de iniciar o navegador. */
export interface LaunchEnvironment {
  /** Valores resolvidos uma vez, antes do início do processo. */
  fingerprint?: FingerprintConfig
  /** Porta do proxy local do perfil; `null` = conexão direta. */
  proxyPort: number | null
  /** Pastas descompactadas para --load-extension (vazio = nenhuma extensão). */
  extensionDirs: string[]
  /**
   * Extensão de identificação do perfil (já incluída em `extensionDirs`): ícone fixado e
   * grupos salvos escondidos da barra de favoritos. null/ausente = identificação desligada.
   */
  identityExtensionId?: string | null
  /** O perfil carrega a extensão Facet: ícone fixado na barra (o popup tem as opções dela). */
  facetExtension?: boolean
  /** Tamanho da janela; ausente = o das opções do perfil ou o padrão (celular: o do aparelho). */
  window?: { width: number; height: number }
}

/** Navegador headless e sem rede aberto na pasta de um perfil fechado. */
export interface OfflineBrowser {
  client: CdpClient
  /** Fecha com Browser.close e, se preciso, encerra só o processo conferido como dele. */
  close(): Promise<void>
}

export interface BrowserEngine {
  info(): BrowserInfo
  detect(): Promise<BrowserInfo>
  validate(path: string, source?: BrowserSource): Promise<BrowserInfo>
  launch(
    profile: Profile,
    directory: string,
    signal: AbortSignal,
    onSpawn: (child: ChildProcess) => Promise<void>,
    environment: LaunchEnvironment,
  ): Promise<LaunchedBrowser>
  connect(
    directory: string,
    signal?: AbortSignal,
  ): Promise<{ client: CdpClient; port: number; endpoint: string; version: BrowserVersion }>
  /**
   * Abre a pasta de um perfil fechado sem janela e sem rede (todo pedido vai a um proxy
   * inexistente), para ler os cookies via CDP sem expor o IP real.
   */
  openOffline(directory: string, signal?: AbortSignal): Promise<OfflineBrowser>
}
