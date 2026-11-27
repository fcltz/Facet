import { Server, type PrepareRequestFunctionOpts } from 'proxy-chain'
import { FACET_EXTENSION_ID, FACET_USAGE_HEADER, FACET_USAGE_URL } from '@shared/facet-extension'
import { AppError } from '@shared/ipc/result'
import type { Logger } from '../logger'
import { redactSecrets } from './upstream'

export interface ForwarderHealth {
  failures: number
  lastError: string | null
  lastErrorAt: number | null
}

/** Bytes trocados com a proxy remota (o que o provedor cobra) desde que o proxy local abriu. */
export interface TrafficSample {
  upload: number
  download: number
  total: number
  /** Taxa (envio + recebimento) desde a amostra anterior. */
  bytesPerSecond: number
  since: number
  at: number
}

const USAGE_HOST = new URL(FACET_USAGE_URL).hostname

export interface ForwarderOptions {
  upstreamUrl: string
  /** 0 (padrão) = o sistema escolhe uma porta livre; ao recuperar uma sessão, a porta anterior. */
  port?: number
  logger: Logger
  onFailure?: (health: ForwarderHealth) => void
  now?: () => number
}

/** Respostas SOCKS5 que vêm do destino (site fora do ar), não de um problema do proxy. */
const SOCKS_TARGET_REPLIES = ['HostUnreachable', 'NetworkUnreachable', 'ConnectionRefused', 'TTLExpired']
/** Respostas ao CONNECT que indicam recusa do próprio proxy (senha, plano, bloqueio). */
const PROXY_REFUSAL_STATUSES = new Set([401, 402, 403, 407])

/** Usuário e senha contidos na URL do proxy remoto (para removê-los das mensagens). */
function credentialsOf(url: string): string[] {
  try {
    const parsed = new URL(url)
    return [parsed.username, parsed.password].filter(Boolean).map((value) => decodeURIComponent(value))
  } catch {
    return []
  }
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0]!.trim()
}

/**
 * Classifica uma linha do registro interno do proxy-chain. O proxy-chain só
 * emite eventos para parte das falhas: quando o proxy remoto recusa a conexão
 * ou cai, ele responde 59x ao navegador e apenas registra a falha. Por isso o
 * servidor abaixo observa o registro (versão fixada em 3.0.3; testes cobrem
 * recusa, senha errada e SOCKS). Devolve a descrição da falha do proxy, ou
 * `null` quando a linha não é falha do proxy (incluindo erros do site de destino).
 */
export function classifyProxyLog(line: string): string | null {
  const connect = /^Failed to connect to upstream proxy: (.*)$/s.exec(line)
  if (connect) return `Falha ao conectar ao proxy: ${firstLine(connect[1]!).replace(/^Error: /, '')}`
  const tunnel = /^Failed to authenticate upstream proxy: (\d+)/.exec(line)
  if (tunnel) {
    const status = Number(tunnel[1])
    if (!PROXY_REFUSAL_STATUSES.has(status)) return null
    return status === 401 || status === 407
      ? `O proxy recusou o usuário ou a senha (HTTP ${status})`
      : `O proxy recusou o túnel (HTTP ${status})`
  }
  const socks = /^Failed to connect to upstream SOCKS proxy (.*)$/s.exec(line)
  if (socks) {
    const message = firstLine(socks[1]!).replace(/^SocksClientError: /, '')
    if (SOCKS_TARGET_REPLIES.some((reply) => message.endsWith(`- ${reply}`))) return null
    return message === 'Socks5 Authentication failed'
      ? 'O proxy SOCKS5 recusou o usuário ou a senha'
      : `Falha no proxy SOCKS5: ${message}`
  }
  // HTTP simples por proxy HTTP: o proxy-chain trata o 407 como erro interno.
  if (/^Request failed with error: .*407 Proxy Authentication Required/s.test(line)) {
    return 'O proxy recusou o usuário ou a senha (HTTP 407)'
  }
  return null
}

/** Servidor do proxy-chain que repassa as falhas do proxy remoto ao contador. */
class ObservedServer extends Server {
  onProxyFailure: ((description: string) => void) | null = null

  override log(connectionId: unknown, str: string): void {
    super.log(connectionId, str)
    const failure = this.onProxyFailure ? classifyProxyLog(str) : null
    if (failure) this.onProxyFailure?.(failure)
  }
}

/**
 * Proxy local sem autenticação, escutando só em 127.0.0.1, que repassa todo o
 * tráfego ao proxy real autenticado. O Brave recebe apenas `127.0.0.1:<porta>`:
 * usuário e senha nunca vão para a linha de comando nem para o navegador. Se
 * este servidor cair, o Brave falha em vez de sair direto (verificado).
 */
export class ProxyForwarder {
  private closed = false
  private readonly state: ForwarderHealth = { failures: 0, lastError: null, lastErrorAt: null }
  /** Bytes das conexões já encerradas; as abertas são somadas na hora. */
  private readonly finished = { upload: 0, download: 0 }
  private last: TrafficSample

  private constructor(
    private readonly server: ObservedServer,
    readonly port: number,
    private readonly now: () => number,
  ) {
    const at = now()
    this.last = { upload: 0, download: 0, total: 0, bytesPerSecond: 0, since: at, at }
  }

  static async open(options: ForwarderOptions): Promise<ProxyForwarder> {
    const now = options.now ?? Date.now
    let instance: ProxyForwarder | null = null
    const server = new ObservedServer({
      port: options.port ?? 0,
      host: '127.0.0.1',
      verbose: false,
      prepareRequestFunction: (request: PrepareRequestFunctionOpts) =>
        instance?.usageResponse(request) ?? { upstreamProxyUrl: options.upstreamUrl },
    })
    try {
      await server.listen()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const portInUse = code === 'EADDRINUSE'
      throw new AppError(
        'PROXY_UNREACHABLE',
        portInUse
          ? `A porta ${options.port} do proxy local está em uso; abra o perfil novamente`
          : `Não foi possível iniciar o proxy local: ${error instanceof Error ? error.message : String(error)}`,
        { reason: portInUse ? 'localProxyPort' : 'localProxy' },
      )
    }
    instance = new ProxyForwarder(server, server.port, now)
    const created = instance
    server.on(
      'connectionClosed',
      ({ stats }: { stats?: { trgTxBytes: number | null; trgRxBytes: number | null } }) => {
        created.finished.upload += stats?.trgTxBytes ?? 0
        created.finished.download += stats?.trgRxBytes ?? 0
      },
    )
    const secrets = [options.upstreamUrl, ...credentialsOf(options.upstreamUrl)]
    server.onProxyFailure = (description) => {
      instance.state.failures++
      instance.state.lastError = redactSecrets(description, secrets)
      instance.state.lastErrorAt = now()
      options.onFailure?.({ ...created.state })
    }
    options.logger.debug(`Proxy local aberto em 127.0.0.1:${created.port}`)
    return created
  }

  /** Bytes trocados com a proxy remota até agora (conexões encerradas e abertas). */
  traffic(): { upload: number; download: number } {
    let { upload, download } = this.finished
    for (const id of this.server.getConnectionIds()) {
      const stats = this.server.getConnectionStats(id)
      upload += stats?.trgTxBytes ?? 0
      download += stats?.trgRxBytes ?? 0
    }
    return { upload, download }
  }

  /** Nova amostra: totais e taxa desde a anterior (o pool chama a cada segundo). */
  sample(): TrafficSample {
    const at = this.now()
    const { upload, download } = this.traffic()
    const total = upload + download
    const elapsed = (at - this.last.at) / 1000
    const bytesPerSecond = elapsed > 0 ? Math.max(0, total - this.last.total) / elapsed : 0
    this.last = { upload, download, total, bytesPerSecond, since: this.last.since, at }
    return { ...this.last }
  }

  /**
   * Gasto da proxy para a extensão Facet, respondido aqui mesmo (sem passar pela proxy remota)
   * e só para o pedido com o cabeçalho da extensão: um site que pedir o mesmo endereço segue para
   * a proxy remota como qualquer domínio inexistente, sem saber que o Facet existe.
   */
  private usageResponse(request: PrepareRequestFunctionOpts) {
    if (!request.isHttp || request.hostname !== USAGE_HOST) return null
    if (request.request.headers[FACET_USAGE_HEADER] !== FACET_EXTENSION_ID) return null
    const { upload, download } = this.traffic()
    const body = JSON.stringify({
      upload,
      download,
      total: upload + download,
      bytesPerSecond: this.last.bytesPerSecond,
      since: this.last.since,
    })
    return {
      customResponseFunction: () => ({
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body,
      }),
    }
  }

  health(): ForwarderHealth {
    return { ...this.state }
  }

  /** Encerra os túneis abertos: as próximas conexões saem com o IP atual do proxy (troca de IP). */
  closeConnections(): void {
    if (!this.closed) this.server.closeConnections()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.server.onProxyFailure = null
    await this.server.close(true)
  }
}
