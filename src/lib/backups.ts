import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'crypto'
import { gunzipSync, gzipSync } from 'zlib'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/notify'
import { readStoredFile, storeFileBuffer, storageErrorMessage } from '@/lib/storage'

export type BackupTrigger = 'manual-admin' | 'cron' | 'api-secret'

interface BackupTableSpec {
  name: string
  delegate: string
  includeByDefault?: boolean
  orderBy?: Record<string, 'asc' | 'desc'>
}

const BACKUP_TABLES: BackupTableSpec[] = [
  { name: 'User', delegate: 'user' },
  { name: 'Session', delegate: 'session', includeByDefault: false },
  { name: 'AiLiveUsage', delegate: 'aiLiveUsage' },
  { name: 'AiLiveCredit', delegate: 'aiLiveCredit' },
  { name: 'Program', delegate: 'program' },
  { name: 'Unit', delegate: 'unit' },
  { name: 'Enrollment', delegate: 'enrollment' },
  { name: 'Exam', delegate: 'exam' },
  { name: 'Question', delegate: 'question' },
  { name: 'ExamAttempt', delegate: 'examAttempt' },
  { name: 'ExamDraft', delegate: 'examDraft' },
  { name: 'Answer', delegate: 'answer' },
  { name: 'ChatMessage', delegate: 'chatMessage' },
  { name: 'ChatFeedback', delegate: 'chatFeedback' },
  { name: 'StudentAcademicMemory', delegate: 'studentAcademicMemory' },
  { name: 'Payment', delegate: 'payment' },
  { name: 'Certificate', delegate: 'certificate' },
  { name: 'MicroCredential', delegate: 'microCredential' },
  { name: 'UserMicroCredential', delegate: 'userMicroCredential' },
  { name: 'Notification', delegate: 'notification' },
  { name: 'AuditLog', delegate: 'auditLog' },
  { name: 'Setting', delegate: 'setting', orderBy: { key: 'asc' } },
  { name: 'EmailLog', delegate: 'emailLog' },
  { name: 'ContactMessage', delegate: 'contactMessage' },
  { name: 'ThesisSubmission', delegate: 'thesisSubmission' },
  { name: 'ThesisReviewNote', delegate: 'thesisReviewNote' },
  { name: 'ThesisTopic', delegate: 'thesisTopic' },
  { name: 'ThesisTopicRequest', delegate: 'thesisTopicRequest' },
  { name: 'DefenseMessage', delegate: 'defenseMessage' },
  { name: 'AgentApplication', delegate: 'agentApplication' },
  { name: 'AgentDocument', delegate: 'agentDocument' },
  { name: 'AcademyRepresentative', delegate: 'academyRepresentative' },
  { name: 'AcademyRepresentativeFile', delegate: 'academyRepresentativeFile' },
  { name: 'RevenueShareTransaction', delegate: 'revenueShareTransaction' },
  { name: 'AdmissionApplication', delegate: 'admissionApplication' },
  { name: 'TuitionInstallmentAppeal', delegate: 'tuitionInstallmentAppeal' },
  { name: 'SupervisorChannelMessage', delegate: 'supervisorChannelMessage' },
  { name: 'SupervisorVoiceCall', delegate: 'supervisorVoiceCall' },
  { name: 'SupervisorVoiceSignal', delegate: 'supervisorVoiceSignal' },
  { name: 'SupervisorAssessment', delegate: 'supervisorAssessment' },
  { name: 'SupervisorAssessmentQuestion', delegate: 'supervisorAssessmentQuestion' },
  { name: 'SupervisorAssessmentAttempt', delegate: 'supervisorAssessmentAttempt' },
  { name: 'SupervisorAssessmentAnswer', delegate: 'supervisorAssessmentAnswer' },
  { name: 'Book', delegate: 'book' },
  { name: 'BookUploadChunk', delegate: 'bookUploadChunk' },
  { name: 'BookKnowledgeItem', delegate: 'bookKnowledgeItem' },
  { name: 'QuestionBankItem', delegate: 'questionBankItem' },
  { name: 'ProgramStudyGuide', delegate: 'programStudyGuide' },
  { name: 'ProgramAssignment', delegate: 'programAssignment' },
  { name: 'AssignmentSubmission', delegate: 'assignmentSubmission' },
  { name: 'ProgramExam', delegate: 'programExam' },
  { name: 'ProgramQuestion', delegate: 'programQuestion' },
  { name: 'ProgramExamAttempt', delegate: 'programExamAttempt' },
  { name: 'ProgramAnswer', delegate: 'programAnswer' },
  { name: 'DefenseParticipant', delegate: 'defenseParticipant' },
  { name: 'DefenseSignal', delegate: 'defenseSignal' },
  { name: 'AdmissionDocument', delegate: 'admissionDocument' },
  { name: 'ServiceDeliverable', delegate: 'serviceDeliverable' },
]

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

function parseBackupJsonl(plain: Buffer) {
  const tables = new Map<string, ParsedBackupTable>()
  let meta: Record<string, unknown> | null = null
  let summary: Record<string, unknown> | null = null
  let parsedLines = 0
  for (const raw of plain.toString('utf8').split('\n')) {
    if (!raw.trim()) continue
    const item = JSON.parse(raw) as any
    parsedLines += 1
    if (item.type === 'meta') {
      meta = item
      continue
    }
    if (item.type === 'table') {
      tables.set(String(item.name), { name: String(item.name), delegate: String(item.delegate), expected: Number(item.count || 0), rows: [] })
      continue
    }
    if (item.type === 'row') {
      const table = tables.get(String(item.table))
      if (table) table.rows.push(item.data || {})
      continue
    }
    if (item.type === 'summary') summary = item
  }
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
    parsedLines: parsed.parsedLines,
    tables: parsed.tables.map((table) => ({ name: table.name, delegate: table.delegate, expected: table.expected, rows: table.rows.length, mismatch: table.expected !== table.rows.length })),
    checksums: { encryptedSha256: sha256(stored.buffer), compressedSha256: sha256(decrypted.compressed), uncompressedSha256: sha256(decrypted.plain) },
  }
}

export async function restoreStoredDatabaseBackup(input: { provider?: string | null; key: string; confirm: string }) {
  if (String(input.confirm || '').trim() !== 'RESTORE') throw new Error('RESTORE_CONFIRMATION_REQUIRED')
  const key = String(input.key || '').trim()
  if (!key) throw new Error('BACKUP_STORAGE_KEY_REQUIRED')
  const stored = await readStoredFile({ provider: input.provider || 's3', key, mimeType: 'application/octet-stream' })
  if (!stored?.buffer) throw new Error('BACKUP_FILE_NOT_FOUND')
  const decrypted = decryptBackupPayload(stored.buffer)
  const parsed = parseBackupJsonl(decrypted.plain)
  const specs = restoreTableSpecsByName()
  const results: Array<{ table: string; rows: number; processed: number; skipped?: boolean; error?: string }> = []

  for (const table of parsed.tables) {
    const spec = specs.get(table.name)
    if (!spec || spec.delegate !== table.delegate) {
      results.push({ table: table.name, rows: table.rows.length, processed: 0, skipped: true, error: 'Unknown or mismatched table delegate' })
      continue
    }
    const delegate = (db as any)[spec.delegate]
    if (!delegate?.createMany) {
      results.push({ table: table.name, rows: table.rows.length, processed: 0, skipped: true, error: 'Delegate does not support createMany' })
      continue
    }
    if (!table.rows.length) {
      results.push({ table: table.name, rows: 0, processed: 0 })
      continue
    }
    try {
      const created = await delegate.createMany({ data: table.rows, skipDuplicates: true })
      results.push({ table: table.name, rows: table.rows.length, processed: Number(created?.count || 0) })
    } catch (e: any) {
      results.push({ table: table.name, rows: table.rows.length, processed: 0, error: e?.message || String(e) })
    }
  }

  const errors = results.filter((result) => result.error)
  await audit(
    null,
    errors.length ? 'DB_RESTORE_PARTIAL' : 'DB_RESTORE_SUCCESS',
    'Backup',
    key,
    `provider=${input.provider || 's3'} | tables=${parsed.tables.length} | errors=${errors.length}`
  ).catch(() => {})

  return {
    ok: errors.length === 0,
    mode: 'restore' as const,
    storage: { provider: input.provider || 's3', key, size: stored.buffer.byteLength, mimeType: stored.mimeType },
    encrypted: true,
    meta: parsed.meta,
    summary: parsed.summary,
    tableCount: parsed.tables.length,
    results,
    errors,
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
