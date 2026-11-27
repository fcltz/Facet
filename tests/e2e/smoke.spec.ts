import { execFile } from 'node:child_process'
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { _electron as electron, expect, test as base } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { FACET_EXTENSION_ID } from '../../src/shared/facet-extension'
import type { FacetBridge } from '../../src/shared/ipc/contract'
import {
  fakeWebStore,
  makeCrx3,
  makeKey,
  makeZip,
  writeExtension,
  zipFolder,
  type FakeWebStore,
} from '../helpers/extension-fixtures'
import {
  fakeGeoServer,
  fakeRemoteProxy,
  SAO_PAULO,
  TOKYO,
  type FakeGeoServer,
  type FakeRemoteProxy,
} from '../helpers/fake-network'

interface Desktop {
  page: Page
  userData: string
  /** Processo principal do app (para simular diálogos nativos). */
  application: () => ElectronApplication
  restart: () => Promise<Page>
  crashAndRestart: () => Promise<Page>
}

const execFileAsync = promisify(execFile)

interface BraveWindow {
  pid: number
  /** 0 = o processo não tem janela principal visível. */
  handle: number
  title: string
}

/**
 * Processos principais dos navegadores (Ungoogled Chromium e Chrome são chrome.exe) que usam a
 * pasta de dados deste teste (somente Windows).
 */
async function browserWindows(userData: string): Promise<BraveWindow[]> {
  const script =
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='brave.exe' OR Name='chrome.exe' OR Name='opera.exe'\" | " +
    "Where-Object { $_.CommandLine -notlike '*--type=*' } | ForEach-Object { " +
    '$g = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; ' +
    '[pscustomobject]@{ pid = $_.ProcessId; command = $_.CommandLine; ' +
    'handle = $(if ($g) { [int64]$g.MainWindowHandle } else { 0 }); ' +
    "title = $(if ($g) { $g.MainWindowTitle } else { '' }) } }) | ConvertTo-Json -Compress"
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      windowsHide: true,
      timeout: 20000,
    },
  )
  const raw: unknown = stdout.trim() ? JSON.parse(stdout) : []
  const rows = (Array.isArray(raw) ? raw : [raw]) as {
    pid: number
    command: string | null
    handle: number
    title: string
  }[]
  const needle = userData.toLowerCase()
  // A detecção dos navegadores em segundo plano também roda sondagens dentro desta pasta, mas elas
  // não são perfis: contá-las tornava os testes dependentes de quando a detecção termina.
  const probes = join(userData, 'browser-probes').toLowerCase()
  return rows
    .filter((row) => {
      const command = row.command?.toLowerCase() ?? ''
      return command.includes(needle) && !command.includes(probes)
    })
    .map(({ pid, handle, title }) => ({ pid, handle, title }))
}

/** Espera o processo sumir (process.kill com sinal 0 só testa a existência). */
async function waitForPidExit(pid: number, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`O processo ${pid} não encerrou em ${timeoutMs} ms`)
}

/**
 * Cópia da extensão Facet sem internet: o IP e a velocidade são consultados numa porta local
 * fechada (falha na hora). O app empacotado usa a pasta dele e ignora a variável.
 */
let offlineFacet: string | null = null
function offlineFacetDir(): string {
  if (offlineFacet) return offlineFacet
  const directory = resolve('.tmp-e2e', 'facet-offline')
  rmSync(directory, { recursive: true, force: true })
  cpSync(resolve('resources', 'facet-extension'), directory, { recursive: true })
  const file = join(directory, 'core.js')
  const source = readFileSync(file, 'utf8')
  const patched = source
    .replace('https://www.cloudflare.com/cdn-cgi/trace', 'http://127.0.0.1:9/cdn-cgi/trace')
    .replace('https://speed.cloudflare.com/__down?bytes=', 'http://127.0.0.1:9/__down?bytes=')
  if ((patched.match(/127\.0\.0\.1:9/g) ?? []).length !== 2)
    throw new Error('Endereços da Facet não encontrados')
  writeFileSync(file, patched)
  offlineFacet = directory
  return directory
}

// Cada teste usa seu próprio userData; nenhum dado da instalação do usuário é alterado.
const test = base.extend<{ desktop: Desktop; showWelcome: boolean }>({
  showWelcome: [false, { option: true }],
  desktop: async ({ showWelcome }, use, testInfo) => {
    const userData = testInfo.outputPath('user-data')
    await mkdir(userData, { recursive: true })
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(entry[0]),
      ),
    )
    const rendererErrors: string[] = []
    let application: ElectronApplication | undefined
    let page: Page | undefined
    let firstLaunch = true

    const launch = async (): Promise<Page> => {
      application = await electron.launch({
        executablePath: process.env.FACET_E2E_EXECUTABLE,
        args: process.env.FACET_E2E_EXECUTABLE ? [] : [resolve('.')],
        // Sem emulação: a media query deve acompanhar nativeTheme do Electron.
        colorScheme: null,
        env: {
          ...env,
          FACET_USER_DATA_DIR: userData,
          FACET_E2E_NO_RELAUNCH: '1',
          FACET_TEST_BUILTIN_EXTENSION_DIR: offlineFacetDir(),
        },
      })
      page = await application.firstWindow()
      page.on('pageerror', (error) => rendererErrors.push(error.message))
      page.on('console', (message) => {
        if (message.type() === 'error') rendererErrors.push(message.text())
      })
      await expect(page.getByTestId('welcome').or(page.getByTestId('sidebar'))).toBeVisible()
      if (!showWelcome) {
        if (firstLaunch) {
          // Os cenários existentes começam no painel, passando pelas boas-vindas reais.
          await page.getByTestId('welcome-language-pt-BR').click()
          await page.getByTestId('welcome-next').click()
          await page.getByTestId('welcome-next').click()
          await page.getByTestId('welcome-finish').click()
        }
        await expect(page.getByTestId('sidebar')).toBeVisible()
        await expect(page.getByTestId('new-profile')).toBeVisible()
      }
      if (firstLaunch) {
        // Sem internet nos testes: perfis sem URLs iniciais abrem em branco, e não no
        // browserscan.net. Só na 1ª abertura: os reinícios preservam o que o teste configurou.
        firstLaunch = false
        const updated = await page.evaluate(() =>
          (Reflect.get(globalThis, 'api') as FacetBridge).invoke('settings.update', { startPage: '' }),
        )
        expect(updated.ok, JSON.stringify(updated)).toBe(true)
      }
      return page
    }

    try {
      await use({
        page: await launch(),
        userData,
        application: () => application!,
        restart: async () => {
          await application?.close().catch(() => undefined)
          return launch()
        },
        crashAndRestart: async () => {
          const current = application!
          const launcher = current.process()
          const launcherExited =
            launcher.exitCode !== null
              ? Promise.resolve()
              : new Promise<void>((done) => launcher.once('exit', () => done()))
          // No Windows o electron.exe iniciado pelo Playwright é só um lançador: o processo
          // principal real é filho dele. Mata exatamente o principal (queda abrupta, sem
          // before-quit); o Brave gerenciado não é derrubado e deve ser recuperado.
          const mainPid = await current.evaluate(() => process.pid)
          process.kill(mainPid)
          await waitForPidExit(mainPid)
          await launcherExited
          return launch()
        },
      })
    } finally {
      if (page && !page.isClosed()) {
        await page.screenshot({ path: testInfo.outputPath('last-screen.png') }).catch(() => undefined)
      }
      await application?.close().catch(() => undefined)
    }
    expect(rendererErrors, 'O renderer não deve registrar erros').toEqual([])
  },
})

const nav = (page: Page, destination: string) =>
  page.locator(`[data-testid="nav-item"][data-page="${destination}"]`)

test.describe('boas-vindas', () => {
  test.use({ showWelcome: true })

  test('três idiomas, dois temas, detecção e padrão persistem após concluir e reiniciar', async ({
    desktop,
  }) => {
    test.setTimeout(120000)
    let page = desktop.page
    await expect(page.getByTestId('welcome')).toBeVisible()
    await expect(page.getByTestId('sidebar')).toHaveCount(0)
    await page.keyboard.press('Control+n')
    await page.keyboard.press('Control+,')
    await expect(page.getByTestId('profile-drawer')).toHaveCount(0)
    for (const [language, title] of [
      ['pt-BR', 'Bem-vindo ao Facet'],
      ['en', 'Welcome to Facet'],
      ['es', 'Bienvenido a Facet'],
    ] as const) {
      await page.getByTestId(`welcome-language-${language}`).click()
      await expect(page.locator('html')).toHaveAttribute('lang', language)
      await expect(page.locator('#welcome-title')).toHaveText(title)
    }
    await page.screenshot({ path: test.info().outputPath('welcome-language-es.png') })
    await page.getByTestId('welcome-next').click()
    await page.getByTestId('welcome-theme-light').click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await page.screenshot({ path: test.info().outputPath('welcome-theme-light.png') })
    await page.getByTestId('welcome-theme-dark').click()
    await expect(page.locator('html')).toHaveClass(/dark/)
    await page.screenshot({ path: test.info().outputPath('welcome-theme-dark.png') })
    await page.getByTestId('welcome-next').click()
    await expect(page.getByTestId('welcome-browser-ungoogled-status')).toContainText('Incluido en Facet')
    await page.getByTestId('welcome-detect').click()
    await expect(page.getByTestId('welcome-browsers-found')).toHaveText(/\d+ navegadores? encontrados?/, {
      timeout: 60000,
    })
    await expect(page.getByTestId('welcome-browser-brave')).toBeEnabled()
    await page.getByTestId('welcome-browser-brave').click()
    await expect(page.getByTestId('welcome-browser-brave')).toHaveAttribute('aria-checked', 'true')
    await page.screenshot({ path: test.info().outputPath('welcome-browsers.png') })
    await page.getByTestId('welcome-finish').click()
    await expect(page.getByTestId('sidebar')).toBeVisible()
    await expect(page.getByTestId('welcome')).toHaveCount(0)
    await expect(page.getByTestId('profile-drawer')).toHaveCount(0)
    page = await desktop.restart()
    await expect(page.getByTestId('welcome')).toHaveCount(0)
    await expect(page.getByTestId('new-profile')).toHaveText('Nuevo perfil')
    await expect(page.locator('html')).toHaveClass(/dark/)
    const settings = await page.evaluate(() =>
      (Reflect.get(globalThis, 'api') as FacetBridge).invoke('settings.get'),
    )
    expect(settings).toMatchObject({
      ok: true,
      data: {
        language: 'es',
        theme: 'dark',
        defaultBrowser: 'brave',
        onboardingCompleted: true,
      },
    })
    await page.getByTestId('new-profile').click()
    await expect(page.getByTestId('profile-browser')).toContainText('Brave')
    await page.getByTestId('profile-name-input').fill('Primer perfil')
    await page.getByTestId('drawer-submit').click()
    await expect(page.getByTestId('profile-row')).toHaveCount(1)
  })

  test('abertura interrompida mantém idioma e tema e continua exigindo a conclusão', async ({ desktop }) => {
    let page = desktop.page
    await page.getByTestId('welcome-language-es').click()
    await page.getByTestId('welcome-next').click()
    await page.getByTestId('welcome-theme-light').click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    page = await desktop.restart()
    await expect(page.getByTestId('welcome')).toBeVisible()
    await expect(page.getByTestId('welcome-language-es')).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('html')).toHaveAttribute('lang', 'es')
    await expect(page.locator('html')).not.toHaveClass(/dark/)
    await page.getByTestId('welcome-next').click()
    await expect(page.getByTestId('welcome-theme-light')).toHaveAttribute('aria-checked', 'true')
    const settings = await page.evaluate(() =>
      (Reflect.get(globalThis, 'api') as FacetBridge).invoke('settings.get'),
    )
    expect(settings).toMatchObject({ ok: true, data: { onboardingCompleted: false } })
  })

  test('falha ao salvar mantém a etapa e o navegador escolhido sem abrir o painel', async ({ desktop }) => {
    test.setTimeout(120000)
    const { page } = desktop
    await page.getByTestId('welcome-next').click()
    await page.getByTestId('welcome-next').click()
    await expect(page.getByTestId('welcome-browser-brave-status')).not.toContainText(
      /Verificando|Checking|Comprobando/,
      { timeout: 60000 },
    )
    await expect(page.getByTestId('welcome-browser-brave')).toBeEnabled()
    await page.getByTestId('welcome-browser-brave').click()
    // Simula uma falha de gravação pelo mesmo contrato IPC, só nesta instância de teste.
    await desktop.application().evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('settings.update')
      ipcMain.handle('settings.update', async () => {
        await new Promise((done) => setTimeout(done, 750))
        return { ok: false, error: { code: 'INTERNAL_ERROR', message: 'Falha de gravação simulada' } }
      })
    })
    await page.getByTestId('welcome-finish').click()
    await expect(page.getByTestId('welcome-finish')).toBeDisabled()
    await expect(page.getByTestId('sidebar')).toHaveCount(0)
    await expect(page.getByTestId('welcome-finish')).toBeEnabled()
    await expect(page.getByTestId('welcome-browser-brave')).toHaveAttribute('aria-checked', 'true')
    const settings = await page.evaluate(() =>
      (Reflect.get(globalThis, 'api') as FacetBridge).invoke('settings.get'),
    )
    expect(settings).toMatchObject({ ok: true, data: { onboardingCompleted: false } })
  })
})

async function chooseNativeFile(desktop: Desktop, file: string, save = false): Promise<void> {
  await desktop.application().evaluate(
    ({ dialog }, args) => {
      if (args.save)
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: args.file })) as typeof dialog.showSaveDialog
      else
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [args.file] })) as typeof dialog.showOpenDialog
    },
    { file, save },
  )
}

/** Modo e hardware emulado de cada perfil ativo, lidos pelo IPC. */
async function profileHardware(
  page: Page,
): Promise<{ name: string; mode: string; hardware: string; startupUrls: string[] }[]> {
  return page.evaluate(async () => {
    const api = Reflect.get(globalThis, 'api') as FacetBridge
    const list = await api.invoke('profiles.list', { scope: 'active' })
    if (!list.ok) throw new Error(list.error.message)
    return Promise.all(
      list.data.map(async (item) => {
        const full = await api.invoke('profiles.get', { id: item.id })
        if (!full.ok) throw new Error(full.error.message)
        const { mode, os, screen, navigator: hardware } = full.data.fingerprint
        return {
          name: item.name,
          mode,
          hardware: [
            os,
            `${screen.width}x${screen.height}@${screen.pixelRatio}`,
            hardware.hardwareConcurrency,
            hardware.deviceMemory,
          ].join('|'),
          startupUrls: full.data.launchOptions.startupUrls,
        }
      }),
    )
  })
}

async function seed(page: Page, count = 1): Promise<void> {
  const result = await page.evaluate(async (count) => {
    const bridge = Reflect.get(globalThis, 'api') as FacetBridge
    return bridge.invoke('profiles.bulkCreate', {
      count,
      namePrefix: 'Teste',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
    })
  }, count)
  expect(result.ok).toBe(true)
  await expect(page.getByTestId('profile-row').first()).toBeVisible()
}

test('perfis editáveis: tags, grupo e abas com filtros e persistência', async ({ desktop }) => {
  test.setTimeout(90000)
  const { page } = desktop
  await seed(page, 3)
  const ids = await page.evaluate(async () => {
    const api = Reflect.get(globalThis, 'api') as FacetBridge
    const list = await api.invoke('profiles.list', { scope: 'active' })
    const a = await api.invoke('groups.create', { name: 'Clientes A', color: '#5B5BF7' })
    const b = await api.invoke('groups.create', { name: 'Clientes B', color: '#5B5BF7' })
    await api.invoke('groups.create', { name: 'Grupo vazio', color: '#5B5BF7' })
    const tag = await api.invoke('tags.create', { name: 'QA existente', color: '#5B5BF7' })
    if (!list.ok || !a.ok || !b.ok || !tag.ok) throw new Error('Não criou os dados do teste')
    const [first, second] = list.data
    if (!first || !second) throw new Error('Perfis ausentes')
    await api.invoke('profiles.update', {
      id: first.id,
      patch: { groupId: a.data.id, tagIds: [tag.data.id] },
    })
    await api.invoke('profiles.update', { id: second.id, patch: { groupId: b.data.id } })
    return { first: first.id, a: a.data.id, b: b.data.id }
  })
  const row = page.locator(`[data-profile-id="${ids.first}"]`)
  await expect(page.getByTestId('group-tab')).toHaveCount(2)
  await row.getByTestId('inline-tags').click()
  const popup = page.locator('[data-slot="popover-content"]')
  await popup.getByRole('combobox').fill('Nova inline')
  await popup.getByRole('option').filter({ hasText: 'Nova inline' }).click()
  await expect(row.getByTestId('inline-tags')).toHaveAttribute('title', /Nova inline/)
  await expect(popup.getByRole('combobox')).toBeEnabled()
  await popup.getByRole('combobox').fill('QA existente')
  await popup.getByRole('option').filter({ hasText: 'QA existente' }).click()
  await expect(row.getByTestId('inline-tags')).not.toHaveAttribute('title', /QA existente/)
  await page.keyboard.press('Escape')
  await row.getByTestId('inline-group').click()
  await expect(page.getByRole('listbox').locator('input')).toHaveCount(0)
  await page.getByRole('option', { name: 'Clientes B', exact: true }).click()
  await expect(row.getByTestId('inline-group')).toContainText('Clientes B')
  await expect(page.getByTestId('group-tab')).toHaveCount(1)
  await page.getByTestId('group-tab').click()
  await expect(page.getByTestId('profile-row')).toHaveCount(2)
  // Alterar o grupo na própria aba atualiza o filtro imediatamente.
  await row.getByTestId('inline-group').click()
  await page.getByRole('option', { name: 'Sem grupo', exact: true }).click()
  await expect(page.getByTestId('profile-row')).toHaveCount(1)
  await page.getByTestId('inline-group').click()
  await page.getByRole('option', { name: 'Sem grupo', exact: true }).click()
  await expect(page.getByTestId('group-tab-all')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('profile-row')).toHaveCount(3)
  const reopened = await desktop.restart()
  const saved = reopened.locator(`[data-profile-id="${ids.first}"]`)
  await expect(saved.getByTestId('inline-tags')).toContainText('Nova inline')
  await expect(saved.getByTestId('inline-group')).toContainText('Sem grupo')
  await saved.getByTestId('inline-tags').click()
  await reopened.getByRole('option').filter({ hasText: 'QA existente' }).click()
  await expect(saved.getByTestId('inline-tags')).toHaveAttribute('title', /QA existente/)
  await expect(saved.getByTestId('inline-tags')).toContainText('+1')
  await reopened.keyboard.press('Escape')
  await expect(reopened.locator('[data-slot="popover-content"]')).toHaveCount(0)
  const visibleNameWidth = await saved
    .getByTestId('inline-tags')
    .locator('span.truncate')
    .evaluate((element) => element.getBoundingClientRect().width)
  expect(visibleNameWidth).toBeGreaterThan(40)
  await reopened.screenshot({ path: test.info().outputPath('inline-editors.png') })
})

test('view dos perfis: ocultar, redimensionar, reabrir e restaurar o padrão', async ({ desktop }) => {
  test.setTimeout(90000)
  const { page } = desktop
  await seed(page, 3)
  const header = page.locator('[role="columnheader"][data-column="name"]')
  const previous = await header.boundingBox()
  const grip = await page.getByTestId('resize-name').boundingBox()
  if (!previous || !grip) throw new Error('Cabeçalho ausente')
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
  await page.mouse.down()
  await page.mouse.move(grip.x + grip.width / 2 + 150, grip.y + grip.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await header.boundingBox())!.width).toBeGreaterThan(previous.width + 140)
  const width = (await header.boundingBox())!.width
  await page.getByTestId('profile-view').click()
  for (const column of ['serial', 'group', 'tags', 'proxy', 'system', 'lastOpened']) {
    await page.getByTestId(`view-${column}`).click()
    await expect(page.locator(`[role="columnheader"][data-column="${column}"]`)).toHaveCount(0)
  }
  await page.keyboard.press('Escape')
  await expect(page.getByRole('columnheader')).toHaveCount(5)
  await expect
    .poll(async () => {
      const result = await page.evaluate(() =>
        (Reflect.get(globalThis, 'api') as FacetBridge).invoke('settings.get'),
      )
      return result.ok ? result.data.profileTable.hidden.length : -1
    })
    .toBe(6)
  const reopened = await desktop.restart()
  await expect(reopened.getByRole('columnheader')).toHaveCount(5)
  const savedHeader = reopened.locator('[role="columnheader"][data-column="name"]')
  expect((await savedHeader.boundingBox())!.width).toBeCloseTo(width, 0)
  // A largura manual continua exata ao alterar a largura da janela.
  await desktop
    .application()
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 800))
  expect((await savedHeader.boundingBox())!.width).toBeCloseTo(width, 0)
  await reopened.getByTestId('profile-view').click()
  await reopened.getByTestId('view-reset').click()
  await expect(reopened.getByRole('columnheader')).toHaveCount(11)
  const alignment = await reopened.getByTestId('profiles-table').evaluate((table) => {
    const headers = [...table.querySelectorAll('[role="columnheader"][data-column]')]
    const firstRow = table.querySelector('[data-testid="profile-row"]')!
    return headers.every((header) => {
      const cell = firstRow.querySelector(`[data-column="${header.getAttribute('data-column')}"]`)!
      return Math.abs(header.getBoundingClientRect().width - cell.getBoundingClientRect().width) < 1
    })
  })
  expect(alignment).toBe(true)
  await reopened.screenshot({ path: test.info().outputPath('responsive-profiles.png') })
})

test('popup em massa: proxy longo contido, lista externa e quantidade sem setinhas', async ({ desktop }) => {
  const { page } = desktop
  const proxyName = 'Proxy de teste com apelido muito longo para verificar o limite do campo'
  const created = await page.evaluate(
    (name) =>
      (Reflect.get(globalThis, 'api') as FacetBridge).invoke('proxies.create', {
        name,
        type: 'http',
        host: '127.0.0.1',
        port: 19001,
        username: '',
        password: '',
        changeIpUrl: '',
        notes: '',
      }),
    proxyName,
  )
  expect(created.ok).toBe(true)
  await page.getByTestId('new-profile-more').click()
  await page.getByTestId('bulk-create').click()
  const dialog = page.getByTestId('bulk-create-dialog')
  await dialog.locator('#bulk-proxy').click()
  const list = page.getByTestId('bulk-proxy-options')
  await expect(list).toBeVisible()
  expect(await list.evaluate((element) => element.closest('[role="dialog"]') === null)).toBe(true)
  await page.getByRole('option').filter({ hasText: proxyName }).click()
  const inside = async () =>
    dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect()
      return [...element.querySelectorAll('input, button[role="combobox"]')].every((input) => {
        const rect = input.getBoundingClientRect()
        return rect.left >= bounds.left && rect.right <= bounds.right
      })
    })
  expect(await inside()).toBe(true)
  expect(
    await page
      .getByTestId('bulk-count-input')
      .evaluate((element) => element.ownerDocument.defaultView.getComputedStyle(element).appearance),
  ).toBe('textfield')
  await page.getByTestId('bulk-count-input').fill('0')
  await page.getByTestId('bulk-create-submit').click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  await page.getByTestId('bulk-count-input').fill('2')
  await desktop
    .application()
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1100, 760))
  expect(await inside()).toBe(true)
  await dialog.locator('#bulk-proxy').click()
  await expect(list).toBeVisible()
  const box = await list.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(
    (await page.evaluate(() => Reflect.get(globalThis, 'innerWidth') as number)) + 1,
  )
  await page.screenshot({ path: test.info().outputPath('bulk-proxy-dropdown.png') })
  await page.keyboard.press('Escape')
  await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click()
})

test('cookies: prévia, pendentes, arquivo nativo, cópia e aplicação ao abrir', async ({ desktop }) => {
  test.setTimeout(120000)
  const { page } = desktop
  await seed(page)
  await page.getByTestId('profile-name').click()
  await page.getByTestId('drawer-tab-cookies').click()
  const cookie = {
    name: 'facet-e2e',
    value: 'cookie-owned-by-test',
    domain: 'example.test',
    path: '/',
    secure: false,
    httpOnly: true,
    session: false,
    expirationDate: Date.now() / 1000 + 86400,
  }
  const file = test.info().outputPath('cookies.json')
  await writeFile(file, JSON.stringify([cookie, { ...cookie, name: '__Secure-invalid', secure: false }]))
  await chooseNativeFile(desktop, file)
  await page.getByTestId('cookies-file').click()
  await expect(page.getByTestId('cookies-source')).toContainText('facet-e2e')
  await page.getByTestId('cookies-preview').click()
  await expect(page.getByTestId('cookies-summary')).toContainText('1 válidos')
  await expect(page.getByTestId('cookies-summary')).toContainText('1 recusados')
  await page.getByTestId('cookies-import').click()
  await expect(page.getByTestId('cookies-pending')).toContainText('1 cookies pendentes')
  await page.getByTestId('cookies-copy').click()
  await expect
    .poll(async () => desktop.application().evaluate(({ clipboard }) => clipboard.readText()))
    .toContain('cookie-owned-by-test')
  const exported = test.info().outputPath('cookies-exported.json')
  await chooseNativeFile(desktop, exported, true)
  await page.getByTestId('cookies-export').click()
  await expect.poll(async () => readFile(exported, 'utf8').catch(() => '')).toContain('cookie-owned-by-test')
  await page.getByTestId('drawer-submit').click()
  await page.getByTestId('profile-open').click()
  await expect(page.getByTestId('profile-row')).toHaveAttribute('data-status', 'running', { timeout: 30000 })
  await page.getByTestId('profile-name').click()
  await page.getByTestId('drawer-tab-cookies').click()
  await expect(page.getByTestId('cookies-pending')).toContainText('0 cookies pendentes')
  await page.getByTestId('cookies-source').fill(JSON.stringify([{ ...cookie, value: 'live-cookie' }]))
  await page.getByTestId('cookies-preview').click()
  await page.getByTestId('cookies-import').click()
  await expect(page.getByTestId('cookies-result')).toContainText('1 cookies aplicados')
  await page.screenshot({ path: test.info().outputPath('cookies-editor.png') })
  await page.getByTestId('drawer-submit').click()
  await page.getByTestId('profile-stop').click()
  await expect(page.getByTestId('profile-row')).toHaveAttribute('data-status', 'stopped', { timeout: 30000 })
})

test('pacotes: exporta em massa com confirmação, recusa senha errada e importa a prévia', async ({
  desktop,
}) => {
  test.setTimeout(180000)
  const { page } = desktop
  await seed(page, 2)
  await page.getByTestId('profile-open').first().click()
  await expect(page.getByTestId('profile-row').first()).toHaveAttribute('data-status', 'running', {
    timeout: 30000,
  })
  for (const row of await page.getByTestId('profile-row').all()) await row.getByRole('checkbox').check()
  const file = test.info().outputPath('profiles.zip')
  await chooseNativeFile(desktop, file, true)
  await page.getByTestId('bulk-export').click()
  await page.getByTestId('export-password').fill('facet-test-password-123')
  await expect(page.getByTestId('export-submit')).toBeDisabled()
  await page.getByTestId('export-confirm-stop').check()
  await page.getByTestId('export-submit').click()
  await expect(page.getByTestId('export-profiles-dialog')).toBeHidden({ timeout: 60000 })
  expect((await stat(file)).size).toBeGreaterThan(100)
  await expect(page.getByTestId('profile-row').first()).toHaveAttribute('data-status', 'stopped')
  await page.getByTestId('import-profiles').click()
  await chooseNativeFile(desktop, file)
  await page.getByTestId('import-package-pick').click()
  await page.getByTestId('import-password').fill('wrong')
  await page.getByTestId('import-unlock').click()
  await expect(page.getByTestId('import-package-error')).toHaveText('Senha incorreta.')
  await page.getByTestId('import-password').fill('facet-test-password-123')
  await page.getByTestId('import-unlock').click()
  await expect(page.getByTestId('import-package-preview').getByRole('checkbox')).toHaveCount(2)
  await page.screenshot({ path: test.info().outputPath('package-preview.png') })
  await page.getByTestId('import-package-submit').click()
  await expect(page.getByTestId('import-package-result')).toContainText('2 perfis importados', {
    timeout: 60000,
  })
  await page
    .getByTestId('import-profiles-dialog')
    .getByRole('button', { name: 'Fechar', exact: true })
    .first()
    .click()
  await expect(page.getByTestId('profile-row')).toHaveCount(4)
  const reopened = await desktop.restart()
  await expect(reopened.getByTestId('profile-row')).toHaveCount(4)
})

test('armazenamento: move a pasta e faz backup com dados do perfil', async ({ desktop }) => {
  test.setTimeout(150000)
  const { page } = desktop
  await seed(page)
  await page.getByTestId('profile-open').click()
  await expect(page.getByTestId('profile-row')).toHaveAttribute('data-status', 'running', { timeout: 30000 })
  await page.getByTestId('profile-stop').click()
  await expect(page.getByTestId('profile-row')).toHaveAttribute('data-status', 'stopped', { timeout: 30000 })
  const root = test.info().outputPath('moved-profiles'),
    backups = test.info().outputPath('backups')
  await mkdir(root, { recursive: true })
  await mkdir(backups, { recursive: true })
  await nav(page, 'settings').click()
  await chooseNativeFile(desktop, root)
  await page.getByTestId('profiles-root-choose').click()
  await page.getByTestId('profiles-root-move').click()
  await expect(page.getByTestId('profiles-root-dialog')).toBeHidden({ timeout: 30000 })
  await expect(page.getByTestId('profiles-root')).toHaveValue(root)
  await chooseNativeFile(desktop, backups)
  await page.getByTestId('backup-folder-choose').click()
  await page.getByTestId('backup-include-profiles').check()
  await page.getByTestId('backup-run').click()
  await expect(page.getByTestId('backup-state')).toContainText('Último backup:', { timeout: 30000 })
  await page.getByTestId('backup-interval').click()
  await page.getByRole('option', { name: 'Semanal', exact: true }).click()
  await expect(page.getByRole('listbox')).toBeHidden()
  await expect(page.getByTestId('backup-interval')).toHaveText('Semanal')
  await page.screenshot({ path: test.info().outputPath('backup-settings.png') })
  const restarted = await desktop.restart()
  await nav(restarted, 'settings').click()
  await expect(restarted.getByTestId('profiles-root')).toHaveValue(root)
  await expect(restarted.getByTestId('backup-interval')).toHaveText('Semanal')
  await nav(restarted, 'profiles').click()
  await restarted.getByTestId('profile-open').click()
  await expect(restarted.getByTestId('profile-row')).toHaveAttribute('data-status', 'running', {
    timeout: 30000,
  })
  await restarted.getByTestId('profile-stop').click()
  await expect(restarted.getByTestId('profile-row')).toHaveAttribute('data-status', 'stopped', {
    timeout: 30000,
  })
})

test('backup: restaura após reiniciar e preserva o estado anterior', async ({ desktop }) => {
  test.skip(
    Boolean(process.env.FACET_E2E_EXECUTABLE),
    'O pacote reinicia automaticamente; o fluxo completo é exercitado no app de teste.',
  )
  test.setTimeout(90000)
  const { page } = desktop
  await seed(page)
  await nav(page, 'settings').click()
  await page.getByTestId('backup-run').click()
  await expect(page.getByTestId('backup-state')).toContainText('Último backup:', { timeout: 30000 })
  const state = await page.evaluate(() =>
    (Reflect.get(globalThis, 'api') as FacetBridge).invoke('settings.get'),
  )
  if (!state.ok || !state.data.backupState.lastFile) throw new Error('Backup ausente')
  const backupFile = join(desktop.userData, 'backups', state.data.backupState.lastFile)
  await page.evaluate(async () => {
    const bridge = Reflect.get(globalThis, 'api') as FacetBridge
    const list = await bridge.invoke('profiles.list', { scope: 'active' })
    if (list.ok)
      await bridge.invoke('profiles.update', { id: list.data[0]!.id, patch: { name: 'Depois do backup' } })
  })
  await chooseNativeFile(desktop, backupFile)
  await page.getByTestId('backup-restore-pick').click()
  const closed = desktop.application().waitForEvent('close')
  await page.getByTestId('backup-restore-confirm').click()
  await closed
  const restarted = await desktop.restart()
  await expect(restarted.getByTestId('profile-name')).not.toContainText('Depois do backup')
  await expect(restarted.getByTestId('profile-row')).toHaveCount(1)
  expect((await stat(join(desktop.userData, 'pre-restore', 'data', 'facet.sqlite'))).size).toBeGreaterThan(0)
})

test('inicia vazio, mantém o isolamento do renderer e filtra a tabela persistente', async ({ desktop }) => {
  const { page } = desktop
  await expect(page.getByTestId('nav-item')).toHaveCount(6)
  await expect(page.getByTestId('profile-row')).toHaveCount(0)
  await seed(page, 120)
  await expect(page.getByRole('table')).toHaveAttribute('aria-rowcount', '120')
  expect(
    await page.evaluate(() => ({
      require: typeof Reflect.get(globalThis, 'require'),
      process: typeof Reflect.get(globalThis, 'process'),
    })),
  ).toEqual({ require: 'undefined', process: 'undefined' })

  const name = await page.getByTestId('profile-name').first().innerText()
  await page.getByTestId('profiles-search').fill(name)
  await expect(page.getByTestId('profile-row')).toHaveCount(1)
  await expect(page.getByTestId('profile-name')).toHaveText(name)
  await page.getByTestId('profiles-search').fill('sem-resultado-e2e-9c15')
  await expect(page.getByText('Nada encontrado', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Limpar busca e filtros', exact: true }).click()
  await expect(page.getByRole('table')).toHaveAttribute('aria-rowcount', '120')
  const restarted = await desktop.restart()
  await expect(restarted.getByRole('table')).toHaveAttribute('aria-rowcount', '120')
})

test('valida, cria e edita um perfil pelo drawer', async ({ desktop }) => {
  const { page } = desktop
  await seed(page, 3)
  await page.getByTestId('new-profile').click()
  await expect(page.getByTestId('profile-drawer').getByRole('tab')).toHaveCount(6)
  await page.getByTestId('drawer-submit').click()
  await expect(page.getByTestId('profile-name-input')).toHaveAttribute('aria-invalid', 'true')
  await page.getByTestId('profile-name-input').fill('Perfil E2E')
  await page.getByTestId('drawer-tab-fingerprint').click()
  await expect(page.getByTestId('fingerprint-tab')).toBeVisible()
  // perfil novo: Emulação por padrão, já com tela e hardware sorteados (o rascunho padrão
  // deixaria a memória "Controlado pelo Brave"; o sorteio sempre escolhe 4 ou 8 GB)
  await expect(page.getByTestId('fingerprint-mode')).toHaveText('Emulação')
  await expect(page.getByTestId('fingerprint-generate')).toBeEnabled()
  await expect(page.getByTestId('fp-memory')).toHaveText(/^[48] GB$/)
  await page.screenshot({ path: test.info().outputPath('drawer-fingerprint.png') })
  await page.getByTestId('drawer-submit').click()
  await expect(page.getByTestId('profile-drawer')).toBeHidden()
  const all = await profileHardware(page)
  expect(all.map((profile) => profile.mode)).toEqual(['emulated', 'emulated', 'emulated', 'emulated'])
  expect(
    all.every((profile) => /\|[48]$/.test(profile.hardware)),
    JSON.stringify(all),
  ).toBe(true)
  expect(new Set(all.map((profile) => profile.hardware)).size, JSON.stringify(all)).toBe(4)
  await page.getByTestId('profiles-search').fill('Perfil E2E')
  await expect(page.getByTestId('profile-name')).toHaveText('Perfil E2E')

  await page.getByTestId('profile-name').click()
  await page.getByTestId('profile-name-input').fill('Perfil E2E editado')
  await page.getByTestId('drawer-submit').click()
  await expect(page.getByTestId('profile-drawer')).toBeHidden()
  await expect(page.getByTestId('profile-name')).toHaveText('Perfil E2E editado')
})

test('abre e para o Brave real e atualiza o status via IPC', async ({ desktop }) => {
  const { page } = desktop
  await seed(page)
  const row = page.getByTestId('profile-row').first()
  await expect(row).toHaveAttribute('data-status', 'stopped')
  await row.getByTestId('profile-open').click()
  await expect(row).toHaveAttribute('data-status', 'starting')
  await expect(row).toHaveAttribute('data-status', 'running', { timeout: 30000 })
  if (process.platform === 'win32') {
    // Exatamente um processo principal para o perfil, com janela visível para o usuário.
    await expect
      .poll(async () => (await browserWindows(desktop.userData)).map((w) => w.handle !== 0), {
        timeout: 15000,
      })
      .toEqual([true])
  }
  await row.getByTestId('profile-stop').click()
  await expect(row).toHaveAttribute('data-status', 'stopping')
  await expect(row).toHaveAttribute('data-status', 'stopped', { timeout: 30000 })
  if (process.platform === 'win32') expect(await browserWindows(desktop.userData)).toEqual([])
})

test('página inicial: valida o campo nas configurações e o perfil sem URLs iniciais abre nela', async ({
  desktop,
}) => {
  test.setTimeout(90000)
  const { page } = desktop
  const site = await fakeGeoServer()
  const stored = async (): Promise<string | null> => {
    const result = await page.evaluate(() =>
      (Reflect.get(globalThis, 'api') as FacetBridge).invoke('settings.get'),
    )
    return result.ok ? result.data.startPage : null
  }
  try {
    await seed(page)
    await nav(page, 'settings').click()
    const field = page.getByTestId('settings-start-page')
    const save = page.getByTestId('settings-start-page-save')
    const useDefault = page.getByRole('button', { name: 'Usar padrão', exact: true })
    // o ambiente de teste começa com o campo vazio; "Usar padrão" volta ao browserscan.net
    await expect(field).toHaveValue('')
    await expect(field).toHaveAttribute('placeholder', 'about:blank')
    await useDefault.click()
    await expect(field).toHaveValue('https://browserscan.net/')
    await expect(useDefault).toBeHidden()
    await expect.poll(stored).toBe('https://browserscan.net/')
    // sem http/https: mensagem no campo e nada é salvo
    await field.fill('browserscan.net')
    await expect(page.getByText('URL inválida (use http:// ou https://)', { exact: true })).toBeVisible()
    await expect(save).toBeDisabled()
    await field.fill(site.pageUrl)
    await expect(save).toBeEnabled()
    await save.click()
    await expect.poll(stored).toBe(site.pageUrl)
    await expect(field).toHaveValue(site.pageUrl)
    await expect(save).toBeDisabled()
    await field.scrollIntoViewIfNeeded()
    await page.screenshot({ path: test.info().outputPath('start-page-settings.png') })

    // perfil sem URLs iniciais: a primeira página é a configurada
    await nav(page, 'profiles').click()
    const row = page.getByTestId('profile-row').first()
    await row.getByTestId('profile-open').click()
    await expect(row).toHaveAttribute('data-status', 'running', { timeout: 30000 })
    await expect.poll(() => site.hits.page, { timeout: 15000 }).toBeGreaterThan(0)
    await row.getByTestId('profile-stop').click()
    await expect(row).toHaveAttribute('data-status', 'stopped', { timeout: 30000 })
  } finally {
    await site.close()
  }
})

test('clona, move para a lixeira e restaura pela interface', async ({ desktop }) => {
  const { page } = desktop
  await seed(page)
  const originalName = await page.getByTestId('profile-name').first().innerText()
  await page.getByTestId('profile-row').first().getByTestId('row-menu').click()
  await page.getByTestId('menu-clone').click()
  await page.getByTestId('profiles-search').fill(`${originalName} (cópia)`)
  await expect(page.getByTestId('profile-row')).toHaveCount(1)
  const cloneId = await page.getByTestId('profile-row').getAttribute('data-profile-id')
  await page.getByTestId('row-menu').click()
  await page.getByTestId('menu-trash').click()
  await expect(page.getByTestId('profile-row')).toHaveCount(0)
  await nav(page, 'trash').click()
  const trashed = page.getByTestId('trash-row').filter({ hasText: `${originalName} (cópia)` })
  await expect(trashed).toBeVisible()
  await trashed.getByTestId('trash-restore').click()
  await expect(trashed).toHaveCount(0)
  await nav(page, 'profiles').click()
  await expect(page.getByTestId('profile-row')).toHaveAttribute('data-profile-id', cloneId!)
})

test('identificação: coluna ID, busca pelo número, cabeçalho do drawer e configurações simplificadas', async ({
  desktop,
}) => {
  const { page } = desktop
  await seed(page, 3)
  await expect(page.getByTestId('profile-row')).toHaveCount(3)
  expect((await page.getByTestId('profile-serial').allTextContents()).sort()).toEqual(['01', '02', '03'])

  // "#02" encontra o perfil número 2; o drawer mostra "02 · Nome"
  await page.getByTestId('profiles-search').fill('#02')
  await expect(page.getByTestId('profile-row')).toHaveCount(1)
  await expect(page.getByTestId('profile-serial')).toHaveText('02')
  await page.getByTestId('profile-name').click()
  await expect(page.getByTestId('drawer-serial')).toHaveText('02')
  await page.keyboard.press('Escape')
  await page.getByTestId('profiles-search').fill('')

  // As seções removidas não aparecem; a identificação existente continua funcionando.
  await nav(page, 'settings').click()
  await expect(page.getByTestId('settings-identity-inBrowser')).toHaveCount(0)
  await expect(page.getByTestId('settings-identity-taskbar')).toHaveCount(0)
  await expect(page.getByTestId('settings-geoip-provider')).toHaveCount(0)
  await expect(page.getByTestId('settings-geoip-token')).toHaveCount(0)
  await expect(page.getByTestId('settings-extension-tabs')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Aparência', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Navegadores', exact: true })).toBeVisible()
  await expect(page).toHaveTitle('Facet Browsers Antidetect')
  const restarted = await desktop.restart()
  await nav(restarted, 'settings').click()
  await expect(restarted.getByTestId('settings-identity-inBrowser')).toHaveCount(0)
  const saved = await restarted.evaluate(() =>
    (Reflect.get(globalThis, 'api') as FacetBridge).invoke('settings.get'),
  )
  expect(saved).toMatchObject({ ok: true, data: { profileIdentity: { inBrowser: true, taskbar: true } } })
})

test('cria 50 perfis e seleciona um intervalo com Shift', async ({ desktop }) => {
  const { page } = desktop
  await page.getByTestId('new-profile-more').click()
  await page.getByTestId('bulk-create').click()
  await page.getByTestId('bulk-count-input').fill('50')
  await page.locator('#bulk-prefix').fill('Lote E2E')
  await page.getByTestId('bulk-create-submit').click()
  await expect(page.getByTestId('bulk-create-submit')).toBeHidden()
  await page.getByTestId('profiles-search').fill('Lote E2E')
  await expect(page.getByRole('table')).toHaveAttribute('aria-rowcount', '50')
  const created = await profileHardware(page)
  expect(created.every((profile) => profile.mode === 'emulated')).toBe(true)
  expect(new Set(created.map((profile) => profile.hardware)).size).toBe(50)
  const rows = page.getByTestId('profile-row')
  await rows.nth(0).getByRole('checkbox').click()
  await rows
    .nth(4)
    .getByRole('checkbox')
    .click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('bulk-count')).toHaveText('5 selecionados')
  await page.getByTestId('bulk-trash').click()
  await expect(page.getByRole('table')).toHaveAttribute('aria-rowcount', '45', { timeout: 30000 })
  await expect(page.getByTestId('bulk-bar')).toBeHidden()
})

test('criação em massa: página inicial validada, gravada em cada perfil e aberta no Brave', async ({
  desktop,
}) => {
  test.setTimeout(90000)
  const { page } = desktop
  const site = await fakeGeoServer()
  try {
    await page.getByTestId('new-profile-more').click()
    await page.getByTestId('bulk-create').click()
    await page.getByTestId('bulk-count-input').fill('3')
    await page.locator('#bulk-prefix').fill('Inicial')
    const startPage = page.getByTestId('bulk-start-page')
    // vazio = a página inicial das Configurações (no ambiente de teste, em branco)
    await expect(page.getByRole('dialog')).toContainText(
      'Vazio = a página inicial das Configurações (em branco).',
    )
    await startPage.fill('browserscan.net')
    await page.getByTestId('bulk-create-submit').click()
    await expect(page.getByText('URL inválida (use http:// ou https://)', { exact: true })).toBeVisible()
    await expect(startPage).toHaveAttribute('aria-invalid', 'true')
    await startPage.fill(site.pageUrl)
    await page.screenshot({ path: test.info().outputPath('bulk-create-start-page.png') })
    await page.getByTestId('bulk-create-submit').click()
    await expect(page.getByTestId('bulk-create-submit')).toBeHidden()
    await expect(page.getByTestId('profile-row')).toHaveCount(3)
    const created = await profileHardware(page)
    expect(created.map((profile) => profile.startupUrls)).toEqual([
      [site.pageUrl],
      [site.pageUrl],
      [site.pageUrl],
    ])
    expect(new Set(created.map((profile) => profile.hardware)).size).toBe(3)

    // a página informada abre na abertura do perfil
    const row = page.getByTestId('profile-row').first()
    await row.getByTestId('profile-open').click()
    await expect(row).toHaveAttribute('data-status', 'running', { timeout: 30000 })
    await expect.poll(() => site.hits.page, { timeout: 15000 }).toBeGreaterThan(0)
    await row.getByTestId('profile-stop').click()
    await expect(row).toHaveAttribute('data-status', 'stopped', { timeout: 30000 })
  } finally {
    await site.close()
  }
})

test('alterna tema e idioma e mantém as preferências após reiniciar', async ({ desktop }) => {
  let page = desktop.page
  await nav(page, 'settings').click()
  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).not.toHaveClass(/dark/)
  await page.getByTestId('theme-toggle').click()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await page.getByTestId('settings-language').click()
  await page.getByRole('option', { name: 'English', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  page = await desktop.restart()
  await expect(page.locator('html')).toHaveClass(/dark/)
  await expect(page.getByTestId('new-profile')).toHaveText('New profile')
  await page.screenshot({ path: test.info().outputPath('profiles-dark-en.png') })
  await nav(page, 'settings').click()
  await expect(page.getByTestId('theme-dark')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('settings-language')).toHaveText('English')
  await page.getByTestId('theme-system').click()
  await expect(page.getByTestId('theme-system')).toHaveAttribute('aria-checked', 'true')
})

test('recupera o Brave após queda do Electron sem duplicar processo nem contador', async ({ desktop }) => {
  test.setTimeout(120000)
  let page = desktop.page
  await seed(page)
  const browser = await page.evaluate(() =>
    (Reflect.get(globalThis, 'api') as FacetBridge).invoke('browser.getInfo'),
  )
  expect(
    browser.ok && browser.data.browsers.find((item) => item.kind === browser.data.defaultBrowser)?.available,
    JSON.stringify(browser),
  ).toBe(true)
  await page.getByTestId('profile-open').click()
  await expect(page.getByTestId('profile-row')).toHaveAttribute('data-status', 'running', { timeout: 30000 })
  const id = await page.getByTestId('profile-row').getAttribute('data-profile-id')
  const before = process.platform === 'win32' ? await browserWindows(desktop.userData) : []
  if (process.platform === 'win32') expect(before).toHaveLength(1)
  page = await desktop.crashAndRestart()
  await expect(page.getByTestId('profile-row')).toHaveAttribute('data-status', 'running', { timeout: 30000 })
  if (process.platform === 'win32') {
    // O mesmo processo foi reconectado: nenhum Brave novo nasceu durante a recuperação.
    expect((await browserWindows(desktop.userData)).map((w) => w.pid)).toEqual(before.map((w) => w.pid))
  }
  const recovered = await page.evaluate(
    async (id) => (Reflect.get(globalThis, 'api') as FacetBridge).invoke('profiles.get', { id: id! }),
    id,
  )
  expect(recovered.ok && recovered.data.openCount).toBe(1)
  await page.getByTestId('profile-stop').click()
  await expect(page.getByTestId('profile-row')).toHaveAttribute('data-status', 'stopped', { timeout: 30000 })
})

test('valida executável ausente e recupera a detecção automática', async ({ desktop }) => {
  const { page } = desktop
  await seed(page)
  await nav(page, 'settings').click()
  const row = page.getByTestId('browser-ungoogled')
  await expect(page.getByTestId('browser-ungoogled-status')).toContainText('vem com o Facet')
  // "Escolher arquivo" com um executável que não existe: o navegador fica indisponível
  await chooseNativeFile(desktop, 'C:\\Facet-E2E\\missing-browser.exe')
  await row.getByRole('button', { name: 'Selecionar arquivo' }).click()
  await expect(page.getByTestId('browser-ungoogled-status')).toHaveText('Não instalado')
  await nav(page, 'profiles').click()
  await expect(page.getByTestId('browser-unavailable')).toContainText('Ungoogled Chromium indisponível')
  await expect(page.getByTestId('profile-open')).toBeDisabled()
  await nav(page, 'settings').click()
  await page.getByTestId('browser-ungoogled-detect').click()
  await expect(page.getByTestId('browser-ungoogled-status')).toContainText('vem com o Facet')
  await nav(page, 'profiles').click()
  await expect(page.getByTestId('browser-unavailable')).toBeHidden()
  await expect(page.getByTestId('profile-open')).toBeEnabled()
})

test('navegadores: encontra os instalados e o padrão vale para os perfis novos', async ({ desktop }) => {
  test.setTimeout(90000)
  const { page } = desktop
  await nav(page, 'settings').click()
  await expect(page.getByTestId('browser-list').getByRole('listitem')).toHaveCount(4)
  await expect(page.getByTestId('browser-ungoogled-status')).toContainText('vem com o Facet')
  const readBrowsers = () =>
    page.evaluate(async () => {
      const api = Reflect.get(globalThis, 'api') as FacetBridge
      const info = await api.invoke('browser.getInfo')
      if (!info.ok) throw new Error(info.error.message)
      return info.data
    })
  // os outros navegadores são sondados em segundo plano depois que a janela abre
  await expect
    .poll(async () => (await readBrowsers()).browsers.filter((item) => item.checking).length, {
      timeout: 60000,
    })
    .toBe(0)
  const browsers = await readBrowsers()
  expect(browsers.defaultBrowser).toBe('ungoogled')
  // os instalados nesta máquina aparecem como instalados (a busca termina em segundo plano)
  for (const browser of browsers.browsers.filter((item) => item.kind !== 'ungoogled' && item.available))
    await expect(page.getByTestId(`browser-${browser.kind}-status`)).toContainText('instalado')
  await page.getByTestId('browser-list').scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('settings-browsers.png') })
  // padrão = Brave: o formulário de perfil novo já vem com ele
  const brave = browsers.browsers.find((item) => item.kind === 'brave')
  test.skip(!brave?.available, 'Brave não instalado nesta máquina')
  await page.getByTestId('settings-default-browser').click()
  await page.getByTestId('settings-default-browser-brave').click()
  await expect(page.getByTestId('settings-default-browser')).toContainText('Brave')
  await nav(page, 'profiles').click()
  await page.getByTestId('new-profile').click()
  await expect(page.getByTestId('profile-browser')).toContainText('Brave')
  await page.getByTestId('profile-name-input').fill('No Brave')
  await page.getByTestId('drawer-submit').click()
  await expect(page.getByTestId('profile-drawer')).toBeHidden()
  await expect(page.getByTestId('profile-browser-cell')).toContainText('Brave')
})

test('perfil Android: aparelho na aba Fingerprint, coluna Navegador e abertura como celular', async ({
  desktop,
}) => {
  test.setTimeout(120000)
  const { page } = desktop
  await page.getByTestId('new-profile').click()
  await page.getByTestId('profile-name-input').fill('Celular Android')
  await expect(page.getByTestId('profile-browser')).toContainText('Ungoogled Chromium')
  await page.getByTestId('os-android').click()
  await expect(page.getByTestId('os-android')).toHaveAttribute('aria-checked', 'true')
  await page.getByTestId('drawer-tab-fingerprint').click()
  // celular: sempre emulado, com um aparelho do catálogo no lugar de resolução e núcleos
  await expect(page.getByTestId('fp-device')).toBeVisible()
  await expect(page.getByTestId('fp-resolution')).toBeHidden()
  await expect(page.getByTestId('fp-device-summary')).toContainText('GPU')
  await page.getByTestId('fingerprint-mode').click()
  await expect(page.getByTestId('fingerprint-mode-native')).toHaveAttribute('data-disabled', '')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toBeHidden()
  await page.screenshot({ path: test.info().outputPath('drawer-android.png') })
  await page.getByTestId('drawer-submit').click()
  await expect(page.getByTestId('profile-drawer')).toBeHidden()
  const row = page.getByTestId('profile-row').first()
  await expect(row.getByTestId('profile-browser-cell')).toContainText('Ungoogled Chromium')
  await expect(row).toContainText('Android')
  // a busca encontra pelo sistema e pelo navegador
  await page.getByTestId('profiles-search').fill('android ungoogled')
  await expect(page.getByTestId('profile-row')).toHaveCount(1)
  await page.getByTestId('profiles-search').fill('opera')
  await expect(page.getByTestId('profile-row')).toHaveCount(0)
  await page.getByTestId('profiles-search').fill('')
  const fingerprint = await page.evaluate(async () => {
    const api = Reflect.get(globalThis, 'api') as FacetBridge
    const list = await api.invoke('profiles.list', { scope: 'active' })
    if (!list.ok) throw new Error(list.error.message)
    const full = await api.invoke('profiles.get', { id: list.data[0]!.id })
    if (!full.ok) throw new Error(full.error.message)
    return full.data.fingerprint
  })
  expect(fingerprint).toMatchObject({ os: 'android', mode: 'emulated', uaData: { mobile: true } })
  expect(fingerprint.device).toBeTruthy()
  await row.getByTestId('profile-open').click()
  await expect(row).toHaveAttribute('data-status', 'running', { timeout: 30000 })
  await page.screenshot({ path: test.info().outputPath('profiles-android-running.png') })
  await row.getByTestId('profile-stop').click()
  await expect(row).toHaveAttribute('data-status', 'stopped', { timeout: 30000 })
})

test('criação em massa no iPhone: um aparelho diferente para cada perfil', async ({ desktop }) => {
  const { page } = desktop
  await page.getByTestId('new-profile-more').click()
  await page.getByTestId('bulk-create').click()
  await page.getByTestId('bulk-count-input').fill('3')
  await page.locator('#bulk-prefix').fill('iPhone')
  await expect(page.getByTestId('bulk-browser')).toContainText('Ungoogled Chromium')
  await page.getByTestId('bulk-create-dialog').getByTestId('os-ios').click()
  await page.getByTestId('bulk-create-submit').click()
  await expect(page.getByTestId('bulk-create-submit')).toBeHidden()
  await expect(page.getByTestId('profile-row')).toHaveCount(3)
  const devices = await page.evaluate(async () => {
    const api = Reflect.get(globalThis, 'api') as FacetBridge
    const list = await api.invoke('profiles.list', { scope: 'active' })
    if (!list.ok) throw new Error(list.error.message)
    return Promise.all(
      list.data.map(async (item) => {
        const full = await api.invoke('profiles.get', { id: item.id })
        if (!full.ok) throw new Error(full.error.message)
        return [full.data.browser, full.data.os, full.data.fingerprint.device] as const
      }),
    )
  })
  expect(devices.map(([browser, os]) => `${browser}|${os}`)).toEqual(Array(3).fill('ungoogled|ios'))
  expect(new Set(devices.map(([, , device]) => device)).size).toBe(3)
})

test.describe('proxies', () => {
  const password = 'p@ss:w/rd-e2e'
  let geo: FakeGeoServer
  let remote: FakeRemoteProxy

  // Servidores locais: proxy autenticado, trace, geo-IP, URL de troca e página de teste.
  test.beforeAll(async () => {
    geo = await fakeGeoServer()
    remote = await fakeRemoteProxy({ username: 'e2e', password })
    process.env.FACET_TEST_TRACE_URL = geo.traceUrl
    process.env.FACET_TEST_GEOIP_URL = geo.geoUrl
  })
  test.afterAll(async () => {
    delete process.env.FACET_TEST_TRACE_URL
    delete process.env.FACET_TEST_GEOIP_URL
    await remote?.close()
    await geo?.close()
  })

  test('importa, verifica, edita, atribui, abre pelo proxy, troca o IP e exclui com aviso', async ({
    desktop,
  }) => {
    test.setTimeout(180000)
    const { page } = desktop
    const listProxies = () =>
      page.evaluate(() => (Reflect.get(globalThis, 'api') as FacetBridge).invoke('proxies.list'))

    await nav(page, 'proxies').click()
    await expect(page.getByText('Nenhum proxy ainda', { exact: true })).toBeVisible()

    // importação com prévia linha a linha (a senha nunca aparece na prévia)
    await page.getByTestId('proxy-import').click()
    const line = `127.0.0.1:${remote.port}:e2e:${password}`
    await page.getByTestId('import-text').fill([line, line, '999.1.1.1:80'].join('\n'))
    const summary = page.getByTestId('import-summary')
    await expect(summary).toContainText('1 válido')
    await expect(summary).toContainText('1 duplicado')
    await expect(summary).toContainText('1 inválido')
    await expect(page.getByTestId('import-preview')).not.toContainText(password)
    await page.getByTestId('import-submit').click()
    await expect(page.getByTestId('import-dialog')).toBeHidden()

    // verificação automática pelo próprio proxy: online, IP de saída e local
    const row = page.getByTestId('proxy-row')
    await expect(row).toHaveCount(1)
    await expect(row.getByTestId('proxy-status')).toHaveAttribute('data-status', 'online', { timeout: 30000 })
    await expect(row.getByTestId('proxy-exit-ip')).toHaveText(SAO_PAULO.ip)
    await expect(row).toContainText('São Paulo')
    expect(JSON.stringify(await listProxies())).not.toContain(password)

    // edição: a senha salva aparece mascarada no campo; o olho a mostra; nada de "Remover senha"
    await row.getByTestId('proxy-endpoint').click()
    const passwordInput = page.getByTestId('proxy-form-password')
    await expect(passwordInput).toHaveValue(password)
    await expect(passwordInput).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: 'Mostrar senha', exact: true }).click()
    await expect(passwordInput).toHaveAttribute('type', 'text')
    await expect(page.getByText('Remover senha', { exact: true })).toHaveCount(0)
    await page.getByTestId('proxy-form-name').fill('Proxy E2E')
    await page.getByTestId('proxy-form-change-url').fill(geo.rotateUrl)
    await page.getByTestId('proxy-form-test').click()
    await expect(page.getByTestId('proxy-test-result')).toHaveAttribute('data-status', 'online', {
      timeout: 30000,
    })
    await page.getByTestId('proxy-form-submit').click()
    await expect(page.getByTestId('proxy-form')).toBeHidden()
    // o apelido vira o nome do proxy na lista; o endereço desce para a linha de detalhes
    await expect(row.getByTestId('proxy-endpoint')).toHaveText('Proxy E2E')
    await expect(row).toContainText(`127.0.0.1:${remote.port}`)
    await expect(row).toContainText('Rotativo')
    expect(JSON.stringify(await listProxies())).not.toContain('/rotate')

    // perfil com página inicial local, proxy atribuído pelo menu da linha
    await nav(page, 'profiles').click()
    await seed(page)
    const profileRow = page.getByTestId('profile-row')
    const profileId = (await profileRow.getAttribute('data-profile-id'))!
    const updated = await page.evaluate(
      async ({ id, url }) => {
        const api = Reflect.get(globalThis, 'api') as FacetBridge
        const current = await api.invoke('profiles.get', { id })
        if (!current.ok) return current
        return api.invoke('profiles.update', {
          id,
          patch: { launchOptions: { ...current.data.launchOptions, startupUrls: [url] } },
        })
      },
      { id: profileId, url: geo.pageUrl },
    )
    expect(updated.ok, JSON.stringify(updated)).toBe(true)
    await profileRow.getByTestId('row-menu').click()
    await page.getByRole('menuitem', { name: 'Atribuir proxy…' }).click()
    await page.getByTestId('proxy-picker').getByRole('option').filter({ hasText: SAO_PAULO.ip }).click()
    await page.getByTestId('assign-proxy-apply').click()
    // na lista de perfis, o apelido aparece no lugar do IP, que desce para a segunda linha
    await expect(profileRow.getByTestId('proxy-cell')).toContainText('Proxy E2E')
    await expect(profileRow.getByTestId('proxy-cell')).toContainText(SAO_PAULO.ip)

    // abertura real: a página inicial (127.0.0.1) só chega pelo proxy remoto autenticado
    await profileRow.getByTestId('profile-open').click()
    await expect(profileRow).toHaveAttribute('data-status', 'running', { timeout: 30000 })
    await expect
      .poll(() => remote.urls.some((url) => url.startsWith(geo.pageUrl)), { timeout: 20000 })
      .toBe(true)
    // aberto: a coluna Proxy mostra o tráfego com a proxy remota (gráfico do último minuto e taxa)
    const traffic = profileRow.getByTestId('proxy-traffic')
    await expect(traffic).toBeVisible({ timeout: 10000 })
    const rate = profileRow.getByTestId('proxy-traffic-rate')
    await expect(rate).toHaveText(/^[\d.,]+ (B|KB|MB)\/s$/)
    // a taxa aparece inteira mesmo com a coluna estreita (o gráfico é que encolhe)
    expect(await rate.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await expect(profileRow.getByTestId('proxy-cell')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('profiles-proxy-traffic.png') })

    // troca de IP com o perfil aberto: o país muda e o app oferece reiniciar
    await profileRow.getByTestId('row-menu').click()
    await page.getByTestId('menu-rotate-ip').click()
    await expect(page.getByTestId('restart-prompt')).toContainText('outro país', { timeout: 30000 })
    await page.getByRole('button', { name: 'Depois', exact: true }).click()
    await expect(page.getByTestId('restart-prompt')).toBeHidden()
    // o IP novo e o gasto da sessão ficam no tooltip do gráfico
    await traffic.hover()
    await expect(page.getByRole('tooltip')).toContainText(TOKYO.ip)
    await expect(page.getByRole('tooltip')).toContainText(/Gasto da proxy nesta sessão: [\d.,]+ (B|KB|MB)/)
    expect(geo.hits.rotate).toBe(1)
    const synced = await page.evaluate(
      (id) => (Reflect.get(globalThis, 'api') as FacetBridge).invoke('profiles.get', { id }),
      profileId,
    )
    expect(synced.ok && synced.data.fingerprint.timezone.id).toBe('Asia/Tokyo')
    expect(synced.ok && synced.data.fingerprint.languages.list).toEqual(['ja-JP', 'ja', 'en-US', 'en'])

    await profileRow.getByTestId('profile-stop').click()
    await expect(profileRow).toHaveAttribute('data-status', 'stopped', { timeout: 30000 })
    // fechado: a célula volta ao apelido e ao IP de saída
    await expect(profileRow.getByTestId('proxy-cell')).toContainText(TOKYO.ip)
    await expect(profileRow.getByTestId('proxy-traffic')).toHaveCount(0)

    // excluir um proxy em uso exige confirmação e deixa o perfil com conexão direta
    await nav(page, 'proxies').click()
    await row.getByTestId('proxy-menu').click()
    await page.getByTestId('proxy-menu-delete').click()
    await expect(page.getByRole('alertdialog')).toContainText('conexão direta')
    await page.getByTestId('confirm-action').click()
    await expect(page.getByTestId('proxy-row')).toHaveCount(0)
    await nav(page, 'profiles').click()
    await expect(profileRow.getByTestId('proxy-cell')).toHaveCount(0)
    await expect(profileRow).toContainText('Conexão direta')
  })

  test('formulário: erro sem desalinhar, proxy completo colado preenche tudo e o teste passa', async ({
    desktop,
  }) => {
    const { page } = desktop
    await nav(page, 'proxies').click()
    await page.getByTestId('proxy-add').click()
    const host = page.getByTestId('proxy-form-host')

    // a mensagem de erro do host não empurra os campos vizinhos
    await page.getByTestId('proxy-form-submit').click()
    await expect(page.getByTestId('proxy-form').getByText('Campo obrigatório').first()).toBeVisible()
    const tops = await Promise.all(
      [page.getByTestId('proxy-form-type'), host, page.getByTestId('proxy-form-port')].map(
        async (field) => (await field.boundingBox())!.y,
      ),
    )
    expect(Math.max(...tops) - Math.min(...tops), `topos: ${tops.join(', ')}`).toBeLessThanOrEqual(1)
    await page.screenshot({ path: test.info().outputPath('proxy-form-error.png') })

    // colar "host:porta:usuário:senha" no host separa tudo
    await desktop
      .application()
      .evaluate(
        ({ clipboard }, text) => clipboard.writeText(text),
        `127.0.0.1:${remote.port}:e2e:${password}`,
      )
    await host.focus()
    await page.keyboard.press('Control+V')
    await expect(host).toHaveValue('127.0.0.1')
    await expect(page.getByTestId('proxy-form-port')).toHaveValue(String(remote.port))
    await expect(page.getByTestId('proxy-form-username')).toHaveValue('e2e')
    await expect(page.getByTestId('proxy-form-password')).toHaveValue(password)
    await expect(page.getByTestId('proxy-form').getByText('Campo obrigatório')).toHaveCount(0)

    // com o tipo na linha, o tipo também muda; colado no usuário vale do mesmo jeito
    await desktop
      .application()
      .evaluate(({ clipboard }) => clipboard.writeText('socks5://outro:segredo@proxy.exemplo.com:1080'))
    await page.getByTestId('proxy-form-username').focus()
    await page.keyboard.press('Control+V')
    await expect(page.getByTestId('proxy-form-type')).toHaveText('SOCKS5')
    await expect(host).toHaveValue('proxy.exemplo.com')
    await expect(page.getByTestId('proxy-form-username')).toHaveValue('outro')

    // de volta ao proxy de teste: "Testar conexão" sai pelo proxy (IP do servidor de teste)
    await desktop
      .application()
      .evaluate(
        ({ clipboard }, text) => clipboard.writeText(text),
        `http://e2e:${encodeURIComponent(password)}@127.0.0.1:${remote.port}`,
      )
    await host.focus()
    await page.keyboard.press('Control+V')
    await expect(page.getByTestId('proxy-form-type')).toHaveText('HTTP')
    await page.getByTestId('proxy-form-test').click()
    await expect(page.getByTestId('proxy-test-result')).toHaveAttribute('data-status', 'online', {
      timeout: 30000,
    })
    // o servidor de teste é compartilhado no grupo (o teste anterior trocou o IP): vale o atual
    await expect(page.getByTestId('proxy-test-result')).toContainText(geo.current().ip)
    await page.screenshot({ path: test.info().outputPath('proxy-form-pasted.png') })
  })
})

test.describe('proxy com IP real', () => {
  let geo: FakeGeoServer
  let remote: FakeRemoteProxy

  // A "conexão sem proxy" de teste tem o mesmo IP que a saída do proxy.
  test.beforeAll(async () => {
    geo = await fakeGeoServer()
    geo.setRealIp(SAO_PAULO.ip)
    remote = await fakeRemoteProxy()
    process.env.FACET_TEST_TRACE_URL = geo.traceUrl
    process.env.FACET_TEST_GEOIP_URL = geo.geoUrl
    process.env.FACET_TEST_REAL_IP_URL = geo.realIpUrl
  })
  test.afterAll(async () => {
    delete process.env.FACET_TEST_TRACE_URL
    delete process.env.FACET_TEST_GEOIP_URL
    delete process.env.FACET_TEST_REAL_IP_URL
    await remote?.close()
    await geo?.close()
  })

  test('marca o proxy como IP real e recusa abrir o perfil antes de iniciar o Brave', async ({ desktop }) => {
    test.skip(Boolean(process.env.FACET_E2E_EXECUTABLE), 'Servidores de rede de teste só fora do pacote')
    test.setTimeout(90000)
    const { page } = desktop
    await seed(page)

    await nav(page, 'proxies').click()
    await page.getByTestId('proxy-import').click()
    await page.getByTestId('import-text').fill(`127.0.0.1:${remote.port}`)
    await page.getByTestId('import-submit').click()
    await expect(page.getByTestId('import-dialog')).toBeHidden()
    const row = page.getByTestId('proxy-row')
    const status = row.getByTestId('proxy-status')
    await expect(status).toHaveAttribute('data-reason', 'real-ip', { timeout: 30000 })
    await expect(status).toContainText('IP real')
    await expect(row.getByTestId('proxy-exit-ip')).toHaveText(SAO_PAULO.ip)
    await expect(row.getByTestId('proxy-exit-ip')).toHaveAttribute('data-real-ip', 'true')
    await status.hover()
    await expect(page.getByRole('tooltip')).toContainText('os sites veem o seu IP verdadeiro')
    await page.screenshot({ path: test.info().outputPath('proxy-real-ip.png') })

    const assigned = await page.evaluate(async () => {
      const bridge = Reflect.get(globalThis, 'api') as FacetBridge
      const [proxies, profiles] = await Promise.all([
        bridge.invoke('proxies.list'),
        bridge.invoke('profiles.list', { scope: 'active' }),
      ])
      if (!proxies.ok || !profiles.ok) return false
      const result = await bridge.invoke('profiles.assignProxy', {
        ids: [profiles.data[0]!.id],
        proxyId: proxies.data[0]!.id,
      })
      return result.ok
    })
    expect(assigned).toBe(true)
    await nav(page, 'profiles').click()
    await page.getByTestId('profile-open').click()
    await expect(page.getByText(`O proxy está saindo pelo seu IP real (${SAO_PAULO.ip})`)).toBeVisible({
      timeout: 30000,
    })
    await expect(page.getByTestId('profile-row')).not.toHaveAttribute('data-status', 'running')
    expect(await browserWindows(desktop.userData)).toEqual([])
  })
})

/**
 * Conteúdo da tabela de extensões que sai da própria caixa: invade a coluna vizinha ou encosta
 * no elemento ao lado. Texto cortado com reticências (overflow oculto) não conta.
 */
async function extensionTableSpills(page: Page): Promise<string[]> {
  return page.getByTestId('extensions-table').evaluate((table) => {
    // Os testes compilam sem a biblioteca DOM: getComputedStyle vem da janela da própria tabela.
    const view = table.ownerDocument.defaultView
    const spills: string[] = []
    for (const cell of table.querySelectorAll('[role="cell"], [role="columnheader"]')) {
      const box = cell.getBoundingClientRect()
      for (const element of [cell, ...cell.querySelectorAll('*')]) {
        const rect = element.getBoundingClientRect()
        const outside = rect.left < box.left - 0.5 || rect.right > box.right + 0.5
        const spilling =
          view.getComputedStyle(element).overflowX === 'visible' &&
          element.scrollWidth > element.clientWidth + 1
        if (outside || spilling) spills.push(`${element.tagName} "${element.textContent?.trim() ?? ''}"`)
      }
    }
    return spills
  })
}

/** Versões e origens que não aparecem inteiras: cortadas com reticências ou quebradas em linhas. */
async function partialExtensionTexts(page: Page): Promise<string[]> {
  return page
    .getByTestId('extensions-table')
    .locator('[data-testid="extension-version"], [data-testid="extension-source"]')
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const lineHeight = parseFloat(
            element.ownerDocument.defaultView.getComputedStyle(element).lineHeight,
          )
          const cut = element.scrollWidth > element.clientWidth
          const wrapped = element.getBoundingClientRect().height > lineHeight * 1.5
          return cut || wrapped
        })
        .map((element) => element.textContent ?? ''),
    )
}

/** Redimensiona a janela do app e devolve o tamanho anterior. */
async function resizeWindow(
  desktop: Desktop,
  size: { width: number; height: number },
): Promise<{ width: number; height: number }> {
  const { previous, contentWidth } = await desktop.application().evaluate(({ BrowserWindow }, next) => {
    const win = BrowserWindow.getAllWindows()[0]!
    const [width = 0, height = 0] = win.getSize()
    win.unmaximize()
    win.setSize(next.width, next.height)
    return { previous: { width, height }, contentWidth: win.getContentSize()[0] ?? 0 }
  }, size)
  // espera o layout do renderer acompanhar o novo tamanho
  await expect
    .poll(() => desktop.page.evaluate(() => Reflect.get(globalThis, 'innerWidth') as number))
    .toBe(contentWidth)
  return previous
}

test.describe('extensões', () => {
  let web: FakeWebStore
  let sources: string
  const storeKey = makeKey()

  // Chrome Web Store local (CRX assinado), uma extensão em .zip e outra numa pasta temporária.
  test.beforeAll(async () => {
    web = await fakeWebStore()
    web.packages.set(
      storeKey.id,
      makeCrx3(
        makeZip([
          {
            name: 'manifest.json',
            data: JSON.stringify({
              manifest_version: 3,
              name: 'Loja E2E',
              // versão longa como a do uBlock Origin Lite (não pode invadir a coluna Origem)
              version: '2026.1124.1811',
              permissions: ['storage', 'proxy'],
            }),
          },
        ]),
        storeKey,
      ),
    )
    process.env.FACET_TEST_WEBSTORE_URL = web.url
    await mkdir(resolve('.tmp-e2e'), { recursive: true })
    sources = await mkdtemp(join(resolve('.tmp-e2e'), 'extensoes-'))
    writeExtension(
      join(sources, 'pasta'),
      { manifest_version: 3, name: 'Pasta E2E', version: '1.0.0', permissions: ['storage'] },
      { 'sw.js': '' },
    )
    const zipped = writeExtension(
      join(sources, 'zip-src'),
      { manifest_version: 3, name: 'Zip E2E', version: '2026.1124.1811', permissions: ['storage'] },
      { 'js/app.js': 'console.log("zip")' },
    )
    await writeFile(join(sources, 'pacote.zip'), zipFolder(zipped, 'zip-e2e/'))
  })
  test.afterAll(async () => {
    delete process.env.FACET_TEST_WEBSTORE_URL
    await web?.close()
    if (sources) await rm(sources, { recursive: true, force: true })
  })

  /** O seletor nativo abre no processo principal: aqui ele devolve os caminhos da fila, em ordem. */
  /**
   * Abre "Adicionar extensão" e escolhe a opção. Espera a instalação anterior acabar (o botão
   * fica desativado) e reabre o menu se ele fechar no mesmo instante em que o botão volta.
   */
  async function addFrom(page: Page, option: string): Promise<void> {
    await expect(page.getByTestId('extension-add')).toBeEnabled({ timeout: 30000 })
    await expect(async () => {
      if (!(await page.getByTestId(option).isVisible())) await page.getByTestId('extension-add').click()
      await page.getByTestId(option).click({ timeout: 2000 })
    }).toPass({ timeout: 20000 })
  }

  async function pickPaths(desktop: Desktop, paths: string[]): Promise<void> {
    await desktop.application().evaluate(({ dialog }, queue) => {
      dialog.showOpenDialog = (() =>
        Promise.resolve({
          canceled: false,
          filePaths: [queue.shift() ?? ''],
        })) as typeof dialog.showOpenDialog
    }, paths)
  }

  test('Facet integrada, instala por .zip e pasta, marca padrão, configura, entra no perfil novo e exclui com aviso', async ({
    desktop,
  }) => {
    test.setTimeout(120000)
    const { page } = desktop
    await nav(page, 'extensions').click()
    const rows = page.getByTestId('extension-row')

    // a Facet vem com o app: padrão para perfis novos, sem excluir nem substituir
    await expect(rows).toHaveCount(1)
    const facetRow = rows.filter({ hasText: 'Facet' })
    await expect(facetRow.getByTestId('extension-source')).toHaveText('Integrada ao Facet')
    const facetVersion = (
      JSON.parse(readFileSync(resolve('resources', 'facet-extension', 'manifest.json'), 'utf8')) as {
        version: string
      }
    ).version
    await expect(facetRow.getByTestId('extension-version')).toHaveText(facetVersion)
    await expect(facetRow.getByTestId('extension-default')).toHaveAttribute('data-state', 'checked')
    await expect(facetRow.getByTestId('extension-critical-warning')).toHaveCount(0)
    await facetRow.getByTestId('extension-menu').click()
    await expect(page.getByRole('menuitem', { name: 'Configurar' })).toBeVisible()
    await expect(page.getByTestId('extension-menu-add-all')).toBeVisible()
    await expect(page.getByTestId('extension-menu-delete')).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: /Substituir/ })).toHaveCount(0)
    await page.keyboard.press('Escape')

    await pickPaths(desktop, [join(sources, 'pacote.zip'), join(sources, 'pasta')])
    await addFrom(page, 'extension-add-archive')
    await expect(rows).toHaveCount(2)
    const zipRow = rows.filter({ hasText: 'Zip E2E' })
    await expect(zipRow).toContainText('Arquivo .zip')
    await addFrom(page, 'extension-add-folder')
    await expect(rows).toHaveCount(3)
    const folderRow = rows.filter({ hasText: 'Pasta E2E' })
    await expect(folderRow).toContainText('Pasta')

    // padrão pela tabela; o diálogo só tem "Quando aplicar" e "Instalar automaticamente em novos perfis"
    await folderRow.getByTestId('extension-default').click()
    await expect(folderRow.getByTestId('extension-default')).toHaveAttribute('data-state', 'checked')
    await folderRow.getByTestId('extension-configure').click()
    const dialog = page.getByTestId('extension-config-dialog')
    await expect(dialog).toContainText('Configurações da extensão')
    await expect(page.getByTestId('config-mode')).toHaveText('Em toda abertura')
    await expect(page.getByTestId('config-default')).toHaveAttribute('data-state', 'checked')
    // sem aviso de segredos, área, captura nem JSON
    await expect(dialog.getByRole('textbox')).toHaveCount(0)
    await expect(dialog.getByRole('combobox')).toHaveCount(1)
    await expect(dialog).not.toContainText('chrome.storage')
    await expect(dialog).not.toContainText('Capturar')
    await page.screenshot({
      path: test.info().outputPath('extension-config-dialog.png'),
      animations: 'disabled',
    })
    await page.getByTestId('config-mode').click()
    await page.getByRole('option', { name: 'Só na primeira abertura de cada perfil' }).click()
    await page.getByTestId('config-default').click()
    await page.getByTestId('config-save').click()
    await expect(dialog).toBeHidden()
    await expect(folderRow.getByTestId('extension-config-summary')).toHaveText('1ª abertura')
    await expect(folderRow.getByTestId('extension-default')).toHaveAttribute('data-state', 'unchecked')
    // e de volta pelo diálogo
    await folderRow.getByTestId('extension-configure').click()
    await expect(page.getByTestId('config-mode')).toHaveText('Só na primeira abertura de cada perfil')
    await expect(page.getByTestId('config-default')).toHaveAttribute('data-state', 'unchecked')
    await page.getByTestId('config-default').click()
    await page.getByTestId('config-save').click()
    await expect(dialog).toBeHidden()
    await expect(folderRow.getByTestId('extension-default')).toHaveAttribute('data-state', 'checked')
    // colunas: sem Permissões; a de configuração mostra quando aplicar
    await expect(page.getByRole('columnheader', { name: 'Permissões' })).toHaveCount(0)
    await expect(page.getByRole('columnheader', { name: 'Quando aplicar' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('extensions-table.png') })
    // Versão longa + MV3 inteira na janela padrão, sem invadir a coluna Origem. Na janela mínima
    // a tabela pode cortar textos (reticências; a versão inteira fica no title), nunca sobrepor.
    await expect(zipRow.getByTestId('extension-version')).toHaveText('2026.1124.1811')
    expect(await extensionTableSpills(page)).toEqual([])
    expect(await partialExtensionTexts(page)).toEqual([])
    const previousSize = await resizeWindow(desktop, { width: 1100, height: 680 })
    expect(await extensionTableSpills(page)).toEqual([])
    await expect(zipRow.getByTestId('extension-version')).toHaveAttribute('title', '2026.1124.1811')
    await page.screenshot({ path: test.info().outputPath('extensions-table-min-window.png') })
    await resizeWindow(desktop, previousSize)

    // perfil novo: as extensões padrão (Facet e a pasta) já vêm marcadas na aba Extensões
    await nav(page, 'profiles').click()
    await page.getByTestId('new-profile').click()
    await page.getByTestId('profile-name-input').fill('Com extensão')
    await page.getByTestId('drawer-tab-extensions').click()
    const choices = page.getByTestId('profile-extension')
    await expect(choices).toHaveCount(3)
    const facetChoice = choices.filter({ hasText: 'Facet' })
    await expect(facetChoice.getByTestId('profile-extension-toggle')).toHaveAttribute('data-state', 'checked')
    await expect(facetChoice.getByTestId('profile-extension-builtin')).toContainText('Bloqueia anúncios')
    await expect(
      choices.filter({ hasText: 'Pasta E2E' }).getByTestId('profile-extension-toggle'),
    ).toHaveAttribute('data-state', 'checked')
    await expect(
      choices.filter({ hasText: 'Zip E2E' }).getByTestId('profile-extension-toggle'),
    ).toHaveAttribute('data-state', 'unchecked')
    await page.getByTestId('drawer-submit').click()
    await expect(page.getByTestId('profile-drawer')).toBeHidden()

    // a biblioteca mostra o uso; excluir em uso pede confirmação citando os perfis
    await nav(page, 'extensions').click()
    await expect(folderRow.getByTestId('extension-usage')).toHaveText('1 perfil')
    await expect(facetRow.getByTestId('extension-usage')).toHaveText('1 perfil')
    await folderRow.getByTestId('extension-menu').click()
    await page.getByTestId('extension-menu-delete').click()
    await expect(page.getByRole('alertdialog')).toContainText('1 perfil')
    await page.getByTestId('confirm-action').click()
    await expect(rows).toHaveCount(2)
    const profiles = await page.evaluate(() =>
      (Reflect.get(globalThis, 'api') as FacetBridge).invoke('profiles.list', { scope: 'active' }),
    )
    expect(profiles.ok && profiles.data.map((profile) => profile.extensionIds)).toEqual([
      [FACET_EXTENSION_ID],
    ])
    // a Facet não sai nem pelo IPC: só é desligada
    const removal = await page.evaluate(
      (id) =>
        (Reflect.get(globalThis, 'api') as FacetBridge).invoke('extensions.delete', {
          ids: [id],
          confirmInUse: true,
        }),
      FACET_EXTENSION_ID,
    )
    expect(removal).toMatchObject({
      ok: false,
      error: { code: 'CONFLICT', details: { reason: 'builtinExtension' } },
    })
  })

  test('instala pela Chrome Web Store com o ID detectado no link e alerta a permissão de proxy', async ({
    desktop,
  }) => {
    // O app empacotado ignora a Web Store de teste (iria ao Google de verdade).
    test.skip(Boolean(process.env.FACET_E2E_EXECUTABLE), 'Web Store local só fora do pacote')
    const { page } = desktop
    await nav(page, 'extensions').click()
    await addFrom(page, 'extension-add-webstore')
    await page.getByTestId('webstore-input').fill('isto não é um link da loja')
    await expect(page.getByTestId('webstore-submit')).toBeDisabled()
    await page
      .getByTestId('webstore-input')
      .fill(`https://chromewebstore.google.com/detail/loja-e2e/${storeKey.id}`)
    await expect(page.getByTestId('webstore-dialog')).toContainText(storeKey.id)
    await page.getByTestId('webstore-submit').click()
    await expect(page.getByTestId('webstore-dialog')).toBeHidden()
    const row = page.getByTestId('extension-row').filter({ hasText: 'Loja E2E' })
    await expect(row).toContainText('Chrome Web Store')
    await expect(row).toContainText(storeKey.id)
    // "Chrome Web Store" numa linha só e a versão longa inteira, sem sobrepor colunas
    await expect(row.getByTestId('extension-source')).toHaveText('Chrome Web Store')
    await expect(row.getByTestId('extension-version')).toHaveText('2026.1124.1811')
    expect(await extensionTableSpills(page)).toEqual([])
    expect(await partialExtensionTexts(page)).toEqual([])
    await page.screenshot({ path: test.info().outputPath('extensions-webstore.png') })
    // sem coluna de permissões: o alerta de proxy fica ao lado do nome
    const critical = row.getByTestId('extension-critical-warning')
    await expect(critical).toBeVisible()
    await expect(critical).toHaveAttribute('data-warnings', 'proxy')
    await expect(critical).toHaveAttribute('aria-label', 'Pode trocar o proxy')
    expect(web.requests.some((request) => request.includes(storeKey.id))).toBe(true)
  })
})

test('fingerprint: emulação no drawer, valores aplicados na abertura e reinício pendente', async ({
  desktop,
}) => {
  test.setTimeout(120000)
  const { page } = desktop
  await seed(page)
  const row = page.getByTestId('profile-row').first()
  const comparison = (label: string, column: 'configured' | 'session' | 'observed') =>
    page
      .getByTestId('fingerprint-comparison')
      .getByRole('row')
      .filter({ hasText: label })
      .getByRole('cell')
      .nth(['configured', 'session', 'observed'].indexOf(column))

  // Rascunho: emulação com tela e hardware gerados e fuso manual (gerar não salva sozinho).
  await row.getByTestId('profile-name').click()
  await page.getByTestId('drawer-tab-fingerprint').click()
  const generate = page.getByTestId('fingerprint-generate')
  const mode = page.getByTestId('fingerprint-mode')
  // Perfil novo (criado em massa) já vem em Emulação, mesmo no sistema desta máquina.
  await expect(mode).toHaveText('Emulação')
  await expect(generate).toBeEnabled()
  const resolution = await page.getByTestId('fp-resolution').textContent()
  await generate.click()
  await expect(page.getByTestId('fp-resolution')).not.toHaveText(resolution ?? '')
  // Nativo desliga o gerador; de volta à Emulação, ele volta a valer.
  await mode.click()
  await page.getByRole('option', { name: 'Nativo', exact: true }).click()
  await expect(generate).toBeDisabled()
  await mode.click()
  await page.getByRole('option', { name: 'Emulação', exact: true }).click()
  await expect(generate).toBeEnabled()
  await page.getByTestId('fp-timezone-mode').click()
  await page.getByRole('option', { name: 'Manual', exact: true }).click()
  await page.getByTestId('fp-timezone').fill('Asia/Tokyo')
  await page.getByTestId('drawer-submit').click()
  await expect(page.getByTestId('profile-drawer')).toBeHidden()

  // Abertura real: a sessão registra a configuração e a página observada usa o fuso emulado.
  await row.getByTestId('profile-open').click()
  await expect(row).toHaveAttribute('data-status', 'running', { timeout: 30000 })
  await row.getByTestId('profile-name').click()
  await page.getByTestId('drawer-tab-fingerprint').click()
  await expect(comparison('Fuso horário', 'session')).toHaveText('Asia/Tokyo')
  await expect(comparison('Fuso horário', 'observed')).toHaveText('Asia/Tokyo')

  // Editar com o perfil aberto: pede reinício e a sessão continua com o fuso da abertura.
  await page.getByTestId('fp-timezone').fill('Europe/Lisbon')
  await page.getByTestId('drawer-submit').click()
  await expect(page.getByTestId('restart-prompt')).toContainText('O fingerprint salvo mudou')
  await page.getByRole('button', { name: 'Depois', exact: true }).click()
  // o aviso bloqueia cliques até terminar de fechar
  await expect(page.getByTestId('restart-prompt')).toBeHidden()
  await row.getByTestId('profile-name').click()
  await page.getByTestId('drawer-tab-fingerprint').click()
  await expect(page.getByTestId('fingerprint-tab')).toContainText('Há alterações salvas pendentes')
  await expect(comparison('Fuso horário', 'configured')).toHaveText('Europe/Lisbon')
  await expect(comparison('Fuso horário', 'session')).toHaveText('Asia/Tokyo')
  await expect(comparison('Fuso horário', 'observed')).toHaveText('Asia/Tokyo')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('profile-drawer')).toBeHidden()

  await row.getByTestId('profile-stop').click()
  await expect(row).toHaveAttribute('data-status', 'stopped', { timeout: 30000 })
})
