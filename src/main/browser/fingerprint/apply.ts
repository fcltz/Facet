import type { Protocol } from 'devtools-protocol'
import { AppError } from '@shared/ipc/result'
import { fingerprintDevice, type FingerprintConfig } from '@shared/schemas/fingerprint'
import type { CdpClient } from '../cdp/client'
import { documentScript, workerScript } from './scripts'

export function geoPermission(config: FingerprintConfig): Protocol.Browser.PermissionSetting {
  if (config.geolocation.mode === 'prompt') return 'prompt'
  const { mode, latitude, longitude } = config.geolocation
  return mode === 'block' || latitude === null || longitude === null ? 'denied' : 'granted'
}

export interface ApplyOptions {
  /**
   * Celular: escala da imagem da página quando a janela é menor que a tela do aparelho (só
   * visual; os valores vistos pelos sites não mudam).
   */
  viewScale?: number
}

/** Client Hints enviadas: o iPhone (Safari) não tem; os demais informam o tipo de aparelho. */
function userAgentMetadata(config: FingerprintConfig): Protocol.Emulation.UserAgentMetadata | undefined {
  if (config.os === 'ios') return undefined
  return { ...config.uaData, formFactors: [config.uaData.mobile ? 'Mobile' : 'Desktop'] }
}

/**
 * Prazo de cada comando de preparação. Com a máquina ocupada (vários perfis abrindo ao mesmo
 * tempo) o navegador demora a responder, e um alvo vivo sem resposta em 5 s (o padrão do
 * CdpClient) fechava o perfil por segurança. Alvos que somem falham na hora ("Session with given
 * id not found"), sem esperar o prazo.
 */
export const PREPARE_TIMEOUT_MS = 15000

/** Cada chamada tem timeout no CdpClient. Workers não suportam todos os domínios de página. */
export async function applyFingerprint(
  client: CdpClient,
  sessionId: string,
  target: Protocol.Target.TargetInfo,
  config: FingerprintConfig,
  warn: (code: string) => void,
  options: ApplyOptions = {},
): Promise<void> {
  if (target.url.startsWith('chrome-extension:')) return
  const page = target.type === 'page' || target.type === 'iframe'
  const worker = ['worker', 'shared_worker', 'service_worker'].includes(target.type)
  if (!page && !worker) return
  const commands: Promise<unknown>[] = []
  // Service workers pausados só respondem depois de runIfWaitingForDebugger. Enfileira
  // primeiro os comandos e libera em seguida, antes de aguardar as respostas.
  const add = (command: Promise<unknown>): void => {
    commands.push(command)
  }
  add(
    client.send(
      'Emulation.setTimezoneOverride',
      { timezoneId: config.timezone.id },
      sessionId,
      PREPARE_TIMEOUT_MS,
    ),
  )
  if (page) {
    add(
      client
        .send(
          'Emulation.setLocaleOverride',
          { locale: config.languages.list[0] },
          sessionId,
          PREPARE_TIMEOUT_MS,
        )
        .catch((error) => {
          if (!(error instanceof Error && /locale override is already in effect/i.test(error.message)))
            throw error
        }),
    )
    if (geoPermission(config) === 'granted') {
      add(
        client.send(
          'Emulation.setGeolocationOverride',
          {
            latitude: config.geolocation.latitude!,
            longitude: config.geolocation.longitude!,
            accuracy: config.geolocation.accuracy,
          },
          sessionId,
          PREPARE_TIMEOUT_MS,
        ),
      )
    } else {
      // Mesmo permissões de origem já salvas não podem revelar a localização real.
      add(client.send('Emulation.setGeolocationOverride', {}, sessionId, PREPARE_TIMEOUT_MS))
    }
  }
  if (config.mode === 'emulated') {
    const device = fingerprintDevice(config)
    const metadata = userAgentMetadata(config)
    add(
      client.send(
        'Network.setUserAgentOverride',
        {
          userAgent: config.userAgent,
          acceptLanguage: config.languages.list.join(','),
          platform: config.navigator.platform,
          // Sem metadados (iPhone) o Chromium não envia Sec-CH-UA, como o Safari.
          ...(metadata ? { userAgentMetadata: metadata } : {}),
        },
        sessionId,
        PREPARE_TIMEOUT_MS,
      ),
    )
    add(
      client.send(
        'Emulation.setHardwareConcurrencyOverride',
        {
          hardwareConcurrency: config.navigator.hardwareConcurrency,
        },
        sessionId,
        PREPARE_TIMEOUT_MS,
      ),
    )
    if (target.type === 'page')
      add(
        client.send(
          'Emulation.setDeviceMetricsOverride',
          device
            ? {
                // Celular (verificado no Ungoogled Chromium 158): tela, página, densidade,
                // orientação, barras de rolagem sobrepostas, meta viewport, window.orientation e
                // (pointer: coarse) passam a ser os do aparelho.
                width: device.screen.width,
                height: device.viewportHeight,
                deviceScaleFactor: device.screen.pixelRatio,
                mobile: true,
                screenWidth: device.screen.width,
                screenHeight: device.screen.height,
                screenOrientation: { type: 'portraitPrimary', angle: 0 },
                ...(options.viewScale && options.viewScale < 1 ? { scale: options.viewScale } : {}),
              }
            : {
                width: 0,
                height: 0,
                deviceScaleFactor: config.screen.pixelRatio,
                mobile: false,
                screenWidth: config.screen.width,
                screenHeight: config.screen.height,
              },
          sessionId,
          PREPARE_TIMEOUT_MS,
        ),
      )
    if (device && page) {
      // Toque: navigator.maxTouchPoints, ontouchstart e (hover: none). Num iframe de outro site o
      // comando pode não existir; a página continua com o toque dela.
      const touch = client.send(
        'Emulation.setTouchEmulationEnabled',
        { enabled: true, maxTouchPoints: 5 },
        sessionId,
        PREPARE_TIMEOUT_MS,
      )
      add(target.type === 'page' ? touch : touch.catch(() => warn('iframeTouch')))
      // O mouse vira dedo: clique é toque, arrastar rola a página.
      if (target.type === 'page')
        add(
          client.send(
            'Emulation.setEmitTouchEventsForMouse',
            { enabled: true, configuration: 'mobile' },
            sessionId,
            PREPARE_TIMEOUT_MS,
          ),
        )
    }
    // Workers pausados: complementos antes do primeiro código do site (falha vira aviso).
    if (worker && device)
      add(
        client.send(
          'Runtime.evaluate',
          { expression: workerScript(config), silent: true },
          sessionId,
          PREPARE_TIMEOUT_MS,
        ),
      )
  }
  // Instala antes de liberar o documento. A avaliação imediata prepara about:blank e
  // reaplica a mesma configuração na recuperação de uma sessão sobrevivente. Sem
  // Page.enable o Chromium não executa o script nos documentos seguintes (verificado no
  // Brave 158: só o runImmediately rodava); a fila por sessão garante a ordem.
  if (page) {
    add(client.send('Page.enable', undefined, sessionId, PREPARE_TIMEOUT_MS))
    add(
      client.send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source: documentScript(config),
          runImmediately: true,
        },
        sessionId,
        PREPARE_TIMEOUT_MS,
      ),
    )
  }
  const settled = Promise.allSettled(commands)
  if (target.type === 'service_worker')
    await client.send('Runtime.runIfWaitingForDebugger', undefined, sessionId, PREPARE_TIMEOUT_MS)
  const results = await settled
  const rejected = results.find((result) => result.status === 'rejected')
  if (rejected?.status === 'rejected') {
    if (worker) {
      warn('workerCoverage')
      return
    }
    throw new AppError(
      'FINGERPRINT_FAILED',
      `Falha ao preparar ${target.type}: ${rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason)}`,
    )
  }
}
