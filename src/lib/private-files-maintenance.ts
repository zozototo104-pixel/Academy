import { promises as fs } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { Prisma, type PrismaClient } from '@prisma/client'
import { isPrivateStorageKey, normalizeStorageKeyForPolicy } from '@/lib/prod-safety'
import { getStorageDownloadPathForKey, readStoredFile, storeFileBufferAtKey } from '@/lib/storage'

type DbClient = PrismaClient | Prisma.TransactionClient | any
export type PrivateFilesMode = 'dry-run' | 'execute'
export type PrivateFilesSource = 'AdmissionDocument' | 'PaymentProof' | 'AssignmentSubmission' | 'ThesisSubmission' | 'ServiceDeliverable'

export type PrivateFilesCandidate = {
  source: PrivateFilesSource
  id: string
  key: string
  storageField: string
  legacyUrl?: string | null
  hasStorageKey: boolean
}

export type PrivateFilesTypeReport = {
  label: string
  records: number
  toMigrate: number
  alreadyPrivate: number
  missing: number
  localOnServer: number
  externalUrl: number
  disallowedHost: number
  tooLarge: number
  storageKeyUpdates: number
  missingIds: string[]
  disallowedHostIds: string[]
  tooLargeIds: string[]
}

export type PrivateFilesMaintenanceReport = {
  ok: true
  mode: PrivateFilesMode
  executed: boolean
  batchSize: number
  processed: number
  cursor: string | null
  nextCursor: string | null
  done: boolean
  byType: Record<PrivateFilesSource, PrivateFilesTypeReport>
  notes: string[]
}

type PrivateFileStorageDeps = {
  privateFileExists?: (key: string) => Promise<boolean>
  localLegacyExists?: (key: string) => Promise<boolean>
  readLegacyFile?: (item: PrivateFilesCandidate) => Promise<{ buffer: Buffer; mimeType: string } | null>
  storePrivateFile?: (item: PrivateFilesCandidate, file: { buffer: Buffer; mimeType: string }) => Promise<unknown>
  downloadPathForKey?: (key: string) => string
}

export type RunPrivateFilesMaintenanceBatchInput = {
  db: DbClient
  mode: PrivateFilesMode
  confirm?: string | null
  cursor?: string | null
  batchSize?: number
  actor?: { id?: string | null; name?: string | null } | null
  storage?: PrivateFileStorageDeps
  lockTtlMs?: number
  deadlineMs?: number
  maxFileBytes?: number
}

const LOCK_KEY = 'MAINTENANCE_PRIVATE_FILES_LOCK'
const LOCK_TTL_MS = 10 * 60 * 1000
const DEFAULT_MAX_PRIVATE_FILE_BYTES = 25 * 1024 * 1024
const DEFAULT_BATCH_DEADLINE_MS = 50_000
const BATCH_DEADLINE_SAFETY_MS = 5_000

export const PRIVATE_FILES_TYPE_LABELS: Record<PrivateFilesSource, string> = {
  AdmissionDocument: 'قبول',
  PaymentProof: 'دفع',
  AssignmentSubmission: 'واجبات',
  ThesisSubmission: 'بحث',
  ServiceDeliverable: 'تسليمات خدمات',
}

function emptyTypeReport(source: PrivateFilesSource): PrivateFilesTypeReport {
  return { label: PRIVATE_FILES_TYPE_LABELS[source], records: 0, toMigrate: 0, alreadyPrivate: 0, missing: 0, storageKeyUpdates: 0, missingIds: [] }
}

export function emptyPrivateFilesReport(mode: PrivateFilesMode, batchSize = 0): PrivateFilesMaintenanceReport {
  return {
    ok: true,
    mode,
    executed: mode === 'execute',
    batchSize,
    processed: 0,
    cursor: null,
    nextCursor: null,
    done: true,
    byType: Object.fromEntries((Object.keys(PRIVATE_FILES_TYPE_LABELS) as PrivateFilesSource[]).map((source) => [source, emptyTypeReport(source)])) as Record<PrivateFilesSource, PrivateFilesTypeReport>,
    notes: [],
  }
}

export function mergePrivateFilesReports(a: PrivateFilesMaintenanceReport, b: PrivateFilesMaintenanceReport): PrivateFilesMaintenanceReport {
  const merged = emptyPrivateFilesReport(b.mode, b.batchSize || a.batchSize)
  merged.executed = a.executed || b.executed
  merged.processed = a.processed + b.processed
  merged.cursor = b.cursor
  merged.nextCursor = b.nextCursor
  merged.done = b.done
  merged.notes = [...new Set([...a.notes, ...b.notes])]
  for (const source of Object.keys(PRIVATE_FILES_TYPE_LABELS) as PrivateFilesSource[]) {
    const left = a.byType[source] || emptyTypeReport(source)
    const right = b.byType[source] || emptyTypeReport(source)
    merged.byType[source] = {
      label: PRIVATE_FILES_TYPE_LABELS[source],
      records: left.records + right.records,
      toMigrate: left.toMigrate + right.toMigrate,
      alreadyPrivate: left.alreadyPrivate + right.alreadyPrivate,
      missing: left.missing + right.missing,
      storageKeyUpdates: left.storageKeyUpdates + right.storageKeyUpdates,
      missingIds: [...new Set([...left.missingIds, ...right.missingIds])],
    }
  }
  return merged
}

function addMissingId(report: PrivateFilesTypeReport, id: string) {
  if (!report.missingIds.includes(id)) report.missingIds.push(id)
}

export function legacyUrlToPrivateStorageKey(value: unknown) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw, 'https://local.invalid')
    const idx = parsed.pathname.indexOf('/uploads/')
    if (idx >= 0) return normalizeStorageKeyForPolicy(decodeURIComponent(parsed.pathname.slice(idx + '/uploads/'.length)))
  } catch {
    // Fall through to plain path handling.
  }
  const idx = raw.indexOf('/uploads/')
  if (idx >= 0) return normalizeStorageKeyForPolicy(raw.slice(idx + '/uploads/'.length))
  return ''
}

function isHttpUrl(value: unknown) {
  return /^https?:\/\//i.test(String(value || '').trim())
}

async function exists(filePath: string) {
  try { await fs.stat(filePath); return true } catch { return false }
}

function s3Configured() {
  return Boolean(process.env.AACT_S3_ENDPOINT && process.env.AACT_S3_BUCKET && process.env.AACT_S3_ACCESS_KEY_ID && process.env.AACT_S3_SECRET_ACCESS_KEY)
}

async function defaultPrivateFileExists(key: string) {
  if (s3Configured()) return Boolean(await readStoredFile({ provider: 's3', key }).catch(() => null))
  return exists(path.join(process.cwd(), '.data', 'private-uploads', key))
}

async function defaultLocalLegacyExists(key: string) {
  return exists(path.join(process.cwd(), 'public', 'uploads', key))
}

async function defaultReadLegacyFile(item: PrivateFilesCandidate) {
  if (isHttpUrl(item.legacyUrl)) return readStoredFile({ url: item.legacyUrl || '' })
  return readStoredFile({ provider: 'local', key: item.key })
}

async function defaultStorePrivateFile(item: PrivateFilesCandidate, file: { buffer: Buffer; mimeType: string }) {
  return storeFileBufferAtKey({ buffer: file.buffer, key: item.key, fileName: path.basename(item.key), mimeType: file.mimeType })
}

function cursorKey(item: PrivateFilesCandidate) {
  return `${item.source}:${item.id}:${item.storageField}`
}

function encodeCursor(value: { after: string | null; token: string }) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeCursor(value?: string | null): { after: string | null; token: string } | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || typeof parsed.token !== 'string') return null
    return { after: typeof parsed.after === 'string' ? parsed.after : null, token: parsed.token }
  } catch {
    throw new Error('INVALID_CURSOR')
  }
}

function isPrismaUniqueError(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

async function acquireLock(db: DbClient, mode: PrivateFilesMode, token: string, ttlMs: number) {
  const value = JSON.stringify({ token, mode, startedAt: new Date().toISOString() })
  try {
    await db.setting.create({ data: { key: LOCK_KEY, value } })
    return
  } catch (error) {
    if (!isPrismaUniqueError(error)) throw error
  }

  const staleBefore = new Date(Date.now() - ttlMs)
  const claimed = await db.setting.updateMany({
    where: { key: LOCK_KEY, updatedAt: { lt: staleBefore } },
    data: { value },
  })
  if (claimed.count !== 1) throw new Error('PRIVATE_FILES_MAINTENANCE_LOCKED')
}

async function verifyLock(db: DbClient, token: string) {
  const row = await db.setting.findUnique({ where: { key: LOCK_KEY }, select: { value: true } })
  if (!row?.value) throw new Error('PRIVATE_FILES_MAINTENANCE_LOCK_MISSING')
  try {
    const parsed = JSON.parse(row.value)
    if (parsed?.token !== token) throw new Error('PRIVATE_FILES_MAINTENANCE_LOCKED')
  } catch (error) {
    if (error instanceof Error && error.message === 'PRIVATE_FILES_MAINTENANCE_LOCKED') throw error
    throw new Error('PRIVATE_FILES_MAINTENANCE_LOCKED')
  }
  await db.setting.update({ where: { key: LOCK_KEY }, data: { value: row.value } }).catch(() => null)
}

async function releaseLock(db: DbClient, token: string) {
  const row = await db.setting.findUnique({ where: { key: LOCK_KEY }, select: { value: true } }).catch(() => null)
  if (!row?.value) return
  try {
    const parsed = JSON.parse(row.value)
    if (parsed?.token === token) await db.setting.delete({ where: { key: LOCK_KEY } })
  } catch {
    // Leave malformed locks to TTL recovery.
  }
}

function pushCandidate(rows: PrivateFilesCandidate[], item: PrivateFilesCandidate) {
  if (item.key && isPrivateStorageKey(item.key)) rows.push(item)
}

export async function collectPrivateFileCandidates(db: DbClient): Promise<PrivateFilesCandidate[]> {
  const rows: PrivateFilesCandidate[] = []
  const admissions = await db.admissionDocument.findMany({ select: { id: true, storageKey: true, fileUrl: true } })
  for (const row of admissions) {
    const legacyUrl = String(row.fileUrl || '').trim()
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToPrivateStorageKey(legacyUrl))
    pushCandidate(rows, { source: 'AdmissionDocument', id: row.id, key, storageField: 'storageKey', legacyUrl, hasStorageKey: Boolean(row.storageKey) })
  }
  const proofs = await db.paymentProof.findMany({ select: { id: true, storageKey: true, storageUrl: true } })
  for (const row of proofs) {
    const legacyUrl = String(row.storageUrl || '').trim()
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToPrivateStorageKey(legacyUrl))
    pushCandidate(rows, { source: 'PaymentProof', id: row.id, key, storageField: 'storageKey', legacyUrl, hasStorageKey: Boolean(row.storageKey) })
  }
  const assignments = await db.assignmentSubmission.findMany({ select: { id: true, fileStorageKey: true, fileUrl: true } })
  for (const row of assignments) {
    const legacyUrl = String(row.fileUrl || '').trim()
    const key = normalizeStorageKeyForPolicy(row.fileStorageKey || legacyUrlToPrivateStorageKey(legacyUrl))
    pushCandidate(rows, { source: 'AssignmentSubmission', id: row.id, key, storageField: 'fileStorageKey', legacyUrl, hasStorageKey: Boolean(row.fileStorageKey) })
  }
  const theses = await db.thesisSubmission.findMany({ select: { id: true, fileStorageKey: true, fileUrl: true, recordingStorageKey: true, recordingUrl: true } })
  for (const row of theses) {
    const fileUrl = String(row.fileUrl || '').trim()
    const fileKey = normalizeStorageKeyForPolicy(row.fileStorageKey || legacyUrlToPrivateStorageKey(fileUrl))
    pushCandidate(rows, { source: 'ThesisSubmission', id: row.id, key: fileKey, storageField: 'fileStorageKey', legacyUrl: fileUrl, hasStorageKey: Boolean(row.fileStorageKey) })
    const recordingUrl = String(row.recordingUrl || '').trim()
    const recordingKey = normalizeStorageKeyForPolicy(row.recordingStorageKey || legacyUrlToPrivateStorageKey(recordingUrl))
    pushCandidate(rows, { source: 'ThesisSubmission', id: row.id, key: recordingKey, storageField: 'recordingStorageKey', legacyUrl: recordingUrl, hasStorageKey: Boolean(row.recordingStorageKey) })
  }
  const deliverables = await db.serviceDeliverable.findMany({ select: { id: true, storageKey: true, fileUrl: true } })
  for (const row of deliverables) {
    const legacyUrl = String(row.fileUrl || '').trim()
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToPrivateStorageKey(legacyUrl))
    pushCandidate(rows, { source: 'ServiceDeliverable', id: row.id, key, storageField: 'storageKey', legacyUrl, hasStorageKey: Boolean(row.storageKey) })
  }
  return rows.sort((a, b) => cursorKey(a).localeCompare(cursorKey(b)))
}

async function backfillDatabase(db: DbClient, item: PrivateFilesCandidate, downloadPathForKey: (key: string) => string) {
  const protectedUrl = downloadPathForKey(item.key)
  if (item.source === 'AdmissionDocument') {
    await db.admissionDocument.update({ where: { id: item.id }, data: { storageKey: item.key, fileUrl: protectedUrl } })
  } else if (item.source === 'PaymentProof') {
    await db.paymentProof.update({ where: { id: item.id }, data: { storageKey: item.key, storageUrl: protectedUrl } })
  } else if (item.source === 'AssignmentSubmission') {
    await db.assignmentSubmission.update({ where: { id: item.id }, data: { fileStorageKey: item.key, fileUrl: protectedUrl } })
  } else if (item.source === 'ServiceDeliverable') {
    await db.serviceDeliverable.update({ where: { id: item.id }, data: { storageKey: item.key, fileUrl: protectedUrl } })
  } else if (item.source === 'ThesisSubmission' && item.storageField === 'fileStorageKey') {
    await db.thesisSubmission.update({ where: { id: item.id }, data: { fileStorageKey: item.key, fileUrl: protectedUrl } })
  } else if (item.source === 'ThesisSubmission' && item.storageField === 'recordingStorageKey') {
    await db.thesisSubmission.update({ where: { id: item.id }, data: { recordingStorageKey: item.key, recordingUrl: protectedUrl } })
  }
}

async function auditBatch(db: DbClient, actor: RunPrivateFilesMaintenanceBatchInput['actor'], report: PrivateFilesMaintenanceReport) {
  await db.auditLog.create({
    data: {
      actorId: actor?.id || null,
      actorName: actor?.name || 'النظام',
      action: 'PRIVATE_FILES_MAINTENANCE_BATCH',
      entity: 'Maintenance',
      entityId: report.nextCursor || 'done',
      details: JSON.stringify({ mode: report.mode, processed: report.processed, done: report.done, byType: report.byType, notes: report.notes }),
    },
  }).catch(() => null)
}

export async function runPrivateFilesMaintenanceBatch(input: RunPrivateFilesMaintenanceBatchInput): Promise<PrivateFilesMaintenanceReport> {
  if (input.mode !== 'dry-run' && input.mode !== 'execute') throw new Error('INVALID_MODE')
  if (input.mode === 'execute' && input.confirm !== 'نعم انقل') throw new Error('PRIVATE_FILES_CONFIRM_REQUIRED')

  const batchSize = Math.max(1, Math.min(50, Number(input.batchSize || 50)))
  const cursor = decodeCursor(input.cursor)
  const token = cursor?.token || randomUUID()
  const db = input.db
  if (cursor) await verifyLock(db, token)
  else await acquireLock(db, input.mode, token, input.lockTtlMs || LOCK_TTL_MS)

  const storage = input.storage || {}
  const privateFileExists = storage.privateFileExists || defaultPrivateFileExists
  const localLegacyExists = storage.localLegacyExists || defaultLocalLegacyExists
  const readLegacyFile = storage.readLegacyFile || defaultReadLegacyFile
  const storePrivateFile = storage.storePrivateFile || defaultStorePrivateFile
  const downloadPathForKey = storage.downloadPathForKey || getStorageDownloadPathForKey

  const report = emptyPrivateFilesReport(input.mode, batchSize)
  report.cursor = input.cursor || null

  try {
    const candidates = await collectPrivateFileCandidates(db)
    const startIndex = cursor?.after ? candidates.findIndex((item) => cursorKey(item) > cursor.after!) : 0
    const slice = candidates.slice(Math.max(0, startIndex), Math.max(0, startIndex) + batchSize)
    let lastKey: string | null = cursor?.after || null
    const notes = new Set<string>()

    for (const item of slice) {
      lastKey = cursorKey(item)
      report.processed += 1
      const type = report.byType[item.source]
      type.records += 1

      const alreadyPrivate = await privateFileExists(item.key)
      if (alreadyPrivate) {
        type.alreadyPrivate += 1
        if (!item.hasStorageKey) {
          type.storageKeyUpdates += 1
          if (input.mode === 'execute') await backfillDatabase(db, item, downloadPathForKey)
        }
        continue
      }

      const legacyOnRunner = await localLegacyExists(item.key)
      const legacyIsRemoteUrl = isHttpUrl(item.legacyUrl)
      if (!legacyOnRunner && !legacyIsRemoteUrl) {
        type.missing += 1
        addMissingId(type, item.id)
        notes.add('بعض الملفات القديمة تشير إلى public/uploads، لكن هذا المسار غير موجود على الخادم الحالي. إذا كانت محفوظة على قرص Vercel المحلي القديم فلن يستطيع النظام قراءتها مباشرة؛ يلزم نقلها إلى تخزين قابل للوصول أو توفير نسخة على الخادم.')
        continue
      }

      type.toMigrate += 1
      if (!item.hasStorageKey) type.storageKeyUpdates += 1
      if (input.mode !== 'execute') continue

      const legacy = await readLegacyFile(item)
      if (!legacy?.buffer?.byteLength) {
        type.toMigrate -= 1
        if (!item.hasStorageKey) type.storageKeyUpdates -= 1
        type.missing += 1
        addMissingId(type, item.id)
        continue
      }
      await storePrivateFile(item, legacy)
      await backfillDatabase(db, item, downloadPathForKey)
    }

    report.done = slice.length < batchSize || (lastKey ? candidates.every((item) => cursorKey(item) <= lastKey!) : candidates.length === 0)
    report.nextCursor = report.done ? null : encodeCursor({ after: lastKey, token })
    report.notes = [...notes]
    await auditBatch(db, input.actor, report)
    if (report.done) await releaseLock(db, token)
    return report
  } catch (error) {
    await auditBatch(db, input.actor, { ...report, ok: true, done: false, notes: [...report.notes, `ERROR:${String((error as Error)?.message || error).slice(0, 80)}`] })
    throw error
  }
}
