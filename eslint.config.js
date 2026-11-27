// @ts-check
const js = require('@eslint/js')
const tseslint = require('typescript-eslint')
const reactHooks = require('eslint-plugin-react-hooks')
const globals = require('globals')
const { defineConfig } = require('eslint/config')

module.exports = defineConfig(
  {
    ignores: [
      'out/**',
      'dist/**',
      'release/**',
      'node_modules/**',
      'playwright-report/**',
      'test-results/**',
      'test-results-packaged/**',
      'test-results-profile-ui/**',
      '.tmp-tests/**',
      '.tmp-e2e/**',
      '.tmp-docs/**',
      // Ungoogled Chromium baixado (binários de terceiros)
      'vendor/**',
      // componentes gerados pelo CLI do shadcn (código de terceiros, mantido como veio)
      'src/renderer/components/ui/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['resources/facet-extension/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions, importScripts: 'readonly' } },
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: globals.browser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts',
      '*.config.{ts,js}',
      'scripts/**/*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['eslint.config.js'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'separate-type-imports' }],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
)
