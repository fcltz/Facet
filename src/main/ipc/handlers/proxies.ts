import type { Container } from '../../container'
import type { HandlerMap } from '../register'

type ProxyChannels =
  | 'proxies.list'
  | 'proxies.get'
  | 'proxies.getPassword'
  | 'proxies.create'
  | 'proxies.update'
  | 'proxies.delete'
  | 'proxies.parseImport'
  | 'proxies.import'
  | 'proxies.check'
  | 'proxies.cancelCheck'
  | 'proxies.testDraft'
  | 'proxies.rotate'

/**
 * Gerenciador de proxies. A senha só sai do processo principal a pedido do formulário de edição
 * (proxies.getPassword); a URL de troca de IP nunca sai.
 */
export function proxyHandlers({ services }: Container): Pick<HandlerMap, ProxyChannels> {
  const { proxies } = services
  return {
    'proxies.list': () => proxies.list(),
    'proxies.get': ({ id }) => proxies.get(id),
    'proxies.getPassword': ({ id }) => proxies.password(id),
    'proxies.create': (input) => proxies.create(input),
    'proxies.update': ({ id, patch }) => proxies.update(id, patch),
    'proxies.delete': ({ ids, confirmInUse }) => proxies.delete(ids, confirmInUse),
    'proxies.parseImport': ({ text, defaultType }) => proxies.parseImport(text, defaultType),
    'proxies.import': ({ text, defaultType, checkAfter }) => proxies.import(text, defaultType, checkAfter),
    'proxies.check': ({ ids }) => proxies.check(ids),
    'proxies.cancelCheck': () => proxies.cancelCheck(),
    'proxies.testDraft': (input) => proxies.testDraft(input),
    'proxies.rotate': ({ id }) => proxies.rotate(id),
  }
}
