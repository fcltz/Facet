import { randomInt } from 'node:crypto'
import { MOBILE_DEVICES } from '@shared/data/mobile-devices'
import { isMobileOs, type OsName } from '@shared/schemas/common'
import {
  buildUaBrands,
  createDefaultFingerprint,
  DEVICE_MEMORY_PRESETS,
  deviceScreen,
  fingerprintDevice,
  fingerprintKey,
  fingerprintV2Schema,
  HARDWARE_CONCURRENCY_PRESETS,
  plausibleHardware,
  SCREEN_PRESETS,
  sameScreen,
  type FingerprintCapabilities,
  type FingerprintConfig,
  type FingerprintUsage,
  type ScreenConfig,
} from '@shared/schemas/fingerprint'

/** Marcas das Client Hints do navegador sondado; sem sondagem, as calculadas pela versão. */
function uaBrands(capabilities: FingerprintCapabilities) {
  if (capabilities.brands?.length && capabilities.fullVersionList?.length)
    return { brands: capabilities.brands, fullVersionList: capabilities.fullVersionList }
  return buildUaBrands(
    capabilities.engineMajor,
    /(?:Chrome|Chromium)\/([\d.]+)/.exec(capabilities.product)?.[1],
  )
}

/**
 * UA/CH derivados do motor e do navegador, nunca aceitos como strings independentes do renderer.
 * No celular, o aparelho define tela, núcleos, memória, toque, modelo e versão do sistema.
 */
export function canonicalFingerprint(
  input: FingerprintConfig,
  capabilities: FingerprintCapabilities,
): FingerprintConfig {
  const valid = fingerprintV2Schema.parse(input)
  const native = valid.mode === 'native'
  const os = native ? capabilities.hostOs : valid.os
  const device = native ? null : fingerprintDevice({ os, device: valid.device })
  const base = createDefaultFingerprint({
    os,
    engineMajor: capabilities.engineMajor,
    timezone: valid.timezone.id,
    device: device?.id ?? null,
    browser: { ...uaBrands(capabilities), uaSuffix: capabilities.uaSuffix },
  })
  if (device) {
    return {
      ...valid,
      mode: 'emulated',
      os,
      device: device.id,
      engineMajor: capabilities.engineMajor,
      userAgent: base.userAgent,
      uaData: base.uaData,
      navigator: { ...base.navigator },
      screen: base.screen,
    }
  }
  // Computador: sem aparelho (a chave some, para o JSON igual ao de antes dos celulares).
  const { device: _device, ...desktop } = valid
  return {
    ...desktop,
    os,
    engineMajor: capabilities.engineMajor,
    userAgent: native ? capabilities.nativeUserAgent : base.userAgent,
    uaData: base.uaData,
    navigator: { ...valid.navigator, platform: base.navigator.platform },
  }
}

export function emptyUsage(): FingerprintUsage {
  return { inUse: new Map(), used: new Set() }
}

/** Conta uma combinação recém-atribuída (criação em massa: cada perfil recebe uma diferente). */
export function trackFingerprint(usage: FingerprintUsage, config: FingerprintConfig): void {
  const key = fingerprintKey(config)
  if (!key) return
  usage.used.add(key)
  usage.inUse.set(key, (usage.inUse.get(key) ?? 0) + 1)
}

interface Hardware {
  screen: ScreenConfig
  cores: number
  memory: number | null
  /** Aparelho (Android/iOS); null nos computadores. */
  device: string | null
  key: string
}

/**
 * Todas as combinações realistas de um sistema: tela × núcleos × memória nos computadores; no
 * Android e no iOS, cada aparelho é uma combinação (tela, núcleos e memória vêm dele).
 */
export function hardwareCombinations(os: OsName): Hardware[] {
  if (isMobileOs(os))
    return MOBILE_DEVICES[os].map((device) => {
      const screen = deviceScreen(device)
      const key = fingerprintKey({
        mode: 'emulated',
        os,
        screen,
        device: device.id,
        navigator: { hardwareConcurrency: device.cores, deviceMemory: device.memory, maxTouchPoints: 5 },
      })!
      return { screen, cores: device.cores, memory: device.memory, device: device.id, key }
    })
  const combinations: Hardware[] = []
  for (const screen of SCREEN_PRESETS[os])
    for (const cores of HARDWARE_CONCURRENCY_PRESETS[os])
      for (const memory of DEVICE_MEMORY_PRESETS) {
        if (!plausibleHardware(cores, memory)) continue
        const key = fingerprintKey({
          mode: 'emulated',
          os,
          screen,
          navigator: { hardwareConcurrency: cores, deviceMemory: memory, maxTouchPoints: 0 },
        })!
        combinations.push({ screen, cores, memory, device: null, key })
      }
  return combinations
}

/**
 * Ordem de preferência: combinação nunca usada; senão, uma que nenhum perfil existente usa
 * (só perfis já excluídos usaram); esgotadas todas, a menos usada pelos perfis existentes.
 */
function preferred(candidates: Hardware[], usage: FingerprintUsage): Hardware[] {
  const fresh = candidates.filter((hardware) => !usage.used.has(hardware.key))
  if (fresh.length > 0) return fresh
  const free = candidates.filter((hardware) => !usage.inUse.has(hardware.key))
  if (free.length > 0) return free
  const count = (hardware: Hardware): number => usage.inUse.get(hardware.key) ?? 0
  const least = Math.min(...candidates.map(count))
  return candidates.filter((hardware) => count(hardware) === least)
}

export interface GenerateOptions {
  /** Fingerprint atual (botão Gerar): os demais campos vêm dele e a tela sempre muda. */
  current?: FingerprintConfig
  /** Ponto de partida de um rascunho novo (perfil novo, troca de sistema ou de modo). */
  base?: FingerprintConfig
  /** Combinações já atribuídas: o resultado evita repeti-las. */
  usage?: FingerprintUsage
  choose?: (max: number) => number
}

/**
 * Emulação com tela e hardware sorteados entre combinações realistas, sem repetir as que outro
 * perfil já usa ou usou (`usage`). Fuso, idiomas, geolocalização, WebRTC e ruído vêm do rascunho.
 * No celular o sorteio é do aparelho.
 */
export function generateFingerprint(
  os: OsName,
  capabilities: FingerprintCapabilities,
  options: GenerateOptions = {},
): FingerprintConfig {
  const { current, usage = emptyUsage(), choose = randomInt } = options
  const start = current ?? options.base
  const base = start
    ? structuredClone(start)
    : createDefaultFingerprint({ os, engineMajor: capabilities.engineMajor, timezone: 'UTC' })
  const all = hardwareCombinations(os)
  // O botão Gerar sempre troca a tela (no celular, o aparelho): a mudança fica visível.
  const others = current
    ? all.filter((hardware) =>
        hardware.device ? hardware.device !== current.device : !sameScreen(hardware.screen, current.screen),
      )
    : all
  const pool = preferred(others.length > 0 ? others : all, usage)
  const hardware = pool[choose(pool.length)]!
  const { device: _device, ...rest } = base
  const next: FingerprintConfig = {
    ...rest,
    version: 2,
    mode: 'emulated',
    os,
    screen: { ...hardware.screen },
    navigator: {
      ...base.navigator,
      hardwareConcurrency: hardware.cores,
      deviceMemory: hardware.memory,
      maxTouchPoints: hardware.device ? 5 : 0,
    },
    ...(hardware.device ? { device: hardware.device } : {}),
  }
  return canonicalFingerprint(next, capabilities)
}
