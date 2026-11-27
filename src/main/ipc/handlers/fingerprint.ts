import type { Container } from '../../container'
import type { HandlerMap } from '../register'

export function fingerprintHandlers({
  services,
}: Container): Pick<HandlerMap, 'fingerprint.generate' | 'fingerprint.session'> {
  return {
    'fingerprint.generate': ({ os, current, fresh, browser }) =>
      services.fingerprint.generate(os, current, fresh, browser),
    'fingerprint.session': ({ id }) => services.fingerprint.session(id),
  }
}
