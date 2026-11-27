import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserInfo, BrowserSource } from '@shared/schemas/browser'
import type { Profile } from '@shared/schemas/profile'
import { AppError } from '@shared/ipc/result'
import type { BrowserEngine, LaunchedBrowser, LaunchEnvironment, OfflineBrowser } from './engine'
import { CdpClient } from './cdp/client'
import {
  assertDirectoryIdle,
  findProcesses,
  inspectProcess,
  terminateOwnedProcess,
  waitForExit,
} from './process'
import { ProfileFiles } from './profile-files'
import { firstExisting } from './detect'
import type { BrowserFlavor } from './flavors'
import { clearNativeSession, preparePreferences } from './preferences'
import { capabilitiesFor, fallbackBrands, readUaBrands } from './fingerprint/capabilities'
import { geoPermission } from './fingerprint/apply'
import { DEFAULT_WINDOW } from './window-size'
import type { Logger } from '../logger'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface ChromiumEngineOptions {
  flavor: BrowserFlavor
  /** Raiz atual das pastas de perfil (muda com a mudança da pasta dos perfis). */
  profilesDir: () => string
  /** Pasta das sondagens deste navegador (uma por navegador: as limpezas não se cruzam). */
  probeDir: string
  /** Executável escolhido nas Configurações; vazio = o que o Facet encontra sozinho. */
  getPath: () => string
  logger: Logger
  timeoutMs?: number
}

/** Um navegador Chromium (Ungoogled Chromium, Chrome, Brave ou Opera) e as aberturas dele. */
export class ChromiumEngine implements BrowserEngine {
  private current: BrowserInfo
  private cache = new Map<string, { stamp: string; info: BrowserInfo }>()
  private validation: Promise<BrowserInfo> | null = null
  /** Procuras e sondagens em andamento; `checked` = a primeira já terminou. */
  private checks = 0
  private checked = false
  constructor(private readonly options: ChromiumEngineOptions) {
    this.current = {
      kind: options.flavor.kind,
      name: options.flavor.name,
      available: false,
      executablePath: null,
      source: null,
      product: null,
      userAgent: null,
      profilesDir: options.profilesDir(),
      error: null,
      checking: true,
    }
  }
  get flavor(): BrowserFlavor {
    return this.options.flavor
  }
  info(): BrowserInfo {
    return {
      ...this.current,
      profilesDir: this.options.profilesDir(),
      checking: this.checks > 0 || !this.checked,
    }
  }
  /**
   * Marca a procura em andamento: até ela terminar a interface mostra "Verificando…". Devolve o
   * estado depois de terminar (o de dentro ainda diria "verificando").
   */
  private async checking(task: () => Promise<unknown>): Promise<BrowserInfo> {
    this.checks++
    try {
      await task()
    } finally {
      this.checks--
      this.checked = true
    }
    return this.info()
  }
  detect(): Promise<BrowserInfo> {
    return this.checking(() => this.find())
  }
  private async find(): Promise<BrowserInfo> {
    const custom = this.options.getPath()
    if (custom) return this.validate(custom, 'custom')
    const found = await firstExisting(await this.flavor.candidates())
    if (!found)
      return this.unavailable(
        null,
        null,
        this.flavor.kind === 'ungoogled'
          ? 'O Ungoogled Chromium que vem com o Facet não foi encontrado. Reinstale o Facet ou escolha o executável nas Configurações.'
          : `${this.flavor.name} não está instalado nesta máquina. Instale-o ou escolha o executável nas Configurações.`,
      )
    return this.validate(found, this.flavor.kind === 'ungoogled' ? 'bundled' : 'detected')
  }
  private unavailable(
    executablePath: string | null,
    source: BrowserSource | null,
    error: string,
  ): BrowserInfo {
    this.options.logger.warn(`${this.flavor.name} indisponível`, executablePath, error)
    this.current = {
      ...this.current,
      executablePath,
      source,
      available: false,
      product: null,
      userAgent: null,
      error,
      fingerprintCapabilities: undefined,
    }
    return this.info()
  }
  validate(candidate: string, source: BrowserSource = 'custom'): Promise<BrowserInfo> {
    return this.checking(async () => {
      // Sondagens são serializadas para não criar processos auxiliares concorrentes.
      const task = (this.validation ?? Promise.resolve()).then(() => this.probe(candidate, source))
      this.validation = task
      try {
        return await task
      } finally {
        if (this.validation === task) this.validation = null
      }
    })
  }
  private async probe(candidate: string, source: BrowserSource): Promise<BrowserInfo> {
    let executable: string
    try {
      executable = await this.flavor.resolve(await fs.realpath(candidate))
      const stat = await fs.stat(executable)
      if (!stat.isFile()) throw new Error('Selecione um arquivo executável')
      const stamp = `${stat.size}:${stat.mtimeMs}`
      const cached = this.cache.get(executable)
      if (cached?.stamp === stamp) {
        this.current = { ...cached.info, source }
        return this.info()
      }
      const files = new ProfileFiles(this.options.probeDir)
      try {
        files.recover(() => false)
      } catch (error) {
        this.options.logger.warn('Limpeza de sondagem será retomada', error)
      }
      // Recupera apenas sondagens antigas deste app, identificadas pela pasta.
      for (const id of await fs.readdir(files.root)) {
        if (!/^[0-9a-f-]{36}$/.test(id)) continue
        const directory = files.directory(id)
        for (const owner of await findProcesses(directory)) await terminateOwnedProcess(owner, directory)
        await assertDirectoryIdle(directory)
        try {
          files.stageDeletion(id)
          files.finishDeletion(id)
        } catch (error) {
          this.options.logger.warn('Pasta de sondagem ainda bloqueada', error)
        }
      }
      const id = randomUUID()
      const directory = files.prepare(id)
      let child: ChildProcess | undefined
      let client: CdpClient | undefined
      let stopError: AppError | null = null
      try {
        preparePreferences(directory, ['en-US', 'en'], this.options.logger, { browser: this.flavor.kind })
        child = this.spawn(executable, directory, ['--headless=new'], 'probe')
        const connected = await this.connect(directory)
        client = connected.client
        const base = capabilitiesFor(connected.version, { browser: this.flavor.kind })
        const brands = (await readUaBrands(client)) ?? fallbackBrands(this.flavor.kind, base)
        this.current = {
          kind: this.flavor.kind,
          name: this.flavor.name,
          available: true,
          checking: false,
          executablePath: executable,
          source,
          ...connected.version,
          profilesDir: this.options.profilesDir(),
          error: null,
          fingerprintCapabilities: { ...base, ...brands, nativeNoise: this.flavor.nativeNoise },
        }
        this.cache.set(executable, { stamp, info: this.info() })
      } finally {
        await client?.send('Browser.close', undefined).catch(() => undefined)
        client?.close()
        if (child?.pid) {
          const identity = await inspectProcess(child.pid)
          if (identity && !(await waitForExit(identity, directory, 3000))) {
            await terminateOwnedProcess(identity, directory)
            if (!(await waitForExit(identity, directory, 5000)))
              stopError = new AppError('BROWSER_STOP_FAILED', 'A sondagem do navegador não encerrou')
          }
        }
        // Com o processo ainda vivo a pasta continua em uso: a limpeza fica para a próxima sondagem.
        if (!stopError) {
          await assertDirectoryIdle(directory)
          try {
            files.stageDeletion(id)
            files.finishDeletion(id)
          } catch (error) {
            this.options.logger.warn('Limpeza de sondagem será retomada', error)
          }
        }
      }
      if (stopError) throw stopError
      return this.info()
    } catch (error) {
      return this.unavailable(candidate, source, error instanceof Error ? error.message : String(error))
    }
  }
  /**
   * `probe`: sondagem headless, oculta e presa ao app (morre junto com ele).
   * `profile`: janela visível e processo desacoplado. No Windows, filhos iniciados sem
   * `detached` entram no job object do libuv e são encerrados quando o Facet cai; o
   * perfil precisa sobreviver para ser recuperado. E `windowsHide` faria o primeiro
   * ShowWindow do navegador obedecer ao SW_HIDE do STARTUPINFO: a janela abriria invisível.
   * `pipe`: canal de depuração nos descritores 3 e 4 (Chrome: carga das extensões). O Chrome
   * fecha quando o canal fecha (verificado no Chrome 158), ou seja, também se o Facet cair.
   */
  private spawn(
    executable: string,
    directory: string,
    extra: string[],
    mode: 'probe' | 'profile',
    pipe = false,
  ): ChildProcess {
    const child = spawn(
      executable,
      [
        `--user-data-dir=${directory}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode',
        '--hide-crash-restore-bubble',
        ...extra,
        'about:blank',
      ],
      mode === 'probe'
        ? { shell: false, windowsHide: true, stdio: 'ignore' }
        : {
            shell: false,
            windowsHide: false,
            detached: true,
            stdio: pipe ? ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] : 'ignore',
          },
    )
    child.on('error', (error) => this.options.logger.error(`Falha ao iniciar ${this.flavor.name}`, error))
    if (pipe) {
      // O navegador só escreve no canal o que responder por ele; ler sempre evita que ele trave.
      for (const stream of [child.stdio[3], child.stdio[4]]) stream?.on('error', () => undefined)
      child.stdio[4]?.on('data', () => undefined)
    }
    return child
  }
  async launch(
    profile: Profile,
    directory: string,
    signal: AbortSignal,
    onSpawn: (child: ChildProcess) => Promise<void>,
    environment: LaunchEnvironment,
  ): Promise<LaunchedBrowser> {
    const info = await this.detect()
    signal.throwIfAborted()
    if (!info.available || !info.executablePath)
      throw new AppError('BROWSER_NOT_FOUND', info.error ?? `${this.flavor.name} não encontrado`)
    await assertDirectoryIdle(directory)
    const fingerprint = environment.fingerprint ?? profile.fingerprint
    // "Restringir ao proxy" só tem o que proteger com proxy: sem ele o IP visto pelos sites já é
    // o desta máquina e a restrição apenas quebraria o WebRTC. "Bloquear" restringe sempre.
    const restrictUdp =
      fingerprint.webrtc.mode === 'disabled' ||
      (fingerprint.webrtc.mode === 'proxy_only' && environment.proxyPort !== null)
    const noise = fingerprint.noise.canvas === 'brave'
    preparePreferences(directory, fingerprint.languages.list, this.options.logger, {
      browser: this.flavor.kind,
      webrtcPolicy: restrictUdp ? 'disable_non_proxied_udp' : 'default',
      farbling: noise,
      blockGeolocation: geoPermission(fingerprint) === 'denied',
      identityExtensionId: environment.identityExtensionId ?? null,
      facetExtension: environment.facetExtension ?? false,
      // o Chrome do Android baixa os PDFs: sem visualizador e sem navigator.plugins
      pdfViewer: fingerprint.mode !== 'emulated' || fingerprint.os !== 'android',
    })
    clearNativeSession(directory)
    await fs.unlink(path.join(directory, 'DevToolsActivePort')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    const size = environment.window ?? profile.launchOptions.window ?? DEFAULT_WINDOW
    const pipe = this.flavor.extensionLoading === 'pipe' && environment.extensionDirs.length > 0
    // Abre só uma aba em branco (o about:blank final de spawn): a sessão nativa foi apagada
    // acima, e as páginas iniciais/abas restauradas são abertas pelo Facet depois de conectar.
    // Não usar --no-startup-window: com ele o navegador continua vivo quando o usuário fecha a
    // última janela, e o status nunca voltaria para "parado".
    const child = this.spawn(
      info.executablePath,
      directory,
      [
        // Com depuração remota o Chromium marca navigator.webdriver = true (verificado no Brave
        // 158); esta flag devolve o valor de um navegador comum, sem barra de aviso. Reservada.
        '--disable-blink-features=AutomationControlled',
        `--lang=${fingerprint.languages.list[0] ?? 'en-US'}`,
        `--window-size=${size.width},${size.height}`,
        // Todo o tráfego (inclusive 127.0.0.1) vai pelo proxy local: sem saída direta e sem
        // páginas varrendo portas desta máquina. Credenciais nunca aparecem aqui.
        ...(environment.proxyPort !== null
          ? [`--proxy-server=http://127.0.0.1:${environment.proxyPort}`, '--proxy-bypass-list=<-loopback>']
          : []),
        // Extensões da biblioteca (verificado no Brave, Opera e Ungoogled Chromium: a flag
        // funciona, mas precisa ir em toda abertura; o navegador as trata como recém-instaladas
        // a cada vez). O Chrome ignora a flag: recebe as extensões pelo canal de depuração.
        ...(pipe
          ? ['--remote-debugging-pipe', '--enable-unsafe-extension-debugging']
          : environment.extensionDirs.length > 0
            ? [`--load-extension=${environment.extensionDirs.join(',')}`]
            : []),
        ...this.flavor.args({ noise }),
        ...profile.launchOptions.extraArgs,
      ],
      'profile',
      pipe,
    )
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    await onSpawn(child)
    signal.throwIfAborted()
    const connection = await this.connect(directory, signal)
    if (pipe) await this.loadExtensions(connection.client, environment.extensionDirs)
    return { child, ...connection }
  }
  /**
   * Chrome: carrega as extensões descompactadas pelo CDP. O comando é liberado pela abertura com
   * o canal de depuração e responde também pela conexão WebSocket (verificado no Chrome 158). Uma
   * falha só vai para o log: a conferência das extensões carregadas aponta o que faltou.
   */
  private async loadExtensions(client: CdpClient, directories: readonly string[]): Promise<void> {
    for (const directory of directories) {
      try {
        await client.send('Extensions.loadUnpacked', { path: directory }, undefined, 15000)
      } catch (error) {
        this.options.logger.warn(`${this.flavor.name} recusou a extensão ${path.basename(directory)}`, error)
      }
    }
  }
  async openOffline(directory: string, signal?: AbortSignal): Promise<OfflineBrowser> {
    const info = await this.detect()
    signal?.throwIfAborted()
    if (!info.available || !info.executablePath)
      throw new AppError('BROWSER_NOT_FOUND', info.error ?? `${this.flavor.name} não encontrado`)
    await assertDirectoryIdle(directory)
    clearNativeSession(directory)
    await fs.unlink(path.join(directory, 'DevToolsActivePort')).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    // Sem rede: todo pedido, inclusive para 127.0.0.1, vai a um proxy que não existe. Assim
    // os serviços do navegador não saem pelo IP real de um perfil que usa proxy.
    const child = this.spawn(
      info.executablePath,
      directory,
      ['--headless=new', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'],
      'probe',
    )
    let client: CdpClient
    try {
      client = (await this.connect(directory, signal)).client
    } catch (error) {
      await this.closeProcess(child, undefined, directory).catch((closeError: unknown) =>
        this.options.logger.warn('Falha ao encerrar o navegador temporário', closeError),
      )
      throw error
    }
    let closed: Promise<void> | null = null
    return {
      client,
      close: () => (closed ??= this.closeProcess(child, client, directory)),
    }
  }
  /** Browser.close e, se ele não sair, encerra só o processo conferido como desta pasta. */
  private async closeProcess(
    child: ChildProcess,
    client: CdpClient | undefined,
    directory: string,
  ): Promise<void> {
    await client?.send('Browser.close', undefined, undefined, 2000).catch(() => undefined)
    client?.close()
    if (child.pid) {
      const identity = await inspectProcess(child.pid)
      if (identity && !(await waitForExit(identity, directory, 5000))) {
        await terminateOwnedProcess(identity, directory)
        if (!(await waitForExit(identity, directory, 5000)))
          throw new AppError('BROWSER_STOP_FAILED', 'O navegador temporário não encerrou')
      }
    }
    await assertDirectoryIdle(directory)
  }
  async connect(directory: string, signal?: AbortSignal) {
    const deadline = Date.now() + (this.options.timeoutMs ?? 20000)
    let lastError: unknown
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      let client: CdpClient | undefined
      try {
        const [rawPort, browserPath] = (await fs.readFile(path.join(directory, 'DevToolsActivePort'), 'utf8'))
          .trim()
          .split(/\r?\n/)
        const port = Number(rawPort)
        if (
          !Number.isInteger(port) ||
          port < 1 ||
          port > 65535 ||
          !/^\/devtools\/browser\/[\w-]+$/.test(browserPath ?? '')
        )
          throw new Error('Porta CDP ainda não disponível')
        const endpoint = `ws://127.0.0.1:${port}${browserPath}`
        client = await CdpClient.connect(endpoint, 1500, signal)
        const version = await client.send('Browser.getVersion', undefined)
        return { client, port, endpoint, version: { product: version.product, userAgent: version.userAgent } }
      } catch (error) {
        client?.close()
        lastError = error
        await sleep(120)
      }
    }
    throw new AppError(
      'BROWSER_START_FAILED',
      `${this.flavor.name} não respondeu ao CDP: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    )
  }
}
