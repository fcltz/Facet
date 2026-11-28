import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LaunchTiming } from '@main/browser/launcher'
import {
  findProcesses,
  inspectProcess,
  ProcessHelper,
  useProcessHelper,
  type ProcessIdentity,
} from '@main/browser/process'
import { silentLogger } from '@main/logger'
import { GeoIpClient } from '@main/proxy/geoip'
import { RealIpProbe } from '@main/proxy/real-ip'

/** Utilitário falso: guarda as linhas recebidas; `answer` decide a resposta de cada consulta. */
function fakeHelper(answer: (id: string, which: string) => string | null) {
  const spawned: { lines: string[]; child: ChildProcess }[] = []
  const spawnHelper = (): ChildProcess => {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const child = Object.assign(new EventEmitter(), {
      stdin,
      stdout,
      exitCode: null,
      unref: () => undefined,
      kill: () => true,
    }) as unknown as ChildProcess
    const record = { lines: [] as string[], child }
    stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n').filter(Boolean)) {
        record.lines.push(line)
        const [, id = '', which = ''] = line.split('\t')
        const reply = answer(id, which)
        if (reply !== null) setImmediate(() => stdout.write(`${reply}\n`))
      }
    })
    spawned.push(record)
    return child
  }
  return { spawned, spawnHelper }
}

const ROW = {
  ProcessId: 4321,
  ExecutablePath: 'C:\\Navegador\\chrome.exe',
  CommandLine: '"C:\\Navegador\\chrome.exe" "--user-data-dir=C:\\Perfis\\x" --remote-debugging-port=0',
  Started: '2026-11-28T07:38:04.9689370Z',
}

describe('consultas de processos pelo utilitário nativo (cliente)', () => {
  afterEach(() => useProcessHelper(null))

  it('uma consulta por linha, respostas casadas pelo número, mesmo fora de ordem', async () => {
    const replies = new Map<string, string>()
    const { spawned, spawnHelper } = fakeHelper((id, which) => {
      replies.set(id, which)
      // a primeira consulta só responde depois da segunda
      if (id === '1') return null
      setImmediate(() => spawned[0]!.child.stdout!.emit('data', Buffer.from(`ok\t1\t[]\n`)))
      return `ok\t${id}\t${JSON.stringify([ROW])}`
    })
    const helper = new ProcessHelper({ path: 'helper.exe', spawnHelper })
    const [all, one] = await Promise.all([helper.list(), helper.list(4321)])
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.lines).toEqual(['list\t1\t*', 'list\t2\t4321'])
    expect(all).toEqual([])
    expect(one).toEqual([ROW])
    helper.close()
  })

  it('erro, demora ou queda do utilitário: devolve null (a consulta vai para o PowerShell) e espera antes de reiniciar', async () => {
    const warn = vi.fn()
    let mode: 'error' | 'silent' | 'ok' = 'error'
    const { spawned, spawnHelper } = fakeHelper((id) =>
      mode === 'error' ? `error\t${id}\tAcesso negado` : mode === 'ok' ? `ok\t${id}\t[]` : null,
    )
    const helper = new ProcessHelper({
      path: 'helper.exe',
      spawnHelper,
      timeoutMs: 100,
      retryMs: 60_000,
      logger: { ...silentLogger, warn },
    })
    expect(await helper.list(1)).toBeNull()
    // dentro da espera: nem tenta iniciar de novo
    expect(await helper.list(1)).toBeNull()
    expect(spawned).toHaveLength(1)
    expect(warn).toHaveBeenCalledTimes(1)

    const quick = new ProcessHelper({ path: 'helper.exe', spawnHelper, timeoutMs: 100, retryMs: 0 })
    mode = 'silent'
    const started = Date.now()
    expect(await quick.list(1)).toBeNull()
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
    // caiu no meio de uma consulta: ela devolve null na hora
    const pending = quick.list(2)
    spawned.at(-1)!.child.emit('exit', 1)
    expect(await pending).toBeNull()
    // depois da espera (aqui, zero), reinicia
    mode = 'ok'
    expect(await quick.list(3)).toEqual([])
    quick.close()
  })

  it('utilitário ausente: nem tenta iniciar', async () => {
    const helper = new ProcessHelper({ path: resolve('.tmp-tests', 'nao-existe.exe') })
    expect(await helper.list(1)).toBeNull()
  })

  const real = resolve('build', 'facet-win-helper.exe')
  it.skipIf(process.platform !== 'win32' || !fs.existsSync(real))(
    'o utilitário compilado devolve o mesmo que o PowerShell (inclusive o início do processo, que as sessões guardam)',
    async () => {
      fs.mkdirSync(resolve('.tmp-tests'), { recursive: true })
      const directory = fs.mkdtempSync(resolve('.tmp-tests', 'perfil josé '))
      const dummy = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 60000)', '--', `--user-data-dir=${directory}`],
        { stdio: 'ignore' },
      )
      try {
        await new Promise((done) => dummy.once('spawn', done))
        const viaPowerShell = await inspectProcess(dummy.pid!)
        const helper = new ProcessHelper({ path: real })
        useProcessHelper(helper)
        const started = Date.now()
        const viaHelper = await inspectProcess(dummy.pid!)
        const found: ProcessIdentity[] = await findProcesses(directory)
        expect(Date.now() - started, 'sem o PowerShell').toBeLessThan(1500)
        expect(viaPowerShell).not.toBeNull()
        expect(viaHelper).toEqual(viaPowerShell)
        expect(found).toEqual([viaPowerShell])
        expect(await inspectProcess(999_999_999)).toBeNull()
      } finally {
        dummy.kill()
        fs.rmSync(directory, { recursive: true, force: true })
      }
    },
    30000,
  )
})

describe('fases da abertura no log', () => {
  it('total e cada fase em segundos, com vírgula', () => {
    let now = 1000
    const timing = new LaunchTiming(() => now)
    now += 640
    timing.mark('proxy')
    now += 900
    timing.mark('navegador')
    now += 30
    timing.mark('página')
    expect(timing.summary()).toBe('1,6 s (proxy 0,6 s · navegador 0,9 s · página 0,0 s)')
    expect(new LaunchTiming(() => 0).summary()).toBe('0,0 s')
  })
})

describe('geolocalização das checagens gravadas', () => {
  const SAO_PAULO = {
    countryCode: 'BR',
    countryName: 'Brazil',
    region: 'São Paulo',
    city: 'São Paulo',
    timezone: 'America/Sao_Paulo',
    latitude: -23.5,
    longitude: -46.6,
  }

  it('IP já checado não consulta o geo-IP de novo, pelo mesmo prazo do cache', async () => {
    let now = 10_000
    const geo = new GeoIpClient({ provider: () => 'auto', token: () => null, ttlMs: 1000, now: () => now })
    geo.remember('203.0.113.7', { ...SAO_PAULO, exitIp: 'ignorado' } as typeof SAO_PAULO, 9_500)
    // porta 1: se consultasse pela rede, falharia
    expect(await geo.lookup(1, '203.0.113.7')).toEqual({ ...SAO_PAULO, ip: '203.0.113.7', tunnelMs: null })
    // uma checagem mais antiga não substitui a mais nova
    geo.remember('203.0.113.7', { ...SAO_PAULO, city: 'Antiga' }, 9_000)
    expect(geo.cached('203.0.113.7')?.city).toBe('São Paulo')
    now = 10_600
    expect(geo.cached('203.0.113.7')).toBeNull()
  })
})

describe('IP real consultado junto com o trace do proxy', () => {
  it('warm começa a consulta e a comparação depois usa a mesma resposta', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const fetch = vi.fn(async () => {
      calls++
      await new Promise<void>((done) => (release = done))
      return 'fl=1\nip=198.51.100.9\nloc=BR\n'
    })
    const probe = new RealIpProbe({ urls: ['https://1.1.1.1/cdn-cgi/trace'], fetch })
    probe.warm()
    expect(calls).toBe(1)
    const check = probe.isRealIp('198.51.100.9')
    release!()
    expect(await check).toBe(true)
    expect(await probe.isRealIp('203.0.113.7')).toBe(false)
    expect(calls).toBe(1)
  })
})
