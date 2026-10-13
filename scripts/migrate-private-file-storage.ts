import { promises as fs } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { isPrivateStorageKey, normalizeStorageKeyForPolicy } from '../src/lib/prod-safety'
import { getStorageDownloadPathForKey } from '../src/lib/storage'

const prisma = new PrismaClient()
const execute = process.argv.includes('--execute')

type Candidate = {
  source: 'AdmissionDocument' | 'PaymentProof' | 'AssignmentSubmission' | 'ThesisSubmission' | 'ServiceDeliverable'
  id: string
  key: string
  storageField: string
  urlField?: string
  hasStorageKey: boolean
}

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

async function exists(filePath: string) {
  try { await fs.stat(filePath); return true } catch { return false }
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
    const hasStorageKey = Boolean(row.storageKey)
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToKey(row.fileUrl))
    pushCandidate(rows, { source: 'AdmissionDocument', id: row.id, key, storageField: 'storageKey', urlField: 'fileUrl', hasStorageKey })
  }
  const proofs = await prisma.paymentProof.findMany({ select: { id: true, storageKey: true, storageUrl: true } })
  for (const row of proofs) {
    const hasStorageKey = Boolean(row.storageKey)
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToKey(row.storageUrl))
    pushCandidate(rows, { source: 'PaymentProof', id: row.id, key, storageField: 'storageKey', urlField: 'storageUrl', hasStorageKey })
  }
  const assignments = await prisma.assignmentSubmission.findMany({ select: { id: true, fileStorageKey: true, fileUrl: true } })
  for (const row of assignments) {
    const hasStorageKey = Boolean(row.fileStorageKey)
    const key = normalizeStorageKeyForPolicy(row.fileStorageKey || legacyUrlToKey(row.fileUrl))
    pushCandidate(rows, { source: 'AssignmentSubmission', id: row.id, key, storageField: 'fileStorageKey', urlField: 'fileUrl', hasStorageKey })
  }
  const theses = await prisma.thesisSubmission.findMany({ select: { id: true, fileStorageKey: true, fileUrl: true, recordingStorageKey: true, recordingUrl: true } })
  for (const row of theses) {
    const fileKey = normalizeStorageKeyForPolicy(row.fileStorageKey || legacyUrlToKey(row.fileUrl))
    pushCandidate(rows, { source: 'ThesisSubmission', id: row.id, key: fileKey, storageField: 'fileStorageKey', urlField: 'fileUrl', hasStorageKey: Boolean(row.fileStorageKey) })
    const recordingKey = normalizeStorageKeyForPolicy(row.recordingStorageKey || legacyUrlToKey(row.recordingUrl))
    pushCandidate(rows, { source: 'ThesisSubmission', id: row.id, key: recordingKey, storageField: 'recordingStorageKey', urlField: 'recordingUrl', hasStorageKey: Boolean(row.recordingStorageKey) })
  }
  const deliverables = await prisma.serviceDeliverable.findMany({ select: { id: true, storageKey: true, fileUrl: true } })
  for (const row of deliverables) {
    const hasStorageKey = Boolean(row.storageKey)
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToKey(row.fileUrl))
    pushCandidate(rows, { source: 'ServiceDeliverable', id: row.id, key, storageField: 'storageKey', urlField: 'fileUrl', hasStorageKey })
  }
  return rows
}

async function main() {
  const legacyRoot = path.join(process.cwd(), 'public', 'uploads')
  const privateRoot = path.join(process.cwd(), '.data', 'private-uploads')
  const candidates = await collectCandidates()
  const results: Array<{ source: string; id: string; key: string; action: string; backfill: string }> = []
  for (const item of candidates) {
    const legacyPath = path.join(legacyRoot, item.key)
    const privatePath = path.join(privateRoot, item.key)
    const legacyExists = await exists(legacyPath)
    const privateExists = await exists(privatePath)
    if (!legacyExists && !privateExists) {
      results.push({ ...item, action: 'missing-legacy', backfill: item.hasStorageKey ? 'already-has-storage-key' : 'skipped-missing-file' })
      continue
    }
    const action = privateExists ? 'already-private' : execute ? 'copied' : 'would-copy'
    const backfill = item.hasStorageKey ? 'already-has-storage-key' : execute ? 'storage-key-updated' : 'would-update-storage-key'
    results.push({ ...item, action, backfill })
    if (execute) {
      if (!privateExists) {
        await fs.mkdir(path.dirname(privatePath), { recursive: true })
        await fs.copyFile(legacyPath, privatePath)
      }
      if (!item.hasStorageKey) await backfillDatabase(item)
    }
  }
  console.log(JSON.stringify({ ok: true, executed: execute, checked: candidates.length, results }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => prisma.$disconnect())
