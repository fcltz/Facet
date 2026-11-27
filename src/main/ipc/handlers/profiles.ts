import type { Container } from '../../container'
import type { HandlerMap } from '../register'

type ProfileChannels =
  | 'profiles.list'
  | 'profiles.get'
  | 'profiles.create'
  | 'profiles.bulkCreate'
  | 'profiles.update'
  | 'profiles.clone'
  | 'profiles.moveToGroup'
  | 'profiles.assignProxy'
  | 'profiles.trash'
  | 'profiles.restore'
  | 'profiles.deletePermanently'
  | 'profiles.emptyTrash'
  | 'runtime.statuses'
  | 'runtime.start'
  | 'runtime.stop'
  | 'runtime.restart'

export function profileHandlers({ services }: Container): Pick<HandlerMap, ProfileChannels> {
  const { profiles, trash } = services
  return {
    'profiles.list': ({ scope }) => profiles.list(scope),
    'profiles.get': ({ id }) => profiles.get(id),
    'profiles.create': (input) => profiles.create(input),
    'profiles.bulkCreate': (input) => profiles.bulkCreate(input),
    'profiles.update': ({ id, patch }) => profiles.update(id, patch),
    'profiles.clone': ({ id }) => profiles.clone(id),
    'profiles.moveToGroup': ({ ids, groupId }) => profiles.moveToGroup(ids, groupId),
    'profiles.assignProxy': ({ ids, proxyId }) => profiles.assignProxy(ids, proxyId),
    'profiles.trash': ({ ids }) => trash.trash(ids),
    'profiles.restore': ({ ids }) => trash.restore(ids),
    'profiles.deletePermanently': ({ ids }) => trash.deletePermanently(ids),
    'profiles.emptyTrash': () => trash.emptyTrash(),
    'runtime.statuses': () => profiles.statuses(),
    'runtime.start': ({ ids }) => profiles.start(ids),
    'runtime.stop': ({ ids }) => profiles.stop(ids),
    'runtime.restart': ({ ids }) => profiles.restart(ids),
  }
}
