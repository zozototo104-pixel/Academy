import { promises as fs } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { isPrivateStorageKey, normalizeStorageKeyForPolicy } from '../src/lib/prod-safety'
import { getStorageDownloadPathForKey, readStoredFile, storeFileBufferAtKey } from '../src/lib/storage'

const prisma = new PrismaClient()

type Mode = 'dry-run' | 'execute'
type Source = 'AdmissionDocument' | 'PaymentProof' | 'AssignmentSubmission' | 'ThesisSubmission' | 'ServiceDeliverable'

type Candidate = {
  source: Source
  id: string
  key: string
  storageField: string
  legacyUrl?: string | null
  hasStorageKey: boolean
}

type TypeReport = {
  label: string
  records: number
  toMigrate: number
  alreadyPrivate: number
  missing: number
  storageKeyUpdates: number
  missingIds: string[]
}

const TYPE_LABELS: Record<Source, string> = {
  AdmissionDocument: 'قبول',
  PaymentProof: 'دفع',
  AssignmentSubmission: 'واجبات',
  ThesisSubmission: 'بحث',
  ServiceDeliverable: 'تسليمات خدمات',
}

function argValue(name: string) {
  const prefix = `--${name}=`
  const inline = process.argv.find((arg) => arg.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] || '' : ''
}

function selectedMode(): Mode {
  if (process.argv.includes('--execute')) return 'execute'
  const raw = argValue('mode')
  return raw === 'execute' ? 'execute' : 'dry-run'
}

const runMode = selectedMode()
const execute = runMode === 'execute'
const reportPath = argValue('report') || 'private-files-migration-report.json'
const summaryPath = argValue('summary') || 'private-files-migration-summary.md'

function legacyUrlToKey(value: unknown) {
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

function s3Configured() {
  return Boolean(process.env.AACT_S3_ENDPOINT && process.env.AACT_S3_BUCKET && process.env.AACT_S3_ACCESS_KEY_ID && process.env.AACT_S3_SECRET_ACCESS_KEY)
}

async function exists(filePath: string) {
  try { await fs.stat(filePath); return true } catch { return false }
}

async function privateFileExists(key: string) {
  if (s3Configured()) return Boolean(await readStoredFile({ provider: 's3', key }).catch(() => null))
  return exists(path.join(process.cwd(), '.data', 'private-uploads', key))
}

async function backfillDatabase(item: Candidate) {
  const protectedUrl = getStorageDownloadPathForKey(item.key)
  if (item.source === 'AdmissionDocument') {
    await prisma.admissionDocument.update({ where: { id: item.id }, data: { storageKey: item.key, fileUrl: protectedUrl } })
  } else if (item.source === 'PaymentProof') {
    await prisma.paymentProof.update({ where: { id: item.id }, data: { storageKey: item.key, storageUrl: protectedUrl } })
  } else if (item.source === 'AssignmentSubmission') {
    await prisma.assignmentSubmission.update({ where: { id: item.id }, data: { fileStorageKey: item.key, fileUrl: protectedUrl } })
  } else if (item.source === 'ServiceDeliverable') {
    await prisma.serviceDeliverable.update({ where: { id: item.id }, data: { storageKey: item.key, fileUrl: protectedUrl } })
  } else if (item.source === 'ThesisSubmission' && item.storageField === 'fileStorageKey') {
    await prisma.thesisSubmission.update({ where: { id: item.id }, data: { fileStorageKey: item.key, fileUrl: protectedUrl } })
  } else if (item.source === 'ThesisSubmission' && item.storageField === 'recordingStorageKey') {
    await prisma.thesisSubmission.update({ where: { id: item.id }, data: { recordingStorageKey: item.key, recordingUrl: protectedUrl } })
  }
}

function pushCandidate(rows: Candidate[], item: Candidate) {
  if (item.key && isPrivateStorageKey(item.key)) rows.push(item)
}

async function collectCandidates() {
  const rows: Candidate[] = []
  const admissions = await prisma.admissionDocument.findMany({ select: { id: true, storageKey: true, fileUrl: true } })
  for (const row of admissions) {
    const legacyUrl = String(row.fileUrl || '').trim()
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToKey(legacyUrl))
    pushCandidate(rows, { source: 'AdmissionDocument', id: row.id, key, storageField: 'storageKey', legacyUrl, hasStorageKey: Boolean(row.storageKey) })
  }
  const proofs = await prisma.paymentProof.findMany({ select: { id: true, storageKey: true, storageUrl: true } })
  for (const row of proofs) {
    const legacyUrl = String(row.storageUrl || '').trim()
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToKey(legacyUrl))
    pushCandidate(rows, { source: 'PaymentProof', id: row.id, key, storageField: 'storageKey', legacyUrl, hasStorageKey: Boolean(row.storageKey) })
  }
  const assignments = await prisma.assignmentSubmission.findMany({ select: { id: true, fileStorageKey: true, fileUrl: true } })
  for (const row of assignments) {
    const legacyUrl = String(row.fileUrl || '').trim()
    const key = normalizeStorageKeyForPolicy(row.fileStorageKey || legacyUrlToKey(legacyUrl))
    pushCandidate(rows, { source: 'AssignmentSubmission', id: row.id, key, storageField: 'fileStorageKey', legacyUrl, hasStorageKey: Boolean(row.fileStorageKey) })
  }
  const theses = await prisma.thesisSubmission.findMany({ select: { id: true, fileStorageKey: true, fileUrl: true, recordingStorageKey: true, recordingUrl: true } })
  for (const row of theses) {
    const fileUrl = String(row.fileUrl || '').trim()
    const fileKey = normalizeStorageKeyForPolicy(row.fileStorageKey || legacyUrlToKey(fileUrl))
    pushCandidate(rows, { source: 'ThesisSubmission', id: row.id, key: fileKey, storageField: 'fileStorageKey', legacyUrl: fileUrl, hasStorageKey: Boolean(row.fileStorageKey) })
    const recordingUrl = String(row.recordingUrl || '').trim()
    const recordingKey = normalizeStorageKeyForPolicy(row.recordingStorageKey || legacyUrlToKey(recordingUrl))
    pushCandidate(rows, { source: 'ThesisSubmission', id: row.id, key: recordingKey, storageField: 'recordingStorageKey', legacyUrl: recordingUrl, hasStorageKey: Boolean(row.recordingStorageKey) })
  }
  const deliverables = await prisma.serviceDeliverable.findMany({ select: { id: true, storageKey: true, fileUrl: true } })
  for (const row of deliverables) {
    const legacyUrl = String(row.fileUrl || '').trim()
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToKey(legacyUrl))
    pushCandidate(rows, { source: 'ServiceDeliverable', id: row.id, key, storageField: 'storageKey', legacyUrl, hasStorageKey: Boolean(row.storageKey) })
  }
  return rows
}

function emptyTypeReport(source: Source): TypeReport {
  return { label: TYPE_LABELS[source], records: 0, toMigrate: 0, alreadyPrivate: 0, missing: 0, storageKeyUpdates: 0, missingIds: [] }
}

function addMissingId(report: TypeReport, id: string) {
  if (!report.missingIds.includes(id)) report.missingIds.push(id)
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeSummary(filePath: string, report: any) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true })
  const rows = Object.entries(report.byType).map(([source, item]: [string, any]) => `| ${item.label} | ${item.records} | ${item.toMigrate} | ${item.alreadyPrivate} | ${item.missing} | ${item.storageKeyUpdates} | ${item.missingIds.join(', ') || '—'} |`)
  const notes = report.notes.length ? report.notes.map((note: string) => `- ${note}`).join('\n') : '- لا توجد ملاحظات.'
  const text = [
    '# Private files migration report',
    '',
    `Mode: **${report.mode}**`,
    `Executed: **${report.executed ? 'yes' : 'no'}**`,
    '',
    '| النوع | السجلات | سينقل/نُقل | موجود أصلاً | مفقود | تحديث storageKey | IDs المفقودة |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- |',
    ...rows,
    '',
    '## ملاحظات',
    notes,
    '',
  ].join('\n')
  await fs.writeFile(filePath, text, 'utf8')
}

async function readLegacyFile(item: Candidate) {
  if (isHttpUrl(item.legacyUrl)) return readStoredFile({ url: item.legacyUrl || '' })
  return readStoredFile({ provider: 'local', key: item.key })
}

async function main() {
  if (execute && !s3Configured()) throw new Error('S3_STORAGE_SECRETS_REQUIRED_FOR_EXECUTE')

  const legacyRoot = path.join(process.cwd(), 'public', 'uploads')
  const candidates = await collectCandidates()
  const byType = Object.fromEntries((Object.keys(TYPE_LABELS) as Source[]).map((source) => [source, emptyTypeReport(source)])) as Record<Source, TypeReport>
  const notes = new Set<string>()

  for (const item of candidates) {
    const type = byType[item.source]
    type.records += 1

    const alreadyPrivate = await privateFileExists(item.key)
    if (alreadyPrivate) {
      type.alreadyPrivate += 1
      if (!item.hasStorageKey) {
        type.storageKeyUpdates += 1
        if (execute) await backfillDatabase(item)
      }
      continue
    }

    const legacyPath = path.join(legacyRoot, item.key)
    const legacyOnRunner = await exists(legacyPath)
    const legacyIsRemoteUrl = isHttpUrl(item.legacyUrl)
    if (!legacyOnRunner && !legacyIsRemoteUrl) {
      type.missing += 1
      addMissingId(type, item.id)
      notes.add('بعض الملفات القديمة تشير إلى public/uploads، لكن هذا المسار غير موجود على GitHub runner. إذا كانت الملفات محفوظة على قرص Vercel المحلي القديم فلن يستطيع هذا workflow قراءتها مباشرة؛ يلزم نقلها إلى تخزين قابل للوصول أو توفير نسخة في runner.')
      continue
    }

    type.toMigrate += 1
    if (!item.hasStorageKey) type.storageKeyUpdates += 1
    if (!execute) continue

    const legacy = await readLegacyFile(item)
    if (!legacy?.buffer?.byteLength) {
      type.toMigrate -= 1
      if (!item.hasStorageKey) type.storageKeyUpdates -= 1
      type.missing += 1
      addMissingId(type, item.id)
      continue
    }
    await storeFileBufferAtKey({ buffer: legacy.buffer, key: item.key, fileName: path.basename(item.key), mimeType: legacy.mimeType })
    if (!item.hasStorageKey) await backfillDatabase(item)
  }

  const report = {
    ok: true,
    mode: runMode,
    executed: execute,
    generatedAt: new Date().toISOString(),
    byType,
    notes: [...notes],
  }
  await writeJson(reportPath, report)
  await writeSummary(summaryPath, report)
  console.log(JSON.stringify({ ok: true, mode: runMode, reportPath, summaryPath, byType, notes: [...notes] }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => prisma.$disconnect())
