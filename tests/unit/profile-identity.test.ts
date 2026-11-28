import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { inflateSync } from 'node:zlib'
import type { ChildProcess } from 'node:child_process'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { preparePreferences } from '@main/browser/preferences'
import { extensionIdFromKeyBase64 } from '@main/extensions/ids'
import {
  IDENTITY_EXTENSION_ID,
  IDENTITY_EXTENSION_KEY,
  identityLabel,
  ProfileIdentityStore,
} from '@main/identity/extension'
import { badgeIco, badgePng, renderBadge } from '@main/identity/icon'
import { WindowIdentity } from '@main/identity/window-identity'
import { silentLogger } from '@main/logger'

fs.mkdirSync(path.resolve('.tmp-tests'), { recursive: true })
const root = fs.mkdtempSync(path.resolve('.tmp-tests', 'identity-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const PROFILE = { id: '00000000-0000-4000-8000-000000000007', serial: 7, name: 'Loja Centro' }

/** Pixel RGBA das linhas geradas por renderBadge (cada linha começa com o byte de filtro). */
function pixel(rows: Buffer, size: number, x: number, y: number): number[] {
  const offset = y * (1 + size * 4) + 1 + x * 4
  return [...rows.subarray(offset, offset + 4)]
}

describe('ícone com o número do perfil', () => {
  it('gera PNG válido do tamanho pedido, com cantos transparentes, fundo roxo e dígitos brancos', () => {
    const png = badgePng(48, '01')
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(png.readUInt32BE(16)).toBe(48)
    expect(png.readUInt32BE(20)).toBe(48)
    const idat = png.indexOf('IDAT')
    const length = png.readUInt32BE(idat - 4)
    const rows = inflateSync(png.subarray(idat + 4, idat + 4 + length))
    expect(rows).toEqual(renderBadge(48, '01'))
    expect(pixel(rows, 48, 0, 0)[3]).toBe(0)
    const colors = new Set<string>()
    for (let y = 8; y < 40; y++)
      for (let x = 8; x < 40; x++) {
        const [r, g, b, a] = pixel(rows, 48, x, y)
        if (a !== 255) continue
        if (r! > 240 && g! > 240 && b! > 240) colors.add('branco')
        if (b! > 200 && r! < 140 && g! < 140) colors.add('roxo')
      }
    expect(colors).toEqual(new Set(['branco', 'roxo']))
  })

  it('número diferente gera imagem diferente; 3 dígitos cabem no mesmo quadrado', () => {
    expect(renderBadge(32, '01').equals(renderBadge(32, '02'))).toBe(false)
    const wide = renderBadge(32, '105')
    expect(pixel(wide, 32, 0, 0)[3]).toBe(0)
    expect(pixel(wide, 32, 2, 16)[0]).toBeLessThan(200) // margem roxa: o texto não encosta na borda
  })

  it('o .ico traz uma imagem PNG por tamanho, de 16 a 256', () => {
    const ico = badgeIco('07')
    expect(ico.readUInt16LE(2)).toBe(1)
    const count = ico.readUInt16LE(4)
    expect(count).toBe(6)
    const sizes: number[] = []
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16
      sizes.push(ico[entry] || 256)
      const offset = ico.readUInt32LE(entry + 12)
      expect([...ico.subarray(offset, offset + 4)]).toEqual([137, 80, 78, 71])
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 256])
  })
})

describe('extensão de identificação', () => {
  it('a chave fixa corresponde ao ID fixo (o ícone continua fixado entre aberturas)', () => {
    expect(extensionIdFromKeyBase64(IDENTITY_EXTENSION_KEY)).toBe(IDENTITY_EXTENSION_ID)
  })

  it('grava manifest, ícones e service worker sem nada que os sites possam perceber', () => {
    const store = new ProfileIdentityStore(root, silentLogger)
    const files = store.prepare(PROFILE, { inBrowser: true })
    expect(files.label).toBe('07 · Loja Centro')
    expect(files.appId).toBe(`Facet.Profile.${PROFILE.id.replace(/-/g, '')}`)
    expect(files.extensionDir).toBe(path.join(root, PROFILE.id, 'extension'))
    const manifest = JSON.parse(
      fs.readFileSync(path.join(files.extensionDir!, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(manifest).toMatchObject({
      manifest_version: 3,
      name: '07 · Loja Centro',
      key: IDENTITY_EXTENSION_KEY,
      permissions: ['tabGroups', 'storage'],
      action: { default_title: '07 · Loja Centro' },
      background: { service_worker: 'sw.js' },
    })
    for (const key of [
      'content_scripts',
      'web_accessible_resources',
      'host_permissions',
      'externally_connectable',
    ])
      expect(manifest).not.toHaveProperty(key)
    for (const size of [16, 32, 48, 128])
      expect(fs.existsSync(path.join(files.extensionDir!, `icon${size}.png`))).toBe(true)
    expect(fs.readFileSync(files.iconPath).readUInt16LE(4)).toBe(6)
    const worker = fs.readFileSync(path.join(files.extensionDir!, 'sw.js'), 'utf8')
    expect(worker).toContain('"07 · Loja Centro"')
    expect(worker).toContain("COLOR = 'purple'")
  })

  it('refaz os ícones só quando o número muda; desligada, não devolve a pasta da extensão', () => {
    const store = new ProfileIdentityStore(root, silentLogger)
    const first = store.prepare(PROFILE, { inBrowser: true })
    const icon = path.join(first.extensionDir!, 'icon32.png')
    const stamp = new Date(2020, 0, 1)
    fs.utimesSync(icon, stamp, stamp)
    store.prepare({ ...PROFILE, name: 'Nome novo' }, { inBrowser: true })
    expect(fs.statSync(icon).mtimeMs).toBe(stamp.getTime())
    expect(fs.readFileSync(path.join(first.extensionDir!, 'manifest.json'), 'utf8')).toContain(
      '07 · Nome novo',
    )
    store.prepare({ ...PROFILE, serial: 8 }, { inBrowser: true })
    expect(fs.statSync(icon).mtimeMs).not.toBe(stamp.getTime())
    expect(store.prepare(PROFILE, { inBrowser: false }).extensionDir).toBeNull()
    store.remove(PROFILE.id)
    expect(fs.existsSync(store.directory(PROFILE.id))).toBe(false)
  })

  it('caminho com vírgula desliga a extensão (o --load-extension separa por vírgula)', () => {
    const warn = vi.fn()
    const store = new ProfileIdentityStore(path.join(root, 'com,virgula'), { ...silentLogger, warn })
    expect(store.prepare(PROFILE, { inBrowser: true }).extensionDir).toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it('encurta rótulos longos e tira quebras de linha', () => {
    const label = identityLabel({ serial: 3, name: `Loja\n${'x'.repeat(100)}` })
    expect(label.startsWith('03 · Loja x')).toBe(true)
    expect(label).toHaveLength(60)
    expect(label.endsWith('…')).toBe(true)
  })
})

describe('preferências com a identificação', () => {
  it('fixa o ícone primeiro, mantém os fixados pelo usuário e esconde os grupos salvos', () => {
    const directory = path.join(root, 'prefs')
    fs.mkdirSync(path.join(directory, 'Default'), { recursive: true })
    const file = path.join(directory, 'Default', 'Preferences')
    fs.writeFileSync(
      file,
      JSON.stringify({
        extensions: { pinned_extensions: ['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', IDENTITY_EXTENSION_ID] },
      }),
    )
    preparePreferences(directory, ['pt-BR'], silentLogger, { identityExtensionId: IDENTITY_EXTENSION_ID })
    const prefs = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      extensions: { pinned_extensions: string[] }
      bookmark_bar: { show_tab_groups: boolean }
    }
    expect(prefs.extensions.pinned_extensions).toEqual([
      IDENTITY_EXTENSION_ID,
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ])
    expect(prefs.bookmark_bar.show_tab_groups).toBe(false)
    // identificação desligada: a lista do usuário não muda
    fs.writeFileSync(
      file,
      JSON.stringify({ extensions: { pinned_extensions: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] } }),
    )
    preparePreferences(directory, ['pt-BR'], silentLogger)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      extensions: { pinned_extensions: ['bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'] },
    })
  })
})

/** Processo falso do utilitário: registra as linhas recebidas e responde pela saída. */
function fakeHelper() {
  const spawned: { lines: string[]; stdout: PassThrough; child: ChildProcess }[] = []
  const spawnHelper = (): ChildProcess => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdin, stdout }) as unknown as ChildProcess
    const record = { lines: [] as string[], stdout, child }
    stdin.on('data', (chunk: Buffer) =>
      record.lines.push(...chunk.toString('utf8').split('\n').filter(Boolean)),
    )
    spawned.push(record)
    return child
  }
  return { spawned, spawnHelper }
}
const TARGET = {
  pid: 4321,
  appId: 'Facet.Profile.x',
  icon: 'C:\\i.ico',
  name: '01 · Loja\tA',
  command: '"F.exe"',
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

describe('utilitário da barra de tarefas (cliente)', () => {
  it('envia track, rename e untrack em linhas com campos limpos e repassa as janelas marcadas', async () => {
    const { spawned, spawnHelper } = fakeHelper()
    const windows = new WindowIdentity({ helperPath: 'helper.exe', logger: silentLogger, spawnHelper })
    const tagged = vi.fn()
    windows.onTagged(tagged)
    windows.track(TARGET)
    windows.rename(TARGET.pid, '01 · Loja nova')
    windows.untrack(TARGET.pid)
    windows.untrack(TARGET.pid)
    await flush()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.lines).toEqual([
      'track\t4321\tFacet.Profile.x\tC:\\i.ico\t01 · Loja A\t"F.exe"',
      'rename\t4321\t01 · Loja nova',
      'untrack\t4321',
    ])
    spawned[0]!.stdout.write('tagged\t4321\t2\n')
    await flush()
    expect(tagged).toHaveBeenCalledWith(4321, 2)
  })

  it('se o utilitário cair, a próxima chamada o reinicia e reenvia os perfis acompanhados', async () => {
    const { spawned, spawnHelper } = fakeHelper()
    const windows = new WindowIdentity({
      helperPath: 'helper.exe',
      logger: silentLogger,
      spawnHelper,
      retryMs: 0,
    })
    windows.track(TARGET)
    spawned[0]!.child.emit('exit', 1)
    windows.track({ ...TARGET, pid: 99, name: 'Outro' })
    await flush()
    expect(spawned).toHaveLength(2)
    expect(spawned[1]!.lines.map((line) => line.split('\t').slice(0, 2).join(' '))).toEqual([
      'track 4321',
      'track 99',
    ])
  })

  it('warm inicia o utilitário antes do navegador; o track seguinte vai para o mesmo processo', async () => {
    const { spawned, spawnHelper } = fakeHelper()
    const windows = new WindowIdentity({ helperPath: 'helper.exe', logger: silentLogger, spawnHelper })
    windows.warm()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.lines).toEqual([])
    windows.warm()
    windows.track(TARGET)
    await flush()
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.lines).toEqual(['track\t4321\tFacet.Profile.x\tC:\\i.ico\t01 · Loja A\t"F.exe"'])
    // sem utilitário, warm não faz nada
    const none = fakeHelper()
    new WindowIdentity({ helperPath: null, logger: silentLogger, spawnHelper: none.spawnHelper }).warm()
    expect(none.spawned).toHaveLength(0)
  })

  it('sem utilitário (fora do Windows ou ausente) não inicia processo nenhum', () => {
    const { spawned, spawnHelper } = fakeHelper()
    new WindowIdentity({ helperPath: null, logger: silentLogger, spawnHelper }).track(TARGET)
    expect(spawned).toHaveLength(0)
    const warn = vi.fn()
    const missing = new WindowIdentity({
      helperPath: path.join(root, 'nao-existe.exe'),
      logger: { ...silentLogger, warn },
    })
    missing.track(TARGET)
    missing.track(TARGET)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
