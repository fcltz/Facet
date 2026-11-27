import type { Container } from '../../container'
import type { HandlerMap } from '../register'

export function tagHandlers({
  services,
}: Container): Pick<HandlerMap, 'tags.list' | 'tags.create' | 'tags.update' | 'tags.delete'> {
  const { tags } = services
  return {
    'tags.list': () => tags.list(),
    'tags.create': (input) => tags.create(input),
    'tags.update': (input) => tags.update(input),
    'tags.delete': ({ id }) => tags.delete(id),
  }
}
