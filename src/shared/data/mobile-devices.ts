import type { MobileOs } from '../schemas/common'

/**
 * Aparelho emulado num perfil Android ou iOS. Os valores são os que o navegador do aparelho
 * mostra aos sites (px CSS, não pixels físicos), com a escala de tela padrão de fábrica.
 */
export interface MobileDevice {
  id: string
  os: MobileOs
  /** Nome exibido na interface. */
  name: string
  /** Modelo informado nas Client Hints (`Sec-CH-UA-Model`); vazio no iOS, que não as envia. */
  model: string
  /** Android: `Sec-CH-UA-Platform-Version` ("15.0.0"). iOS: versão no User-Agent do Safari ("18.6"). */
  osVersion: string
  /** Tela (screen.width × screen.height) e devicePixelRatio. No celular a área útil é a tela toda. */
  screen: { width: number; height: number; pixelRatio: number }
  /** Altura da página com a barra do navegador visível (window.innerHeight). */
  viewportHeight: number
  /** navigator.hardwareConcurrency */
  cores: number
  /** navigator.deviceMemory (o Chrome do Android arredonda e limita a 8); null no iOS, que não tem. */
  memory: number | null
  /** WEBGL_debug_renderer_info: UNMASKED_VENDOR_WEBGL e UNMASKED_RENDERER_WEBGL. */
  gpu: { vendor: string; renderer: string }
}

const QUALCOMM = 'Qualcomm'
const ARM = 'ARM'
/** O Safari não revela o modelo da GPU: todo iPhone informa "Apple GPU". */
const APPLE_GPU = { vendor: 'Apple Inc.', renderer: 'Apple GPU' }

function android(
  id: string,
  name: string,
  model: string,
  osVersion: string,
  [width, height, pixelRatio]: [number, number, number],
  cores: number,
  memory: number,
  gpu: { vendor: string; renderer: string },
): MobileDevice {
  // Chrome: barra de status + barra de endereço visíveis; a navegação por gestos fica sobre a página.
  return {
    id,
    os: 'android',
    name,
    model,
    osVersion,
    screen: { width, height, pixelRatio },
    viewportHeight: height - 76,
    cores,
    memory,
    gpu,
  }
}

function iphone(
  id: string,
  name: string,
  osVersion: string,
  [width, height, pixelRatio]: [number, number, number],
  /** Barra de status + barra de endereço/abas do Safari (embaixo, desde o iOS 15). */
  chrome: number,
): MobileDevice {
  // O WebKit limita navigator.hardwareConcurrency a 4 no iPhone e não tem navigator.deviceMemory.
  return {
    id,
    os: 'ios',
    name,
    model: '',
    osVersion,
    screen: { width, height, pixelRatio },
    viewportHeight: height - chrome,
    cores: 4,
    memory: null,
    gpu: APPLE_GPU,
  }
}

/** Aparelhos populares; cada perfil novo recebe um que nenhum outro perfil usa nem usou. */
export const MOBILE_DEVICES: Record<MobileOs, readonly MobileDevice[]> = {
  android: [
    android('galaxy-s25', 'Samsung Galaxy S25', 'SM-S931B', '15.0.0', [384, 832, 2.8125], 8, 8, {
      vendor: QUALCOMM,
      renderer: 'Adreno (TM) 830',
    }),
    android('galaxy-s24', 'Samsung Galaxy S24', 'SM-S921U', '15.0.0', [384, 832, 2.8125], 8, 8, {
      vendor: QUALCOMM,
      renderer: 'Adreno (TM) 750',
    }),
    android('galaxy-s23', 'Samsung Galaxy S23', 'SM-S911B', '14.0.0', [360, 780, 3], 8, 8, {
      vendor: QUALCOMM,
      renderer: 'Adreno (TM) 740',
    }),
    android('galaxy-a54', 'Samsung Galaxy A54 5G', 'SM-A546B', '14.0.0', [384, 854, 2.8125], 8, 4, {
      vendor: ARM,
      renderer: 'Mali-G68',
    }),
    android('pixel-9', 'Google Pixel 9', 'Pixel 9', '15.0.0', [412, 923, 2.625], 8, 8, {
      vendor: ARM,
      renderer: 'Mali-G715',
    }),
    android('pixel-8', 'Google Pixel 8', 'Pixel 8', '15.0.0', [412, 915, 2.625], 9, 8, {
      vendor: ARM,
      renderer: 'Mali-G715',
    }),
    android('pixel-7', 'Google Pixel 7', 'Pixel 7', '14.0.0', [412, 915, 2.625], 8, 8, {
      vendor: ARM,
      renderer: 'Mali-G710',
    }),
    android(
      'redmi-note-13-pro',
      'Xiaomi Redmi Note 13 Pro 5G',
      '23117RA68G',
      '14.0.0',
      [393, 873, 2.75],
      8,
      8,
      { vendor: QUALCOMM, renderer: 'Adreno (TM) 710' },
    ),
    android('moto-g84', 'Motorola moto g84 5G', 'moto g84 5G', '14.0.0', [360, 800, 3], 8, 8, {
      vendor: QUALCOMM,
      renderer: 'Adreno (TM) 619',
    }),
  ],
  ios: [
    iphone('iphone-16-pro-max', 'iPhone 16 Pro Max', '18.6', [440, 956, 3], 193),
    iphone('iphone-16-pro', 'iPhone 16 Pro', '18.6', [402, 874, 3], 193),
    iphone('iphone-16', 'iPhone 16', '18.5', [393, 852, 3], 193),
    iphone('iphone-15-pro-max', 'iPhone 15 Pro Max', '18.6', [430, 932, 3], 193),
    iphone('iphone-15', 'iPhone 15', '18.5', [393, 852, 3], 193),
    iphone('iphone-14', 'iPhone 14', '18.5', [390, 844, 3], 180),
    iphone('iphone-13', 'iPhone 13', '18.4', [390, 844, 3], 180),
    iphone('iphone-se-3', 'iPhone SE (3ª geração)', '18.5', [375, 667, 2], 120),
  ],
}

export function mobileDevice(id: string | null | undefined, os: MobileOs): MobileDevice | null {
  return MOBILE_DEVICES[os].find((device) => device.id === id) ?? null
}
