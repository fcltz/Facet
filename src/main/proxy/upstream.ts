import { formatHost, type ProxyType } from '@shared/schemas/proxy'

export interface UpstreamProxy {
  type: ProxyType
  host: string
  port: number
  username: string
  password: string | null
}

/**
 * URL do proxy real para o proxy-chain. SOCKS5 vai sempre como `socks5h`: com
 * `socks5` o proxy-chain resolve o DNS localmente nas requisições HTTP simples
 * (vazamento verificado na pesquisa da Etapa 3). Credenciais são codificadas
 * para aceitar `:`, `@`, `/` e acentos.
 */
export function upstreamUrl(proxy: UpstreamProxy): string {
  const scheme = proxy.type === 'socks5' ? 'socks5h' : proxy.type
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@`
    : ''
  return `${scheme}://${auth}${formatHost(proxy.host)}:${proxy.port}`
}

/** Descrição segura para logs e mensagens: nunca inclui usuário ou senha. */
export function describeUpstream(proxy: Pick<UpstreamProxy, 'type' | 'host' | 'port'>): string {
  return `${proxy.type}://${formatHost(proxy.host)}:${proxy.port}`
}

/** Remove credenciais de URLs e os segredos informados de um texto antes de registrar ou exibir. */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let result = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')
  for (const secret of secrets) {
    if (!secret || secret.length < 3) continue
    for (const variant of new Set([secret, encodeURIComponent(secret)])) {
      result = result.split(variant).join('***')
    }
  }
  return result
}
