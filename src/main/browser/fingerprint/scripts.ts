import { fingerprintDevice, type FingerprintConfig } from '@shared/schemas/fingerprint'

/** O que os complementos de celular precisam saber (sem mandar o fingerprint inteiro aos workers). */
function mobileFacts(config: FingerprintConfig) {
  const device = config.mode === 'emulated' ? fingerprintDevice(config) : null
  return device ? { ios: config.os === 'ios', gpu: device.gpu, memory: device.memory } : null
}

/**
 * Complementos de celular comuns a documentos e workers: a GPU do aparelho no WebGL, sem WebGPU
 * (revelaria a placa do computador) e, no iPhone, sem o que o Safari não tem
 * (`userAgentData`, `deviceMemory`, `connection`).
 */
const MOBILE_HELPERS = `
    const remove = (object, key) => { try { delete object[key]; } catch {} };
    const patchWebgl = (scope, gpu) => {
      for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
        const prototype = scope[name] && scope[name].prototype;
        if (!prototype) continue;
        const original = prototype.getParameter;
        Object.defineProperty(prototype, 'getParameter', {
          configurable: true, enumerable: true, writable: true,
          value: function getParameter(parameter) {
            if (parameter === 0x9245) return gpu.vendor;
            if (parameter === 0x9246) return gpu.renderer;
            return original.apply(this, arguments);
          }
        });
      }
    };`

/** Complementos limitados aos documentos. Não alteram o motor nem fingem ser funções nativas. */
export function documentScript(config: FingerprintConfig): string {
  return `(() => {
    const config = ${JSON.stringify(config)};
    const mobile = ${JSON.stringify(mobileFacts(config))};
    const define = (object, key, value) => Object.defineProperty(object, key, {
      configurable: true, enumerable: true, get: () => value
    });${MOBILE_HELPERS}
    if (config.mode === 'emulated') {
      define(Navigator.prototype, 'platform', config.navigator.platform);
      define(Navigator.prototype, 'maxTouchPoints', config.navigator.maxTouchPoints);
      if (config.navigator.deviceMemory !== null)
        define(Navigator.prototype, 'deviceMemory', config.navigator.deviceMemory);
      for (const key of ['width', 'height', 'availWidth', 'availHeight', 'colorDepth'])
        define(Screen.prototype, key, config.screen[key]);
      define(Screen.prototype, 'pixelDepth', config.screen.colorDepth);
    }
    if (mobile) {
      patchWebgl(globalThis, mobile.gpu);
      remove(Navigator.prototype, 'gpu');
      if (mobile.ios) {
        for (const key of ['userAgentData', 'deviceMemory', 'connection']) remove(Navigator.prototype, key);
        define(Navigator.prototype, 'vendor', 'Apple Computer, Inc.');
        remove(globalThis, 'chrome');
      }
    }
    if (config.webrtc.mode === 'disabled') {
      const blocked = class RTCPeerConnection {
        constructor() { throw new DOMException('WebRTC blocked by this profile', 'NotAllowedError'); }
      };
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, writable: true, value: blocked });
      if ('webkitRTCPeerConnection' in globalThis)
        Object.defineProperty(globalThis, 'webkitRTCPeerConnection', { configurable: true, writable: true, value: blocked });
    }
  })()`
}

/**
 * Celular: os mesmos complementos no navigator dos workers, avaliados com o worker ainda pausado
 * (antes do primeiro código do site). Sem celular, nada a fazer.
 */
export function workerScript(config: FingerprintConfig): string {
  const mobile = mobileFacts(config)
  if (!mobile) return 'undefined'
  return `(() => {
    const mobile = ${JSON.stringify(mobile)};
    const define = (object, key, value) => Object.defineProperty(object, key, {
      configurable: true, enumerable: true, get: () => value
    });${MOBILE_HELPERS}
    const navigatorPrototype = globalThis.WorkerNavigator && WorkerNavigator.prototype;
    patchWebgl(globalThis, mobile.gpu);
    if (!navigatorPrototype) return;
    remove(navigatorPrototype, 'gpu');
    if (mobile.memory !== null) define(navigatorPrototype, 'deviceMemory', mobile.memory);
    if (mobile.ios) for (const key of ['userAgentData', 'deviceMemory', 'connection']) remove(navigatorPrototype, key);
  })()`
}

export const OBSERVE_FINGERPRINT = `(() => ({
  userAgent: navigator.userAgent, platform: navigator.platform,
  languages: Array.from(navigator.languages),
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory ?? null,
  maxTouchPoints: navigator.maxTouchPoints,
  screen: typeof screen === 'undefined' ? null : {
    width: screen.width, height: screen.height, availWidth: screen.availWidth,
    availHeight: screen.availHeight, pixelRatio: devicePixelRatio, colorDepth: screen.colorDepth
  }
}))()`
