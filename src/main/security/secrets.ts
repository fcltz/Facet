import { AppError } from '@shared/ipc/result'

/**
 * Cifra segredos (senhas de proxy, URLs de troca de IP, token de geo-IP) antes
 * de gravar no banco. Em produção usa o `safeStorage` do Electron (DPAPI no
 * Windows, Keychain no macOS, keyring no Linux). Os valores decifrados só
 * existem no processo principal.
 */
export interface SecretBox {
  readonly available: boolean
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

/** Subconjunto do `safeStorage` usado aqui (permite testar sem o Electron). */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(data: Buffer): string
  getSelectedStorageBackend?: () => string
}

export function createSafeStorageBox(safeStorage: SafeStorageLike, platform = process.platform): SecretBox {
  const available = (): boolean => {
    if (!safeStorage.isEncryptionAvailable()) return false
    // No Linux sem chaveiro o Electron cai para uma chave fixa: na prática, texto puro.
    if (platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false
    return true
  }
  return {
    get available() {
      return available()
    },
    encrypt(plain) {
      if (!available()) {
        throw new AppError(
          'SECRET_UNAVAILABLE',
          'Cofre de senhas do sistema indisponível: a senha não foi salva',
        )
      }
      return safeStorage.encryptString(plain)
    },
    decrypt(data) {
      if (!available()) throw new AppError('SECRET_UNAVAILABLE', 'Cofre de senhas do sistema indisponível')
      return safeStorage.decryptString(data)
    },
  }
}

/**
 * Somente para testes: cifra reversível e previsível, marcada com um prefixo
 * para que um teste perceba se o texto puro foi gravado por engano.
 */
export function createTestSecretBox(): SecretBox {
  const PREFIX = Buffer.from('facet-test:')
  return {
    available: true,
    encrypt(plain) {
      const body = Buffer.from(plain, 'utf8').map((byte) => byte ^ 0x5a)
      return Buffer.concat([PREFIX, body])
    },
    decrypt(data) {
      if (!data.subarray(0, PREFIX.length).equals(PREFIX)) throw new Error('Segredo de teste inválido')
      return Buffer.from(data.subarray(PREFIX.length).map((byte) => byte ^ 0x5a)).toString('utf8')
    },
  }
}
