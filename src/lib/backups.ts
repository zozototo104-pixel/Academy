import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { NextRequest } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { audit } from '@/lib/notify'
import { readStoredFile, storeFileBuffer, storageErrorMessage } from '@/lib/storage'

export type BackupTrigger = 'manual-admin' | 'cron' | 'api-secret'

interface BackupTableSpec {
  name: string
  delegate: string
  includeByDefault?: boolean
  orderBy: Record<string, 'asc'>
}

/** Prisma is the source of truth: the old hard-coded list omitted 35 academic,
 * lecture, AI and audit models as the schema grew. Parent-first order also
 * allows FK-safe restores into an empty isolated database.
 */
export function backupTableSpecs(): BackupTableSpec[] {
  const models = Prisma.dmmf.datamodel.models
  const modelByName = new Map(models.map((model) => [model.name, model]))
  const remaining = new Map(models.map((model) => [
    model.name,
    new Set(model.fields.filter((field) =>
      field.kind === 'object' &&
      field.relationFromFields?.length > 0 &&
      modelByName.has(field.type) &&
      field.type !== model.name,
    ).map((field) => field.type)),
  ]))
  const ordered: BackupTableSpec[] = []
  while (remaining.size > 0) {
    const ready = [...remaining].filter(([, dependencies]) =>
      [...dependencies].every((name) => !remaining.has(name)),
    ).map(([name]) => name).sort()
    if (!ready.length) throw new Error('BACKUP_SCHEMA_DEPENDENCY_CYCLE')
    for (const name of ready) {
      const model = modelByName.get(name)!
      const sortFields = model.primaryKey?.fields?.length
        ? model.primaryKey.fields
        : model.fields.filter((field) => field.isId).map((field) => field.name)
      const fallback = sortFields.length ? sortFields : model.uniqueFields[0] || []
      if (!fallback.length) throw new Error(`BACKUP_MODEL_WITHOUT_STABLE_KEY:${name}`)
      ordered.push({
        name,
        delegate: name.charAt(0).toLowerCase() + name.slice(1),
        includeByDefault: name !== 'Session',
        orderBy: Object.fromEntries(fallback.map((field) => [field, 'asc' as const])),
      })
      remaining.delete(name)
    }
  }
  return ordered
}

const BACKUP_TABLES = backupTableSpecs()

function backupSecret() {
  return (process.env.AACT_BACKUP_SECRET || process.env.CRON_SECRET || '').trim()
}

function backupEncryptionSecret() {
  return (process.env.AACT_BACKUP_ENCRYPTION_KEY || '').trim()
}

function fixedTimeSecretMatch(provided: string, expected: string) {
  if (!provided || !expected) return false
  const a = Buffer.from(createHash('sha256').update(provided).digest('hex'), 'hex')
  const b = Buffer.from(createHash('sha256').update(expected).digest('hex'), 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

function backupEncryptionKey() {
  const secret = backupEncryptionSecret()
  if (secret.length < 32) {
    throw new Error('AACT_BACKUP_ENCRYPTION_KEY must be configured with at least 32 characters before creating database backups.')
  }
  return createHash('sha256').update(secret).digest()
}

function encryptBackupPayload(payload: Buffer, aad: Record<string, unknown>) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', backupEncryptionKey(), iv)
  const aadBuffer = Buffer.from(JSON.stringify(aad), 'utf8')
  cipher.setAAD(aadBuffer)
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()])
  const authTag = cipher.getAuthTag()
  const header = {
    type: 'aact-encrypted-backup-v1',
    algorithm: 'AES-256-GCM',
    key: 'AACT_BACKUP_ENCRYPTION_KEY',
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    aad,
  }
  return Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'), ciphertext])
}

function decryptBackupPayload(payload: Buffer) {
  const headerEnd = payload.indexOf(10)
  if (headerEnd <= 0) throw new Error('INVALID_ENCRYPTED_BACKUP_HEADER')
  const header = JSON.parse(payload.subarray(0, headerEnd).toString('utf8'))
  if (header.type !== 'aact-encrypted-backup-v1') throw new Error('UNSUPPORTED_BACKUP_FORMAT')
  if (header.algorithm !== 'AES-256-GCM') throw new Error('UNSUPPORTED_BACKUP_ALGORITHM')
  if (!header.iv || !header.authTag) throw new Error('INVALID_ENCRYPTED_BACKUP_METADATA')
  const aad = header.aad || {}
  const ciphertext = payload.subarray(headerEnd + 1)
  const decipher = createDecipheriv('aes-256-gcm', backupEncryptionKey(), Buffer.from(header.iv, 'base64'))
  decipher.setAAD(Buffer.from(JSON.stringify(aad), 'utf8'))
  decipher.setAuthTag(Buffer.from(header.authTag, 'base64'))
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  if (aad.compressedSha256 && aad.compressedSha256 !== sha256(compressed)) throw new Error('BACKUP_COMPRESSED_CHECKSUM_MISMATCH')
  const plain = gunzipSync(compressed)
  if (aad.uncompressedSha256 && aad.uncompressedSha256 !== sha256(plain)) throw new Error('BACKUP_UNCOMPRESSED_CHECKSUM_MISMATCH')
  return { header, aad, compressed, plain }
}

interface ParsedBackupTable {
  name: string
  delegate: string
  expected: number
  rows: Record<string, unknown>[]
}

interface BackupIntegrity {
  valid: boolean
  errors: string[]
  expectedTables: number
  includedTables: number
  missingTables: string[]
  unexpectedTables: string[]
}

/** Every table/header/count must match before a backup can be treated as restorable.
 * Old partial backups remain inspectable, but cannot be silently restored as full.
 */
function validateBackupManifest(parsed: ReturnType<typeof parseBackupJsonl>): BackupIntegrity {
  const issues: string[] = []
  const expected = new Set(activeBackupTables().map((spec) => spec.name))
  const found = new Set(parsed.tables.map((t) => t.name))
  const missingTables = [...expected].filter((name) => !found.has(name))
  const unexpectedTables = [...found].filter((name) => !BACKUP_TABLES.some((s) => s.name === name))
  if (missingTables.length > 0) issues.push(`BACKUP_INCOMPLETE_SCHEMA_COVERAGE:${missingTables.join(',')}`)
  if (unexpectedTables.length > 0) issues.push(`BACKUP_UNKNOWN_TABLES:${unexpectedTables.join(',')}`)
  if (!parsed.meta || parsed.meta.platform !== 'AACT' || parsed.meta.format !== 'aact-db-jsonl-v1') {
    issues.push('BACKUP_META_INVALID')
  }
  if (!parsed.summary || !parsed.summary.counts || !Array.isArray(parsed.summary.errors)) {
    issues.push('BACKUP_SUMMARY_MISSING')
  } else if (parsed.summary.errors.length) {
    issues.push('BACKUP_SOURCE_REPORTED_ERRORS')
  }
  const listed = Array.isArray(parsed.meta?.tables) ? parsed.meta.tables.map(String) : []
  if (listed.length !== found.size || listed.some((name) => !found.has(name))) {
    issues.push('BACKUP_TABLE_MANIFEST_MISMATCH')
  }
  for (const table of parsed.tables) {
    const actual = table.rows.length
    const summaryCount = Number(parsed.summary?.counts?.[table.name])
    if (!Number.isSafeInteger(table.expected) || table.expected < 0 ||
        table.expected !== actual || summaryCount !== actual) {
      issues.push(`BACKUP_ROW_COUNT_MISMATCH:${table.name}`)
    }
    const spec = BACKUP_TABLES.find((item) => item.name === table.name)
    if (!spec || spec.delegate !== table.delegate) issues.push(`BACKUP_DELEGATE_MISMATCH:${table.name}`)
  }
  return {
    valid: issues.length === 0,
    errors: issues,
    expectedTables: expected.size,
    includedTables: found.size,
    missingTables,
    unexpectedTables,
  }
}

function parseBackupJsonl(plain: Buffer) {
  const tables = new Map<string, ParsedBackupTable>()
  let meta: Record<string, any> | null = null
  let summary: Record<string, any> | null = null
  let parsedLines = 0
  for (const raw of plain.toString('utf8').split('\n')) {
    if (!raw.trim()) continue
    const item = JSON.parse(raw) as any
    if (!item || typeof item !== 'object') throw new Error('BACKUP_INVALID_LINE')
    parsedLines += 1
    if (summary) throw new Error('BACKUP_TRAILING_DATA_AFTER_SUMMARY')
    if (item.type === 'meta') {
      if (meta || parsedLines !== 1) throw new Error('BACKUP_DUPLICATE_OR_MISPLACED_META')
      meta = item
      continue
    }
    if (!meta) throw new Error('BACKUP_META_MISSING')
    if (item.type === 'table') {
      const name = String(item.name || '')
      if (!name || tables.has(name)) throw new Error('BACKUP_DUPLICATE_TABLE')
      tables.set(name, { name, delegate: String(item.delegate || ''), expected: Number(item.count), rows: [] })
      continue
    }
    if (item.type === 'row') {
      const table = tables.get(String(item.table))
      if (!table || !item.data || typeof item.data !== 'object' || Array.isArray(item.data)) {
        throw new Error('BACKUP_ROW_WITHOUT_VALID_TABLE')
      }
      table.rows.push(item.data)
      continue
    }
    if (item.type === 'table_error') continue // Source errors are validated via the summary.
    if (item.type === 'summary') {
      summary = item
      continue
    }
    throw new Error('BACKUP_UNKNOWN_LINE_TYPE')
  }
  if (!summary) throw new Error('BACKUP_SUMMARY_MISSING')
  return { meta, summary, tables: Array.from(tables.values()), parsedLines }
}

function restoreTableSpecsByName() {
  return new Map(BACKUP_TABLES.map((table) => [table.name, table]))
}

export async function inspectStoredDatabaseBackup(input: { provider?: string | null; key: string; mimeType?: string | null }) {
  const key = String(input.key || '').trim()
  if (!key) throw new Error('BACKUP_STORAGE_KEY_REQUIRED')
  const stored = await readStoredFile({ provider: input.provider || 's3', key, mimeType: input.mimeType || 'application/octet-stream' })
  if (!stored?.buffer) throw new Error('BACKUP_FILE_NOT_FOUND')
  const decrypted = decryptBackupPayload(stored.buffer)
  const parsed = parseBackupJsonl(decrypted.plain)
  return {
    ok: true,
    mode: 'inspect' as const,
    storage: { provider: input.provider || 's3', key, size: stored.buffer.byteLength, mimeType: stored.mimeType },
    encrypted: true,
    header: { type: decrypted.header.type, algorithm: decrypted.header.algorithm, aad: decrypted.aad },
    meta: parsed.meta,
    summary: parsed.summary,
    integrity: validateBackupManifest(parsed),
    parsedLines: parsed.parsedLines,
    tables: parsed.tables.map((table) => ({ name: table.name, delegate: table.delegate, expected: table.expected, rows: table.rows.length, mismatch: table.expected !== table.rows.length })),
    checksums: { encryptedSha256: sha256(stored.buffer), compressedSha256: sha256(decrypted.compressed), uncompressedSha256: sha256(decrypted.plain) },
  }
}

export async function restoreStoredDatabaseBackup(input: { provider?: string | null; key: string; confirm: string }) {
  if (String(input.confirm || '').trim() !== 'RESTORE') throw new Error('RESTORE_CONFIRMATION_REQUIRED')
  // Never allow a live admin request to merge partial data into the production DB.
  // Recover into a separately provisioned, empty test DB first and verify it there.
  if (process.env.AACT_RESTORE_ISOLATED_TARGET !== 'YES') {
    throw new Error('RESTORE_ISOLATED_TARGET_REQUIRED')
  }
  const key = String(input.key || '').trim()
  if (!key) throw new Error('BACKUP_STORAGE_KEY_REQUIRED')
  const stored = await readStoredFile({ provider: input.provider || 's3', key, mimeType: 'application/octet-stream' })
  if (!stored?.buffer) throw new Error('BACKUP_FILE_NOT_FOUND')
  const decrypted = decryptBackupPayload(stored.buffer)
  const parsed = parseBackupJsonl(decrypted.plain)
  const integrity = validateBackupManifest(parsed)
  if (!integrity.valid) throw new Error(`BACKUP_INTEGRITY_FAILED:${integrity.errors.join(';')}`)

  const byName = new Map(parsed.tables.map((table) => [table.name, table]))
  const ordered = BACKUP_TABLES.map((spec) => byName.get(spec.name)).filter((t): t is ParsedBackupTable => !!t)
  const results: Array<{ table: string; rows: number; processed: number }> = []
  // Atomic restore into a completely empty target. Any FK error or missing row
  // rolls the entire operation back; no skipDuplicates or partial-success audit.
  await db.$transaction(async (tx) => {
    for (const table of ordered) {
      const delegate = (tx as any)[table.delegate]
      if (!delegate?.createMany || !delegate?.count) throw new Error(`RESTORE_DELEGATE_MISSING:${table.name}`)
      const current = await delegate.count()
      if (current !== 0) throw new Error(`RESTORE_TARGET_NOT_EMPTY:${table.name}`)
    }
    for (const table of ordered) {
      const delegate = (tx as any)[table.delegate]
      let processed = 0
      for (let index = 0; index < table.rows.length; index += 300) {
        const batch = table.rows.slice(index, index + 300)
        const inserted = await delegate.createMany({ data: batch })
        processed += Number(inserted?.count || 0)
      }
      if (processed !== table.rows.length) throw new Error(`RESTORE_ROW_COUNT_MISMATCH:${table.name}`)
      results.push({ table: table.name, rows: table.rows.length, processed })
    }
  }, { maxWait: 30000, timeout: 300000 })

  await audit(null, 'DB_RESTORE_SUCCESS', 'Backup', key,
    `provider=${input.provider || 's3'} | tables=${ordered.length} | errors=0 | atomic=true`).catch(() => {})

  return {
    ok: true,
    mode: 'restore' as const,
    storage: { provider: input.provider || 's3', key, size: stored.buffer.byteLength, mimeType: stored.mimeType },
    encrypted: true,
    meta: parsed.meta,
    summary: parsed.summary,
    integrity,
    tableCount: ordered.length,
    results,
    errors: [],
  }
}

export function backupConfigurationStatus() {
  const storageConfigured = !!(
    process.env.AACT_S3_ENDPOINT?.trim() &&
    process.env.AACT_S3_BUCKET?.trim() &&
    process.env.AACT_S3_ACCESS_KEY_ID?.trim() &&
    process.env.AACT_S3_SECRET_ACCESS_KEY?.trim()
  )
  return {
    secretConfigured: !!backupSecret(),
    storageConfigured,
    encryptionConfigured: backupEncryptionSecret().length >= 32,
    localFallbackAllowed: process.env.AACT_ALLOW_LOCAL_UPLOADS === 'true',
    includeSessions: process.env.AACT_BACKUP_INCLUDE_SESSIONS === 'true',
    tableCount: activeBackupTables().length,
  }
}

export function isBackupRequestAuthorized(req: NextRequest) {
  const secret = backupSecret()
  if (!secret) return false
  const headerSecret = req.headers.get('x-aact-backup-secret') || ''
  const auth = req.headers.get('authorization') || ''
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : ''
  return fixedTimeSecretMatch(headerSecret, secret) || fixedTimeSecretMatch(bearer, secret)
}

function activeBackupTables() {
  const includeSessions = process.env.AACT_BACKUP_INCLUDE_SESSIONS === 'true'
  return BACKUP_TABLES.filter((t) => t.includeByDefault !== false || includeSessions)
}

export function backupTableNames() {
  return activeBackupTables().map((table) => table.name)
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
  if (value && typeof value === 'object' && typeof (value as any).toJSON === 'function') {
    try { return (value as any).toJSON() } catch (error) { console.warn('Failed to serialize backup value with toJSON; falling back to object traversal.', error) }
  }
  if (Array.isArray(value)) return value.map(jsonSafe)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) out[key] = jsonSafe(val)
    return out
  }
  return value
}

function line(value: unknown) {
  return `${JSON.stringify(jsonSafe(value))}\n`
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', 'Z')
}

function sha256(buffer: Buffer | string) {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function createDatabaseBackup(trigger: BackupTrigger) {
  const startedAt = Date.now()
  const exportedAt = new Date().toISOString()
  const batchSize = Number(process.env.AACT_BACKUP_BATCH_SIZE || 500)
  const safeBatchSize = Number.isFinite(batchSize) ? Math.min(2000, Math.max(50, Math.floor(batchSize))) : 500
  const tables = activeBackupTables()
  const chunks: string[] = []
  const counts: Record<string, number> = {}
  const errors: Array<{ table: string; error: string }> = []

  chunks.push(line({ type: 'meta', platform: 'AACT', format: 'aact-db-jsonl-v1', exportedAt, trigger, tables: tables.map((t) => t.name) }))

  for (const table of tables) {
    const delegate = (db as any)[table.delegate]
    if (!delegate?.findMany || !delegate?.count) {
      errors.push({ table: table.name, error: 'Delegate not available' })
      continue
    }

    try {
      const total = await delegate.count()
      counts[table.name] = total
      chunks.push(line({ type: 'table', name: table.name, delegate: table.delegate, count: total }))

      for (let skip = 0; skip < total; skip += safeBatchSize) {
        const rows = await delegate.findMany({
          orderBy: table.orderBy || { id: 'asc' },
          skip,
          take: safeBatchSize,
        })
        for (const row of rows) chunks.push(line({ type: 'row', table: table.name, data: row }))
      }
    } catch (e: any) {
      errors.push({ table: table.name, error: e?.message || String(e) })
      chunks.push(line({ type: 'table_error', name: table.name, error: e?.message || String(e) }))
    }
  }

  const summary = { type: 'summary', counts, errors, durationMs: Date.now() - startedAt }
  chunks.push(line(summary))
  const jsonl = chunks.join('')
  const plain = Buffer.from(jsonl, 'utf8')
  const gz = gzipSync(plain, { level: 9 })
  const encryptionAad = {
    platform: 'AACT',
    format: 'aact-db-jsonl-v1',
    exportedAt,
    trigger,
    compressedSha256: sha256(gz),
    uncompressedSha256: sha256(plain),
  }
  const encrypted = encryptBackupPayload(gz, encryptionAad)
  const fileName = `aact-db-backup-${stamp()}.jsonl.gz.enc`

  const stored = await storeFileBuffer({
    buffer: encrypted,
    fileName,
    mimeType: 'application/octet-stream',
    namespace: 'backups/db',
  })

  const result = {
    ok: errors.length === 0,
    fileName,
    exportedAt,
    durationMs: Date.now() - startedAt,
    tables: tables.length,
    counts,
    errors,
    encrypted: true,
    encryption: {
      algorithm: 'AES-256-GCM',
      keyEnv: 'AACT_BACKUP_ENCRYPTION_KEY',
      aad: encryptionAad,
    },
    storage: {
      provider: stored.provider,
      key: stored.key,
      size: stored.size,
      mimeType: stored.mimeType,
    },
    checksum: {
      sha256: sha256(encrypted),
      encryptedSha256: sha256(encrypted),
      compressedSha256: sha256(gz),
      uncompressedSha256: sha256(plain),
      uncompressedBytes: plain.byteLength,
      compressedBytes: gz.byteLength,
      encryptedBytes: encrypted.byteLength,
    },
  }

  await audit(
    null,
    errors.length ? 'DB_BACKUP_PARTIAL' : 'DB_BACKUP_SUCCESS',
    'Backup',
    stored.key,
    `trigger=${trigger} | provider=${stored.provider} | bytes=${stored.size} | tables=${tables.length} | errors=${errors.length}`
  ).catch(() => {})

  return result
}

export function backupErrorMessage(error: unknown) {
  return storageErrorMessage(error)
}
