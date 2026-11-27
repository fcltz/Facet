import { and, eq, inArray } from 'drizzle-orm'
import { AppError } from '@shared/ipc/result'
import type { ProxyCheckOutcome, ProxySummary } from '@shared/schemas/proxy'
import type { AppDatabase } from '../../db/client'
import { proxies } from '../../db/schema'
import type { SecretBox } from '../../security/secrets'
import type { NewProxy, ProxyEndpoint, ProxyPatch, ProxyRepository, ProxySecrets } from '../types'

type Row = typeof proxies.$inferSelect

/** Domínio da URL de troca de IP (exibido sem a chave da API). */
export function changeIpHostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

function summary(row: Row): ProxySummary {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.host,
    port: row.port,
    username: row.username,
    hasPassword: row.passwordEnc !== null,
    rotating: row.changeIpUrlEnc !== null,
    changeIpHost: row.changeIpHost,
    notes: row.notes,
    checkStatus: row.checkStatus,
    checkedAt: row.checkedAt,
    latencyMs: row.latencyMs,
    exitIp: row.exitIp,
    countryCode: row.countryCode,
    countryName: row.countryName,
    region: row.region,
    city: row.city,
    timezone: row.timezone,
    latitude: row.latitude,
    longitude: row.longitude,
    lastError: row.lastError,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } } | null)?.code
  const causeCode = (error as { cause?: { code?: string } } | null)?.cause?.code
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || causeCode === 'SQLITE_CONSTRAINT_UNIQUE'
}

function duplicateEndpoint(): AppError {
  return new AppError('CONFLICT', 'Já existe um proxy com este tipo, endereço, porta e usuário', {
    reason: 'duplicateEndpoint',
    entity: 'proxy',
  })
}

/** 500 linhas por INSERT (abaixo do limite de variáveis do SQLite). */
const INSERT_CHUNK = 500

export class SqliteProxyRepository implements ProxyRepository {
  constructor(
    private readonly db: AppDatabase,
    private readonly secretBox: SecretBox,
  ) {}

  list(): ProxySummary[] {
    return this.db.select().from(proxies).all().map(summary)
  }

  get(id: string): ProxySummary | null {
    const row = this.db.select().from(proxies).where(eq(proxies.id, id)).get()
    return row ? summary(row) : null
  }

  getMany(ids: readonly string[]): ProxySummary[] {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    const rows: ProxySummary[] = []
    for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
      const chunk = unique.slice(i, i + INSERT_CHUNK)
      rows.push(...this.db.select().from(proxies).where(inArray(proxies.id, chunk)).all().map(summary))
    }
    return rows
  }

  secrets(id: string): ProxySecrets | null {
    const row = this.db
      .select({ passwordEnc: proxies.passwordEnc, changeIpUrlEnc: proxies.changeIpUrlEnc })
      .from(proxies)
      .where(eq(proxies.id, id))
      .get()
    if (!row) return null
    return {
      password: row.passwordEnc ? this.secretBox.decrypt(row.passwordEnc) : null,
      changeIpUrl: row.changeIpUrlEnc ? this.secretBox.decrypt(row.changeIpUrlEnc) : null,
    }
  }

  findByEndpoint(endpoint: ProxyEndpoint): ProxySummary | null {
    const row = this.db
      .select()
      .from(proxies)
      .where(
        and(
          eq(proxies.type, endpoint.type),
          eq(proxies.host, endpoint.host.toLowerCase()),
          eq(proxies.port, endpoint.port),
          eq(proxies.username, endpoint.username),
        ),
      )
      .get()
    return row ? summary(row) : null
  }

  insertMany(rows: readonly NewProxy[]): ProxySummary[] {
    const values = rows.map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      host: row.host.toLowerCase(),
      port: row.port,
      username: row.username,
      passwordEnc: row.password ? this.secretBox.encrypt(row.password) : null,
      changeIpUrlEnc: row.changeIpUrl ? this.secretBox.encrypt(row.changeIpUrl) : null,
      changeIpHost: changeIpHostOf(row.changeIpUrl),
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }))
    try {
      for (let i = 0; i < values.length; i += INSERT_CHUNK) {
        this.db
          .insert(proxies)
          .values(values.slice(i, i + INSERT_CHUNK))
          .run()
      }
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateEndpoint()
      throw error
    }
    return this.getMany(rows.map((row) => row.id))
  }

  update(id: string, patch: ProxyPatch): ProxySummary {
    const current = this.db.select().from(proxies).where(eq(proxies.id, id)).get()
    if (!current) throw new AppError('NOT_FOUND', `Proxy não encontrado: ${id}`, { entity: 'proxy', id })
    const set: Partial<typeof proxies.$inferInsert> = { updatedAt: patch.updatedAt }
    if (patch.name !== undefined) set.name = patch.name
    if (patch.type !== undefined) set.type = patch.type
    if (patch.host !== undefined) set.host = patch.host.toLowerCase()
    if (patch.port !== undefined) set.port = patch.port
    if (patch.username !== undefined) set.username = patch.username
    if (patch.notes !== undefined) set.notes = patch.notes
    if (patch.password !== undefined)
      set.passwordEnc = patch.password ? this.secretBox.encrypt(patch.password) : null
    if (patch.changeIpUrl !== undefined) {
      set.changeIpUrlEnc = patch.changeIpUrl ? this.secretBox.encrypt(patch.changeIpUrl) : null
      set.changeIpHost = changeIpHostOf(patch.changeIpUrl)
    }
    const endpointChanged =
      (set.type !== undefined && set.type !== current.type) ||
      (set.host !== undefined && set.host !== current.host) ||
      (set.port !== undefined && set.port !== current.port) ||
      (set.username !== undefined && set.username !== current.username)
    if (endpointChanged || patch.password !== undefined) {
      // outro endereço ou credencial: a verificação anterior deixou de valer
      Object.assign(set, {
        checkStatus: 'unknown' as const,
        checkedAt: null,
        latencyMs: null,
        lastError: null,
        lastErrorCode: null,
      })
      if (endpointChanged) {
        Object.assign(set, {
          exitIp: null,
          countryCode: null,
          countryName: null,
          region: null,
          city: null,
          timezone: null,
          latitude: null,
          longitude: null,
        })
      }
    }
    try {
      this.db.update(proxies).set(set).where(eq(proxies.id, id)).run()
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateEndpoint()
      throw error
    }
    return this.get(id)!
  }

  saveCheck(id: string, outcome: ProxyCheckOutcome): ProxySummary {
    const common = {
      checkStatus: outcome.status,
      checkedAt: outcome.checkedAt,
      lastError: outcome.error?.message ?? null,
      lastErrorCode: outcome.error?.code ?? null,
    }
    // Local medido: na verificação online e quando o proxy sai pelo IP real (o IP fica visível).
    // As demais falhas mantêm o último local conhecido.
    const set =
      outcome.status === 'online' || outcome.exitIp !== null
        ? {
            ...common,
            latencyMs: outcome.status === 'online' ? outcome.latencyMs : null,
            exitIp: outcome.exitIp,
            countryCode: outcome.countryCode,
            countryName: outcome.countryName,
            region: outcome.region,
            city: outcome.city,
            timezone: outcome.timezone,
            latitude: outcome.latitude,
            longitude: outcome.longitude,
          }
        : { ...common, latencyMs: null }
    const result = this.db.update(proxies).set(set).where(eq(proxies.id, id)).run()
    if (result.changes === 0)
      throw new AppError('NOT_FOUND', `Proxy não encontrado: ${id}`, { entity: 'proxy', id })
    return this.get(id)!
  }

  deleteMany(ids: readonly string[]): number {
    const unique = [...new Set(ids)]
    let count = 0
    for (let i = 0; i < unique.length; i += INSERT_CHUNK) {
      count += this.db
        .delete(proxies)
        .where(inArray(proxies.id, unique.slice(i, i + INSERT_CHUNK)))
        .run().changes
    }
    return count
  }
}
