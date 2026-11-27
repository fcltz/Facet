/// <reference types="vite/client" />
import type { FacetBridge } from '@shared/ipc/contract'

declare global {
  interface Window {
    /** Exposto pelo preload (src/preload/index.ts). */
    readonly api: FacetBridge
  }
}

export {}
