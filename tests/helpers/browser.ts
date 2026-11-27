import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { BROWSER_KINDS, type BrowserKind } from '@shared/constants'
import type { Container, ContainerDeps } from '@main/container'
import { createLogger, silentLogger, type Logger } from '@main/logger'

/**
 * Navegador das suítes de integração (todas abrem um navegador real). Padrão: Brave, como antes
 * dos vários navegadores; `FACET_TEST_BROWSER=ungoogled|chrome|opera` roda as mesmas suítes em
 * outro navegador.
 */
export const TEST_BROWSER: BrowserKind = (() => {
  const value = process.env.FACET_TEST_BROWSER ?? 'brave'
  if (!(BROWSER_KINDS as readonly string[]).includes(value))
    throw new Error(`FACET_TEST_BROWSER inválido: ${value}`)
  return value as BrowserKind
})()

/** Ungoogled Chromium de vendor/ (scripts/fetch-ungoogled-chromium.mjs). */
export const BUNDLED_BROWSER = resolve('vendor', 'ungoogled-chromium', 'chrome.exe')
export const hasBundledBrowser = existsSync(BUNDLED_BROWSER)

/** Dependências do container para os testes: o Ungoogled de vendor/ e só o navegador padrão sondado. */
export const testBrowserDeps: Pick<ContainerDeps, 'bundledBrowserPath' | 'detectBrowsers'> = {
  bundledBrowserPath: hasBundledBrowser ? BUNDLED_BROWSER : null,
  detectBrowsers: 'default',
}

/**
 * Log do app nos testes de integração: nada por padrão; com `FACET_TEST_LOG_DIR`, grava avisos e
 * erros nessa pasta (para investigar uma falha que só aparece com a máquina ocupada).
 */
export function testLogger(name: string): Logger {
  const dir = process.env.FACET_TEST_LOG_DIR
  return dir ? createLogger({ dir, fileName: `${name}.log`, minLevel: 'debug' }) : silentLogger
}

/** Perfis novos no navegador dos testes; chamar antes de `initialize` (que sonda o padrão). */
export function useTestBrowser<T extends Container>(app: T, kind: BrowserKind = TEST_BROWSER): T {
  app.services.settings.update({ defaultBrowser: kind })
  return app
}
