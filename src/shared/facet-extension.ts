/**
 * Extensão Facet, que vem dentro do app (resources/facet-extension). O ID é derivado da chave
 * pública do manifest (`key`) e não muda entre versões; não é uma credencial.
 */
export const FACET_EXTENSION_ID = 'afidfmghojomlblkphfndjnaipnmcglb'
export const FACET_EXTENSION_ORIGIN = `chrome-extension://${FACET_EXTENSION_ID}`

/**
 * Endereço que a extensão Facet consulta para saber o gasto da proxy. O pedido passa pelo proxy
 * local do perfil, que responde sozinho (sem repassar à proxy remota) quando traz o cabeçalho
 * abaixo. `.test` é reservado (RFC 2606): sem o cabeçalho, o pedido segue como um domínio
 * inexistente. O background.js da extensão usa o mesmo endereço e cabeçalho.
 */
export const FACET_USAGE_URL = 'http://usage.facet.test/'
/**
 * Cabeçalho (com o ID da extensão) que identifica o pedido da Facet. Um site não consegue
 * enviá-lo: cabeçalho próprio num pedido para outra origem exige uma pré-checagem CORS, que segue
 * para a proxy remota e falha. A extensão é isenta de CORS nos hosts que pode acessar, e o
 * Chromium não manda `Origin` nos pedidos dela (verificado no Brave 158).
 */
export const FACET_USAGE_HEADER = 'x-facet-usage'

/** Extensões que vêm com o app: não são excluídas nem substituídas, e não geram avisos de permissão. */
export function isBuiltinExtension(extension: { source: string }): boolean {
  return extension.source === 'builtin'
}
