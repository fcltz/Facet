import type { Container } from '../../container'
import type { HandlerMap } from '../register'

export function groupHandlers({
  services,
}: Container): Pick<HandlerMap, 'groups.list' | 'groups.create' | 'groups.update' | 'groups.delete'> {
  const { groups } = services
  return {
    'groups.list': () => groups.list(),
    'groups.create': (input) => groups.create(input),
    'groups.update': (input) => groups.update(input),
    'groups.delete': ({ id }) => groups.delete(id),
  }
}
