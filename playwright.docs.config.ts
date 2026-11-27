import { defineConfig } from '@playwright/test'

/** Imagens do README (`npm run docs:images`): separado dos testes E2E. */
export default defineConfig({
  testDir: './tests/docs',
  outputDir: './.tmp-docs/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
})
