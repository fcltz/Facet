import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

const alias = {
  '@main': resolve(__dirname, 'src/main'),
  '@renderer': resolve(__dirname, 'src/renderer'),
  '@shared': resolve(__dirname, 'src/shared'),
}

/**
 * A CSP do index.html é estrita (script-src 'self'). Em desenvolvimento o
 * plugin do React injeta um script inline para o Fast Refresh, então só no
 * dev server a política é relaxada. O build de produção mantém a CSP estrita.
 */
function devCspPlugin(): Plugin {
  return {
    name: 'facet-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
    },
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
  },
  preload: {
    resolve: { alias },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias },
    plugins: [react(), tailwindcss(), devCspPlugin()],
  },
})
