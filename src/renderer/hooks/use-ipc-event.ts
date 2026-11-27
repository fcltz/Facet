import { useEffect, useRef } from 'react'
import type { EventChannel } from '@shared/ipc/channels'
import type { EventPayloads } from '@shared/ipc/events'
import { subscribe } from '@renderer/lib/ipc'

/** Assina um evento do processo principal enquanto o componente estiver montado. */
export function useIpcEvent<E extends EventChannel>(
  event: E,
  handler: (payload: EventPayloads[E]) => void,
): void {
  const handlerRef = useRef(handler)

  useEffect(() => {
    handlerRef.current = handler
  })

  useEffect(() => subscribe(event, (payload) => handlerRef.current(payload)), [event])
}
