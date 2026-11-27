import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createContainer, type Container } from '@main/container'
import { silentLogger } from '@main/logger'
import { ensureBaseDirs, resolveAppPaths } from '@main/paths'
import { createTestSecretBox } from '@main/security/secrets'
import { DEFAULT_LAUNCH_OPTIONS } from '@shared/schemas/profile'
import { createDefaultFingerprint, fingerprintKey } from '@shared/schemas/fingerprint'
import { AppError } from '@shared/ipc/result'
import { proxyCreateSchema } from '@shared/schemas/proxy'

describe('SQLite e pastas persistentes', () => {
  let directory: string
  let app: Container
  const make = (hostLanguages: readonly string[] = ['es-MX', 'en-US']): Container => {
    const paths = resolveAppPaths(directory)
    ensureBaseDirs(paths)
    return createContainer({
      paths,
      migrationsFolder: resolve('drizzle'),
      emit: vi.fn(),
      logger: silentLogger,
      hostTimezone: 'America/Sao_Paulo',
      hostLanguages,
      secrets: createTestSecretBox(),
    })
  }
  const create = (name = 'Persistente') =>
    app.services.profiles.create({
      name,
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
    })
  beforeEach(() => {
    const root = resolve('.tmp-tests')
    fs.mkdirSync(root, { recursive: true })
    directory = fs.mkdtempSync(join(root, 'database-'))
    app = make()
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await app.runtime.stopAll()
    await app.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('começa vazio, configura WAL/FKs e persiste perfil, grupo, tags e configurações ao reabrir', () => {
    expect(app.repos.profiles.list('all')).toEqual([])
    expect(app.repos.proxies.list()).toEqual([])
    expect(app.database.sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(app.database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    const group = app.services.groups.create({ name: 'Agência', color: '#5B5BF7' })
    const tag = app.services.tags.create({ name: 'QA', color: '#5B5BF7' })
    const initial = create()
    const profile = app.services.profiles.update(initial.id, {
      groupId: group.id,
      tagIds: [tag.id],
      notes: 'Ação e revisão',
    })
    app.services.settings.update({ theme: 'dark', language: 'en' })
    app.close()
    app = make()
    expect(app.services.profiles.get(profile.id)).toEqual(profile)
    expect(app.services.groups.list()).toEqual([group])
    expect(app.services.tags.list()).toEqual([tag])
    expect(app.services.settings.get()).toMatchObject({ theme: 'dark', language: 'en' })
    expect(fs.existsSync(app.files.directory(profile.id))).toBe(false)
    expect(app.database.sqlite.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get()).toEqual({
      n: 11,
    })
    expect(app.database.brokenReferences).toBe(0)
    expect(app.database.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
  })

  it('guarda a apresentação da tabela e recupera padrões se a configuração antiga é inválida', async () => {
    expect(app.services.settings.get().profileTable).toEqual({ hidden: [], widths: {} })
    app.services.settings.update({ profileTable: { hidden: ['serial', 'proxy'], widths: { name: 480 } } })
    await app.close()
    app = make()
    expect(app.services.settings.get().profileTable).toEqual({
      hidden: ['serial', 'proxy'],
      widths: { name: 480 },
    })
    app.database.sqlite
      .prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run(JSON.stringify({ hidden: ['name'], widths: { name: -20 } }), 'profileTable')
    await app.close()
    app = make()
    expect(app.services.settings.get().profileTable).toEqual({ hidden: [], widths: {} })
  })

  it('boas-vindas: usa o idioma do sistema só na instalação nova e persiste a conclusão', async () => {
    expect(app.services.settings.get()).toMatchObject({ language: 'es', onboardingCompleted: false })
    app.services.settings.update({ language: 'en', theme: 'dark' })
    await app.close()
    app = make(['pt-BR'])
    expect(app.services.settings.get()).toMatchObject({
      language: 'en',
      theme: 'dark',
      onboardingCompleted: false,
    })
    app.services.settings.update({ defaultBrowser: 'chrome', onboardingCompleted: true })
    await app.close()
    app = make(['pt-BR'])
    expect(app.services.settings.get()).toMatchObject({
      language: 'en',
      theme: 'dark',
      defaultBrowser: 'chrome',
      onboardingCompleted: true,
    })
  })

  it('instalação SQLite anterior pula as boas-vindas sem alterar preferências nem perfis', async () => {
    const profile = create('Já existente')
    app.services.settings.update({ language: 'pt-BR', theme: 'light', defaultBrowser: 'brave' })
    app.database.sqlite.prepare('DELETE FROM settings WHERE key = ?').run('onboardingCompleted')
    await app.close()
    app = make(['en-US'])
    expect(app.services.settings.get()).toMatchObject({
      language: 'pt-BR',
      theme: 'light',
      defaultBrowser: 'brave',
      onboardingCompleted: true,
    })
    expect(app.services.profiles.get(profile.id)).toEqual(profile)
  })

  it('importa as preferências JSON uma única vez sem apagar o arquivo antigo', () => {
    app.close()
    // Banco novo em outra pasta, mantendo o fixture anterior somente até a limpeza.
    fs.rmSync(join(directory, 'data', 'facet.sqlite'), { force: true })
    const file = resolveAppPaths(directory).settingsFile
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', language: 'en', sidebarCollapsed: true }))
    app = make()
    expect(app.services.settings.get()).toMatchObject({
      theme: 'dark',
      language: 'en',
      sidebarCollapsed: true,
      onboardingCompleted: true,
    })
    app.services.settings.update({ theme: 'light' })
    app.close()
    app = make()
    expect(app.services.settings.get().theme).toBe('light')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ theme: 'dark' })
  })

  it('reverte todo um lote e todas as relações se uma FK for inválida', () => {
    const first = create()
    const good = { ...first, id: randomUUID(), name: 'Novo' }
    const invalid = { ...first, id: randomUUID(), tagIds: [randomUUID()] }
    expect(() => app.repos.profiles.insertMany([good, invalid])).toThrow()
    expect(app.repos.profiles.list('all')).toEqual([first])
    expect(() =>
      app.repos.profiles.update(first.id, { name: 'Não pode ficar', tagIds: [randomUUID()] }),
    ).toThrow()
    expect(app.services.profiles.get(first.id)).toEqual(first)
  })

  it('normaliza nomes Unicode e reverte exclusão de grupo quando a transação falha', () => {
    const group = app.services.groups.create({ name: 'Agência', color: '#5B5BF7' })
    expect(() => app.services.groups.create({ name: 'AGE\u0302NCIA', color: '#5B5BF7' })).toThrow(AppError)
    const tag = app.services.tags.create({ name: 'Revisão', color: '#5B5BF7' })
    expect(() => app.services.tags.create({ name: 'REVISA\u0303O', color: '#5B5BF7' })).toThrow(AppError)
    const profile = create()
    app.services.profiles.update(profile.id, { groupId: group.id, tagIds: [tag.id] })
    const deletion = vi.spyOn(app.repos.groups, 'delete').mockImplementationOnce(() => {
      throw new Error('Falha injetada')
    })
    expect(() => app.services.groups.delete(group.id)).toThrow('Falha injetada')
    expect(app.services.profiles.get(profile.id).groupId).toBe(group.id)
    deletion.mockRestore()
    app.services.groups.delete(group.id)
    app.services.tags.delete(tag.id)
    expect(app.services.profiles.get(profile.id)).toMatchObject({ groupId: null, tagIds: [] })
  })

  it('mantém perfil e arquivos quando o encerramento falha', async () => {
    const profile = create()
    const folder = app.files.prepare(profile.id)
    fs.writeFileSync(join(folder, 'marker'), 'preservar')
    vi.spyOn(app.runtime, 'runStopped').mockRejectedValue(
      new AppError('BROWSER_STOP_FAILED', 'Falha injetada'),
    )
    await expect(app.services.trash.trash([profile.id])).rejects.toMatchObject({
      code: 'BROWSER_STOP_FAILED',
    })
    expect(app.services.profiles.get(profile.id).deletedAt).toBeNull()
    expect(fs.readFileSync(join(folder, 'marker'), 'utf8')).toBe('preservar')
  })

  it('desfaz a movimentação de pasta quando a exclusão no banco falha', async () => {
    const profile = create()
    const folder = app.files.prepare(profile.id)
    fs.writeFileSync(join(folder, 'marker'), 'preservar')
    await app.services.trash.trash([profile.id])
    vi.spyOn(app.repos.profiles, 'deleteMany').mockImplementationOnce(() => {
      throw new Error('Falha de disco injetada')
    })
    await expect(app.services.trash.deletePermanently([profile.id])).rejects.toThrow(
      'Falha de disco injetada',
    )
    expect(app.repos.profiles.get(profile.id)).not.toBeNull()
    expect(fs.readFileSync(join(folder, 'marker'), 'utf8')).toBe('preservar')
    await expect(app.services.trash.deletePermanently([profile.id])).resolves.toEqual({ count: 1 })
    expect(fs.existsSync(folder)).toBe(false)
    expect(app.repos.profiles.get(profile.id)).toBeNull()
  }, 20000)

  it('grava senha, URL de troca e token de geo-IP cifrados e os lê de volta ao reabrir', async () => {
    const proxy = app.services.proxies.create(
      proxyCreateSchema.parse({
        name: 'Rotativo',
        type: 'socks5',
        host: 'Proxy.Example.com',
        port: 1080,
        username: 'user',
        password: 'segredo-db',
        changeIpUrl: 'https://api.provider.example/rotate?key=chave-db',
        notes: '',
      }),
    )
    app.geoIpToken.set('token-db')
    // Visão crua do banco (BLOBs como texto): nenhum segredo em claro
    const asText = (value: unknown): string =>
      JSON.stringify(value, (_key, item: unknown) =>
        item && typeof item === 'object' && 'type' in item && item.type === 'Buffer'
          ? Buffer.from((item as unknown as { data: number[] }).data).toString('latin1')
          : item,
      )
    const row = app.database.sqlite.prepare('SELECT * FROM proxies WHERE id = ?').get(proxy.id) as Record<
      string,
      unknown
    >
    const settingsRows = app.database.sqlite.prepare('SELECT * FROM settings').all()
    for (const secret of ['segredo-db', 'chave-db', 'token-db']) {
      expect(asText(row)).not.toContain(secret)
      expect(asText(settingsRows)).not.toContain(secret)
    }
    expect(row).toMatchObject({ host: 'proxy.example.com', change_ip_host: 'api.provider.example' })
    expect(Object.keys(row)).not.toContain('change_ip_url')
    expect(app.services.settings.get()).not.toHaveProperty('secret.geoIpToken')

    await app.close()
    app = make()
    expect(app.repos.proxies.secrets(proxy.id)).toEqual({
      password: 'segredo-db',
      changeIpUrl: 'https://api.provider.example/rotate?key=chave-db',
    })
    expect(app.geoIpToken.configured()).toBe(true)
    expect(app.geoIpToken.get()).toBe('token-db')
    app.geoIpToken.set(null)
    expect(app.geoIpToken.configured()).toBe(false)
  })

  it('verificação fica gravada e é zerada ao trocar o endereço; excluir proxy em uso desliga o perfil', () => {
    const proxy = app.services.proxies.create(
      proxyCreateSchema.parse({
        name: '',
        type: 'http',
        host: '1.2.3.4',
        port: 8080,
        username: '',
        password: '',
        changeIpUrl: '',
        notes: '',
      }),
    )
    app.repos.proxies.saveCheck(proxy.id, {
      status: 'online',
      latencyMs: 30,
      exitIp: '203.0.113.7',
      countryCode: 'BR',
      countryName: 'Brazil',
      region: null,
      city: 'São Paulo',
      timezone: 'America/Sao_Paulo',
      latitude: -23.55,
      longitude: -46.63,
      error: null,
      checkedAt: Date.now(),
    })
    // offline mantém a última geolocalização conhecida
    const offline = app.repos.proxies.saveCheck(proxy.id, {
      status: 'offline',
      latencyMs: null,
      exitIp: null,
      countryCode: null,
      countryName: null,
      region: null,
      city: null,
      timezone: null,
      latitude: null,
      longitude: null,
      error: { code: 'PROXY_UNREACHABLE', message: 'fora do ar' },
      checkedAt: Date.now(),
    })
    expect(offline).toMatchObject({
      checkStatus: 'offline',
      countryCode: 'BR',
      lastErrorCode: 'PROXY_UNREACHABLE',
    })
    expect(app.services.proxies.update(proxy.id, { port: 9090 })).toMatchObject({
      checkStatus: 'unknown',
      countryCode: null,
      lastError: null,
    })
    const profile = create()
    app.services.profiles.assignProxy([profile.id], proxy.id)
    expect(() => app.services.proxies.delete([proxy.id], false)).toThrow(AppError)
    expect(app.services.proxies.delete([proxy.id], true)).toEqual({ count: 1, detachedProfiles: 1 })
    expect(app.services.profiles.get(profile.id).proxyId).toBeNull()
  })

  it('recupera exclusões interrompidas antes e depois da confirmação no banco', () => {
    const kept = create('Ainda existe')
    const removed = create('Foi excluído')
    for (const profile of [kept, removed]) {
      fs.writeFileSync(join(app.files.prepare(profile.id), 'marker'), profile.name)
      app.files.stageDeletion(profile.id)
    }
    app.repos.profiles.deleteMany([removed.id])
    app.close()
    app = make()
    expect(fs.readFileSync(join(app.files.directory(kept.id), 'marker'), 'utf8')).toBe('Ainda existe')
    expect(fs.existsSync(app.files.directory(removed.id))).toBe(false)
    expect(fs.readdirSync(join(app.files.root, '.pending-delete'))).toEqual([])
  })

  it('vínculos perfil ↔ extensão: estado preservado ao editar, cascata ao excluir e configuração cifrada', () => {
    const pkg = (id: string, name: string) => ({
      id,
      name,
      version: '1.0.0',
      description: '',
      manifestVersion: 3,
      source: 'zip' as const,
      publicKey: 'chave',
      dirName: '0a1b2c3d',
      icon: null,
      permissions: ['storage'],
      sizeBytes: 10,
    })
    const a = 'a'.repeat(32)
    const b = 'b'.repeat(32)
    app.repos.extensions.savePackage(pkg(a, 'Alfa'), 1)
    app.repos.extensions.savePackage(pkg(b, 'Beta'), 1)
    const profile = app.services.profiles.create({
      name: 'Com extensões',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
      color: null,
      notes: '',
      launchOptions: structuredClone(DEFAULT_LAUNCH_OPTIONS),
      extensionIds: [a, b],
    })
    expect([...profile.extensionIds].sort()).toEqual([a, b])
    expect(app.repos.extensions.get(a)?.profileCount).toBe(1)
    app.repos.extensions.markLoaded(profile.id, [a], 1000)
    app.repos.extensions.markConfigResult(profile.id, a, { revision: 1, at: 1500 })
    // tirar "b" não mexe no estado de "a"
    app.services.profiles.update(profile.id, { extensionIds: [a] })
    expect(app.repos.extensions.profileState(profile.id)).toEqual([
      {
        extensionId: a,
        addedAt: expect.any(Number) as number,
        firstLoadedAt: 1000,
        configRevision: 1,
        configAppliedAt: 1500,
        configError: null,
      },
    ])
    expect(app.repos.extensions.profileIdsUsing([a, b])).toEqual([profile.id])
    // configuração cifrada no banco, legível só pelo repositório
    app.repos.extensions.setConfig(
      a,
      { area: 'local', mode: 'once', json: '{"segredo":"abc123"}', keys: 1 },
      false,
      2,
    )
    const raw = app.database.sqlite.prepare('SELECT config_enc FROM extensions WHERE id = ?').get(a) as {
      config_enc: Buffer
    }
    expect(raw.config_enc.toString('utf8')).not.toContain('abc123')
    expect(app.repos.extensions.config(a)).toMatchObject({ json: '{"segredo":"abc123"}', revision: 1 })
    // "reapply" zera o estado de quem já recebeu
    app.repos.extensions.setConfig(a, { area: 'local', mode: 'once', json: '{"x":1}', keys: 1 }, true, 3)
    expect(app.repos.extensions.profileState(profile.id)[0]).toMatchObject({
      configRevision: null,
      firstLoadedAt: 1000,
    })
    expect(app.repos.extensions.get(a)?.config).toMatchObject({ revision: 2, keys: 1 })
    // excluir a extensão tira o vínculo; excluir o perfil também
    app.repos.extensions.deleteMany([a])
    expect(app.services.profiles.get(profile.id).extensionIds).toEqual([])
    app.services.profiles.update(profile.id, { extensionIds: [b] })
    app.repos.profiles.deleteMany([profile.id])
    expect(app.database.sqlite.prepare('SELECT count(*) AS n FROM profile_extensions').get()).toEqual({
      n: 0,
    })
    expect(app.repos.extensions.get(b)?.profileCount).toBe(0)
  })

  it('numera os perfis no SQLite em sequência, sem reaproveitar o número de um perfil excluído', async () => {
    const first = create('Primeiro')
    const bulk = app.services.profiles.bulkCreate({
      count: 2,
      namePrefix: 'Lote',
      os: 'windows',
      groupId: null,
      proxyId: null,
      tagIds: [],
    })
    expect([first.serial, ...bulk.map((p) => p.serial)]).toEqual([1, 2, 3])
    await app.services.trash.trash([bulk[1]!.id])
    await app.services.trash.deletePermanently([bulk[1]!.id])
    expect(create('Depois').serial).toBe(4)
    expect(
      app.database.sqlite.prepare("SELECT value FROM counters WHERE name = 'profile_serial'").get(),
    ).toEqual({
      value: 4,
    })
    // reabrir mantém os números e o contador
    await app.close()
    app = make()
    expect(app.services.profiles.list('active').map((p) => [p.name, p.serial])).toEqual(
      expect.arrayContaining([
        ['Primeiro', 1],
        ['Lote 01', 2],
        ['Depois', 4],
      ]),
    )
    expect(create('Mais um').serial).toBe(5)
  })

  it('migration 0006 numera os perfis existentes pela ordem de criação e preserva as relações', async () => {
    await app.close()
    // banco parado na migration 0005, com perfis (um deles na lixeira) e uma tag
    const older = join(directory, 'drizzle-0005')
    fs.mkdirSync(join(older, 'meta'), { recursive: true })
    for (const file of fs.readdirSync(resolve('drizzle')).filter((name) => /^000[0-5]_.*\.sql$/.test(name)))
      fs.copyFileSync(resolve('drizzle', file), join(older, file))
    const journal = JSON.parse(fs.readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number }[]
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= 5)
    fs.writeFileSync(join(older, 'meta', '_journal.json'), JSON.stringify(journal))
    const paths = resolveAppPaths(directory)
    fs.rmSync(paths.databaseFile, { force: true })
    const { openDatabase } = await import('@main/db/client')
    const legacy = openDatabase(paths.databaseFile, older)
    const insert = legacy.sqlite.prepare(
      `INSERT INTO profiles (id, name, notes, os, user_agent, fingerprint, launch_options, last_urls,
        open_count, created_at, updated_at, deleted_at)
       VALUES (?, ?, '', 'windows', 'ua', '{}', '{}', '[]', 0, ?, ?, ?)`,
    )
    const ids = { a: randomUUID(), b: randomUUID(), c: randomUUID() }
    insert.run(ids.c, 'Terceiro', 300, 300, null)
    insert.run(ids.a, 'Primeiro', 100, 100, null)
    insert.run(ids.b, 'Na lixeira', 200, 200, 250)
    legacy.sqlite
      .prepare(
        "INSERT INTO tags (id, name, name_key, color, created_at) VALUES ('t', 'Tag', 'tag', '#5B5BF7', 1)",
      )
      .run()
    legacy.sqlite.prepare('INSERT INTO profile_tags (profile_id, tag_id) VALUES (?, ?)').run(ids.a, 't')
    legacy.close()

    const upgraded = openDatabase(paths.databaseFile, resolve('drizzle'))
    try {
      expect(upgraded.sqlite.prepare('SELECT name, serial FROM profiles ORDER BY serial').all()).toEqual([
        { name: 'Primeiro', serial: 1 },
        { name: 'Na lixeira', serial: 2 },
        { name: 'Terceiro', serial: 3 },
      ])
      expect(
        upgraded.sqlite.prepare("SELECT value FROM counters WHERE name = 'profile_serial'").get(),
      ).toEqual({
        value: 3,
      })
      expect(upgraded.sqlite.prepare('SELECT count(*) AS n FROM profile_tags').get()).toEqual({ n: 1 })
    } finally {
      upgraded.close()
    }
    app = make()
  })

  it('migration 0007 descarta as verificações antigas de proxy (mediam o IP desta máquina) e preserva o cadastro', async () => {
    await app.close()
    // banco parado na migration 0006, com um proxy marcado como "IP real" pela verificação antiga
    const older = join(directory, 'drizzle-0006')
    fs.mkdirSync(join(older, 'meta'), { recursive: true })
    for (const file of fs.readdirSync(resolve('drizzle')).filter((name) => /^000[0-6]_.*\.sql$/.test(name)))
      fs.copyFileSync(resolve('drizzle', file), join(older, file))
    const journal = JSON.parse(fs.readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number }[]
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= 6)
    fs.writeFileSync(join(older, 'meta', '_journal.json'), JSON.stringify(journal))
    const paths = resolveAppPaths(directory)
    fs.rmSync(paths.databaseFile, { force: true })
    const { openDatabase } = await import('@main/db/client')
    const legacy = openDatabase(paths.databaseFile, older)
    legacy.sqlite
      .prepare(
        `INSERT INTO proxies (id, name, type, host, port, username, password_enc, notes, check_status,
          checked_at, latency_ms, exit_ip, country_code, country_name, region, city, timezone, latitude,
          longitude, last_error, last_error_code, created_at, updated_at)
         VALUES ('p', 'Residencial', 'socks5', 'proxy.example', 824, 'user', X'0102', 'nota', 'offline',
          500, 12, '203.0.113.11', 'BR', 'Brazil', 'São Paulo', 'São Paulo', 'America/Sao_Paulo', -23.55,
          -46.63, 'O proxy está saindo pelo IP real', 'PROXY_REAL_IP', 1, 2)`,
      )
      .run()
    legacy.close()

    const upgraded = openDatabase(paths.databaseFile, resolve('drizzle'))
    try {
      expect(upgraded.sqlite.prepare("SELECT * FROM proxies WHERE id = 'p'").get()).toEqual({
        id: 'p',
        name: 'Residencial',
        type: 'socks5',
        host: 'proxy.example',
        port: 824,
        username: 'user',
        password_enc: Buffer.from([1, 2]),
        change_ip_url_enc: null,
        change_ip_host: null,
        notes: 'nota',
        check_status: 'unknown',
        checked_at: null,
        latency_ms: null,
        exit_ip: null,
        country_code: null,
        country_name: null,
        region: null,
        city: null,
        timezone: null,
        latitude: null,
        longitude: null,
        last_error: null,
        last_error_code: null,
        created_at: 1,
        updated_at: 2,
      })
    } finally {
      upgraded.close()
    }
    app = make()
  })

  it('migration 0008 registra o hardware emulado dos perfis existentes no formato do gerador', async () => {
    await app.close()
    // banco parado na migration 0007: perfis emulados (um repetido), um v1, um nativo e um na lixeira
    const older = join(directory, 'drizzle-0007')
    fs.mkdirSync(join(older, 'meta'), { recursive: true })
    for (const file of fs.readdirSync(resolve('drizzle')).filter((name) => /^000[0-7]_.*\.sql$/.test(name)))
      fs.copyFileSync(resolve('drizzle', file), join(older, file))
    const journal = JSON.parse(fs.readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number }[]
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= 7)
    fs.writeFileSync(join(older, 'meta', '_journal.json'), JSON.stringify(journal))
    const paths = resolveAppPaths(directory)
    fs.rmSync(paths.databaseFile, { force: true })
    const { openDatabase } = await import('@main/db/client')
    const legacy = openDatabase(paths.databaseFile, older)
    const base = createDefaultFingerprint({
      os: 'windows',
      engineMajor: 158,
      timezone: 'UTC',
      mode: 'emulated',
    })
    const emulated = {
      ...base,
      screen: {
        width: 1536,
        height: 864,
        availWidth: 1536,
        availHeight: 816,
        colorDepth: 24,
        pixelRatio: 1.25,
      },
      navigator: { ...base.navigator, hardwareConcurrency: 12, deviceMemory: 8 },
    }
    const brave = { ...base, os: 'linux' as const, navigator: { ...base.navigator, deviceMemory: null } }
    const { mode: _mode, ...rest } = { ...base, os: 'macos' as const }
    const v1 = { ...rest, version: 1 }
    const native = {
      ...base,
      mode: 'native' as const,
      navigator: { ...base.navigator, hardwareConcurrency: 4 },
    }
    const insert = legacy.sqlite.prepare(
      `INSERT INTO profiles (id, serial, name, notes, os, user_agent, fingerprint, launch_options, last_urls,
        open_count, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, '', ?, 'ua', ?, '{}', '[]', 0, ?, ?, ?)`,
    )
    const rows = [
      [emulated, 300, null],
      [emulated, 100, 150],
      [brave, 200, null],
      [v1, 400, null],
      [native, 500, null],
    ] as const
    rows.forEach(([fingerprint, at, deletedAt], index) =>
      insert.run(
        randomUUID(),
        index + 1,
        `P${index}`,
        fingerprint.os,
        JSON.stringify(fingerprint),
        at,
        at,
        deletedAt,
      ),
    )
    // o app mantém o contador junto com os números (gravados à mão aqui)
    legacy.sqlite.prepare("UPDATE counters SET value = ? WHERE name = 'profile_serial'").run(rows.length)
    legacy.close()

    const upgraded = openDatabase(paths.databaseFile, resolve('drizzle'))
    try {
      const history = upgraded.sqlite
        .prepare('SELECT key, first_used_at AS at FROM fingerprint_history ORDER BY key')
        .all()
      expect(history).toEqual(
        [
          { key: fingerprintKey(brave)!, at: 200 },
          { key: fingerprintKey({ ...v1, mode: undefined })!, at: 400 },
          { key: fingerprintKey(emulated)!, at: 100 },
        ].sort((a, b) => (a.key < b.key ? -1 : 1)),
      )
      expect(fingerprintKey(emulated)).toBe('windows|1536x864|1536x816|24|1.25|12|8|0')
      expect(fingerprintKey(brave)).toContain('|brave|')
    } finally {
      upgraded.close()
    }
    // o repositório soma o histórico aos perfis atuais e registra cada perfil gravado
    app = make()
    const usage = app.repos.profiles.fingerprintUsage()
    expect(usage.inUse.get(fingerprintKey(emulated)!)).toBe(2)
    expect(usage.used.size).toBe(3)
    const created = create('Novo')
    const key = fingerprintKey(created.fingerprint)!
    expect(created.fingerprint.mode).toBe('emulated')
    expect([...usage.used]).not.toContain(key)
    app.services.profiles.update(created.id, { os: 'linux' })
    const after = app.repos.profiles.fingerprintUsage()
    expect(after.used.has(key)).toBe(true)
    expect(after.inUse.has(key)).toBe(false)
  })

  it('migration 0009 aceita a extensão integrada sem perder extensões, configuração nem vínculos com perfis', async () => {
    await app.close()
    // banco parado na migration 0008: uma extensão com autoconfiguração, usada por dois perfis
    const older = join(directory, 'drizzle-0008')
    fs.mkdirSync(join(older, 'meta'), { recursive: true })
    for (const file of fs.readdirSync(resolve('drizzle')).filter((name) => /^000[0-8]_.*\.sql$/.test(name)))
      fs.copyFileSync(resolve('drizzle', file), join(older, file))
    const journal = JSON.parse(fs.readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number }[]
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= 8)
    fs.writeFileSync(join(older, 'meta', '_journal.json'), JSON.stringify(journal))
    const paths = resolveAppPaths(directory)
    fs.rmSync(paths.databaseFile, { force: true })
    const { openDatabase } = await import('@main/db/client')
    const legacy = openDatabase(paths.databaseFile, older)
    const extensionId = 'a'.repeat(32)
    legacy.sqlite
      .prepare(
        `INSERT INTO extensions (id, name, version, description, manifest_version, source, public_key,
          dir_name, icon, permissions, is_default, config_enc, config_area, config_mode, config_keys,
          config_revision, config_updated_at, size_bytes, created_at, updated_at)
         VALUES (?, 'Pasta', '2.3.0', 'desc', 3, 'folder', 'chave', 'abcd1234', NULL, '["storage"]', 1,
          X'0102', 'local', 'once', 2, 4, 50, 1234, 10, 20)`,
      )
      .run(extensionId)
    const insertProfile = legacy.sqlite.prepare(
      `INSERT INTO profiles (id, serial, name, notes, os, user_agent, fingerprint, launch_options, last_urls,
        open_count, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, '', 'windows', 'ua', '{}', '{}', '[]', 0, 1, 1, NULL)`,
    )
    const profiles = [randomUUID(), randomUUID()]
    profiles.forEach((id, index) => insertProfile.run(id, index + 1, `P${index}`))
    const link = legacy.sqlite.prepare(
      `INSERT INTO profile_extensions (profile_id, extension_id, added_at, first_loaded_at, config_revision)
       VALUES (?, ?, 5, 6, 4)`,
    )
    for (const id of profiles) link.run(id, extensionId)
    legacy.close()

    const upgraded = openDatabase(paths.databaseFile, resolve('drizzle'))
    try {
      expect(upgraded.brokenReferences).toBe(0)
      expect(upgraded.sqlite.prepare('SELECT * FROM extensions').all()).toEqual([
        {
          id: extensionId,
          name: 'Pasta',
          version: '2.3.0',
          description: 'desc',
          manifest_version: 3,
          source: 'folder',
          public_key: 'chave',
          dir_name: 'abcd1234',
          icon: null,
          permissions: '["storage"]',
          is_default: 1,
          config_enc: Buffer.from([1, 2]),
          config_area: 'local',
          config_mode: 'once',
          config_keys: 2,
          config_revision: 4,
          config_updated_at: 50,
          size_bytes: 1234,
          created_at: 10,
          updated_at: 20,
        },
      ])
      // o DROP TABLE da recriação não apagou os vínculos em cascata
      expect(
        upgraded.sqlite
          .prepare('SELECT profile_id, config_revision FROM profile_extensions ORDER BY profile_id')
          .all(),
      ).toEqual([...profiles].sort().map((id) => ({ profile_id: id, config_revision: 4 })))
      // a restrição aceita a extensão integrada e continua recusando origens desconhecidas
      const insert = upgraded.sqlite.prepare(
        `INSERT INTO extensions (id, name, version, manifest_version, source, public_key, dir_name,
          size_bytes, created_at, updated_at) VALUES (?, 'X', '1', 3, ?, 'k', 'd', 1, 1, 1)`,
      )
      insert.run('b'.repeat(32), 'builtin')
      expect(() => insert.run('c'.repeat(32), 'outra')).toThrow(/CHECK constraint failed/)
      expect(
        upgraded.sqlite.prepare("SELECT sql FROM sqlite_master WHERE name = 'extensions'").get(),
      ).toEqual({
        sql: expect.not.stringContaining('__new_extensions'),
      })
      expect(
        upgraded.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'extensions_default_idx'").get(),
      ).toEqual({ name: 'extensions_default_idx' })
      // chaves estrangeiras de volta: excluir a extensão leva os vínculos junto
      expect(upgraded.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
      upgraded.sqlite.prepare('DELETE FROM extensions WHERE id = ?').run(extensionId)
      expect(upgraded.sqlite.prepare('SELECT count(*) AS n FROM profile_extensions').get()).toEqual({ n: 0 })
    } finally {
      upgraded.close()
    }
    app = make()
  })

  it('migration 0010: perfis existentes ficam no Brave, Android e iOS passam a valer e nada se perde', async () => {
    await app.close()
    // banco parado na migration 0009, com um perfil ligado a tag, extensão, cookies pendentes e sessão
    const older = join(directory, 'drizzle-0009')
    fs.mkdirSync(join(older, 'meta'), { recursive: true })
    for (const file of fs.readdirSync(resolve('drizzle')).filter((name) => /^000[0-9]_.*\.sql$/.test(name)))
      fs.copyFileSync(resolve('drizzle', file), join(older, file))
    const journal = JSON.parse(fs.readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { idx: number }[]
    }
    journal.entries = journal.entries.filter((entry) => entry.idx <= 9)
    fs.writeFileSync(join(older, 'meta', '_journal.json'), JSON.stringify(journal))
    const paths = resolveAppPaths(directory)
    fs.rmSync(paths.databaseFile, { force: true })
    const { openDatabase } = await import('@main/db/client')
    const legacy = openDatabase(paths.databaseFile, older)
    const fingerprint = createDefaultFingerprint({
      os: 'macos',
      engineMajor: 158,
      timezone: 'UTC',
      mode: 'emulated',
    })
    const profileId = randomUUID()
    const tagId = randomUUID()
    const extensionId = 'd'.repeat(32)
    legacy.sqlite
      .prepare(
        `INSERT INTO profiles (id, serial, name, notes, os, user_agent, fingerprint, launch_options, last_urls,
          open_count, created_at, updated_at, deleted_at)
         VALUES (?, 7, 'Antigo', 'nota', 'macos', ?, ?, ?, '["https://a.test/"]', 3, 1, 2, NULL)`,
      )
      .run(
        profileId,
        fingerprint.userAgent,
        JSON.stringify(fingerprint),
        JSON.stringify(DEFAULT_LAUNCH_OPTIONS),
      )
    legacy.sqlite
      .prepare(
        `INSERT INTO tags (id, name, name_key, color, created_at) VALUES (?, 'Loja', 'loja', '#5B5BF7', 1)`,
      )
      .run(tagId)
    legacy.sqlite.prepare('INSERT INTO profile_tags (profile_id, tag_id) VALUES (?, ?)').run(profileId, tagId)
    legacy.sqlite
      .prepare(
        `INSERT INTO extensions (id, name, version, manifest_version, source, public_key, dir_name, size_bytes,
          created_at, updated_at) VALUES (?, 'X', '1', 3, 'folder', 'k', 'd', 1, 1, 1)`,
      )
      .run(extensionId)
    legacy.sqlite
      .prepare('INSERT INTO profile_extensions (profile_id, extension_id, added_at) VALUES (?, ?, 1)')
      .run(profileId, extensionId)
    legacy.sqlite
      .prepare('INSERT INTO pending_cookies (profile_id, cookies_enc, count, created_at) VALUES (?, ?, 2, 1)')
      .run(profileId, Buffer.from([9]))
    // executável do Brave escolhido antes dos vários navegadores
    legacy.sqlite
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('browserPath', ?, 1)")
      .run(JSON.stringify('C:/Navegadores/Brave/brave.exe'))
    // configurações já migradas do arquivo JSON antigo (como num banco real)
    legacy.sqlite
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('_legacyImported', 'true', 1)")
      .run()
    legacy.close()

    const upgraded = openDatabase(paths.databaseFile, resolve('drizzle'))
    try {
      expect(upgraded.brokenReferences).toBe(0)
      expect(
        upgraded.sqlite.prepare('SELECT browser, os, serial, open_count, last_urls FROM profiles').all(),
      ).toEqual([
        { browser: 'brave', os: 'macos', serial: 7, open_count: 3, last_urls: '["https://a.test/"]' },
      ])
      for (const table of ['profile_tags', 'profile_extensions', 'pending_cookies'])
        expect(upgraded.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get(), table).toEqual({ n: 1 })
      const insert = upgraded.sqlite.prepare(
        `INSERT INTO profiles (id, serial, name, notes, browser, os, user_agent, fingerprint, launch_options,
          created_at, updated_at) VALUES (?, ?, 'N', '', ?, ?, 'ua', '{}', '{}', 1, 1)`,
      )
      insert.run(randomUUID(), 8, 'ungoogled', 'android')
      insert.run(randomUUID(), 9, 'opera', 'ios')
      expect(() => insert.run(randomUUID(), 10, 'firefox', 'windows')).toThrow(/CHECK constraint failed/)
      expect(() => insert.run(randomUUID(), 11, 'chrome', 'symbian')).toThrow(/CHECK constraint failed/)
      // chaves estrangeiras de volta: excluir o perfil leva os vínculos junto
      upgraded.sqlite.prepare('DELETE FROM profiles WHERE id = ?').run(profileId)
      expect(upgraded.sqlite.prepare('SELECT count(*) AS n FROM profile_tags').get()).toEqual({ n: 0 })
    } finally {
      upgraded.close()
    }
    app = make()
    // o executável antigo vira o do Brave; perfis novos usam o Ungoogled Chromium
    expect(app.services.settings.get()).toMatchObject({
      defaultBrowser: 'ungoogled',
      browserPaths: { ungoogled: '', chrome: '', brave: 'C:/Navegadores/Brave/brave.exe', opera: '' },
    })
    expect(create('Novo').browser).toBe('ungoogled')
    // depois de gravar, o caminho antigo não volta (o usuário pode ter limpado o do Brave)
    app.services.settings.update({ browserPaths: { ...app.services.settings.get().browserPaths, brave: '' } })
    await app.close()
    app = make()
    expect(app.services.settings.get().browserPaths.brave).toBe('')
  })
})
