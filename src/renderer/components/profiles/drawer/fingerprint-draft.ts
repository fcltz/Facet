import { DEFAULT_BROWSER } from '@shared/constants'
import {
  createDefaultFingerprint,
  type FingerprintCapabilities,
  type FingerprintConfig,
} from '@shared/schemas/fingerprint'
import { invoke } from '@renderer/lib/ipc'
import { useSettingsStore } from '@renderer/stores/settings.store'
import type { ProfileForm } from './ProfileDrawer'

/** Último pedido de cada formulário: só a resposta mais recente é aplicada. */
const requests = new WeakMap<ProfileForm, number>()
/** Sorteio em andamento de cada formulário (o envio espera por ele). */
const pending = new WeakMap<ProfileForm, Promise<unknown>>()

export interface DraftFingerprintOptions {
  /**
   * Rascunho novo (perfil novo, troca de sistema ou de modo): nada a evitar. Sem ele, a tela
   * atual sempre muda (botão Gerar).
   */
  fresh: boolean
  /** Perfil novo, ao abrir o formulário: o resultado entra sem marcar o formulário como alterado. */
  initial?: boolean
}

/** Navegador escolhido no formulário (perfil novo sem escolha: o padrão das Configurações). */
export function formBrowser(form: ProfileForm) {
  return form.getValues('browser') ?? useSettingsStore.getState().settings.defaultBrowser ?? DEFAULT_BROWSER
}

/** Capacidades de fingerprint do navegador do formulário (marcas e sufixo do User-Agent). */
export function formCapabilities(form: ProfileForm): FingerprintCapabilities | undefined {
  const kind = formBrowser(form)
  return useSettingsStore.getState().browsers.find((browser) => browser.kind === kind)
    ?.fingerprintCapabilities
}

/**
 * User-Agent e Client Hints do rascunho com as marcas do navegador escolhido, sem sortear de
 * novo a tela e o hardware (troca de navegador). O processo principal recalcula ao gravar.
 */
export function rebrandDraft(
  config: FingerprintConfig,
  capabilities: FingerprintCapabilities | undefined,
): FingerprintConfig {
  if (!capabilities) return config
  const base = createDefaultFingerprint({
    os: config.os,
    engineMajor: capabilities.engineMajor,
    timezone: config.timezone.id,
    device: config.device ?? null,
    browser: capabilities,
  })
  return {
    ...config,
    engineMajor: capabilities.engineMajor,
    userAgent: config.mode === 'native' ? capabilities.nativeUserAgent : base.userAgent,
    uaData: base.uaData,
  }
}

/**
 * Pede ao processo principal um fingerprint de emulação com tela e hardware que nenhum perfil
 * usa nem usou. A resposta é descartada (false) se o fingerprint mudou enquanto ela não chegava:
 * outro pedido, sistema ou modo trocados, ou um campo editado.
 */
export function generateDraftFingerprint(
  form: ProfileForm,
  options: DraftFingerprintOptions,
): Promise<boolean> {
  const task = request(form, options)
  pending.set(
    form,
    task.catch(() => false),
  )
  return task
}

/** Espera o último sorteio pedido: o formulário nunca grava o rascunho anterior a ele. */
export async function draftFingerprintSettled(form: ProfileForm): Promise<void> {
  await pending.get(form)
}

async function request(form: ProfileForm, options: DraftFingerprintOptions): Promise<boolean> {
  const id = (requests.get(form) ?? 0) + 1
  requests.set(form, id)
  const current = form.getValues('fingerprint')
  if (!current) return false
  const before = JSON.stringify(current)
  const generated = await invoke('fingerprint.generate', {
    os: form.getValues('os'),
    browser: formBrowser(form),
    current,
    fresh: options.fresh,
  })
  if (requests.get(form) !== id || JSON.stringify(form.getValues('fingerprint')) !== before) return false
  // setValue, e não resetField: o resetField ignora campos não registrados, e o objeto
  // `fingerprint` inteiro nunca é registrado (só os campos da aba, quando ela está aberta).
  form.setValue(
    'fingerprint',
    generated,
    options.initial ? undefined : { shouldDirty: true, shouldValidate: true },
  )
  return true
}
