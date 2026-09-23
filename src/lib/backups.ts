import { createHash } from 'crypto'
import { gzipSync } from 'zlib'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { audit } from '@/lib/notify'
import { storeFileBuffer, storageErrorMessage } from '@/lib/storage'

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
  return headerSecret === secret || bearer === secret
}

function activeBackupTables() {
  const includeSessions = process.env.AACT_BACKUP_INCLUDE_SESSIONS === 'true'
  return BACKUP_TABLES.filter((t) => t.includeByDefault !== false || includeSessions)
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return value.toISOString()
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
  const fileName = `aact-db-backup-${stamp()}.jsonl.gz`

  const stored = await storeFileBuffer({
    buffer: gz,
    fileName,
    mimeType: 'application/gzip',
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
    storage: {
      provider: stored.provider,
      key: stored.key,
      url: stored.url,
      size: stored.size,
      mimeType: stored.mimeType,
    },
    checksum: {
      sha256: sha256(gz),
      uncompressedSha256: sha256(plain),
      uncompressedBytes: plain.byteLength,
      compressedBytes: gz.byteLength,
    },
  }

  await audit({
    action: errors.length ? 'DB_BACKUP_PARTIAL' : 'DB_BACKUP_SUCCESS',
    entity: 'Backup',
    entityId: stored.key,
    details: `trigger=${trigger} | provider=${stored.provider} | bytes=${stored.size} | tables=${tables.length} | errors=${errors.length}`,
  }).catch(() => {})

  return result
}

export function backupErrorMessage(error: unknown) {
  return storageErrorMessage(error)
}
