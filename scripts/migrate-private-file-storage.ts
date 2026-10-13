import { promises as fs } from 'fs'
import path from 'path'
import { PrismaClient } from '@prisma/client'
import { isPrivateStorageKey, normalizeStorageKeyForPolicy } from '../src/lib/prod-safety'

const prisma = new PrismaClient()
const execute = process.argv.includes('--execute')

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

async function collectCandidates() {
  const rows: Array<{ source: string; id: string; key: string }> = []
  const admissions = await prisma.admissionDocument.findMany({ select: { id: true, storageKey: true, fileUrl: true } })
  for (const row of admissions) {
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToKey(row.fileUrl))
    if (key && isPrivateStorageKey(key)) rows.push({ source: 'AdmissionDocument', id: row.id, key })
  }
  const proofs = await prisma.paymentProof.findMany({ select: { id: true, storageKey: true, storageUrl: true } })
  for (const row of proofs) {
    const key = normalizeStorageKeyForPolicy(row.storageKey || legacyUrlToKey(row.storageUrl))
    if (key && isPrivateStorageKey(key)) rows.push({ source: 'PaymentProof', id: row.id, key })
  }
  const assignments = await prisma.assignmentSubmission.findMany({ select: { id: true, fileStorageKey: true, fileUrl: true } })
  for (const row of assignments) {
    const key = normalizeStorageKeyForPolicy(row.fileStorageKey || legacyUrlToKey(row.fileUrl))
    if (key && isPrivateStorageKey(key)) rows.push({ source: 'AssignmentSubmission', id: row.id, key })
  }
  const theses = await prisma.thesisSubmission.findMany({ select: { id: true, fileStorageKey: true, fileUrl: true, recordingStorageKey: true, recordingUrl: true } })
  for (const row of theses) {
    for (const key of [normalizeStorageKeyForPolicy(row.fileStorageKey || legacyUrlToKey(row.fileUrl)), normalizeStorageKeyForPolicy(row.recordingStorageKey || legacyUrlToKey(row.recordingUrl))]) {
      if (key && isPrivateStorageKey(key)) rows.push({ source: 'ThesisSubmission', id: row.id, key })
    }
  }
  return rows
}

async function main() {
  const legacyRoot = path.join(process.cwd(), 'public', 'uploads')
  const privateRoot = path.join(process.cwd(), '.data', 'private-uploads')
  const candidates = await collectCandidates()
  const results: Array<{ source: string; id: string; key: string; action: string }> = []
  for (const item of candidates) {
    const legacyPath = path.join(legacyRoot, item.key)
    const privatePath = path.join(privateRoot, item.key)
    const legacyExists = await exists(legacyPath)
    const privateExists = await exists(privatePath)
    if (!legacyExists) {
      results.push({ ...item, action: 'missing-legacy' })
      continue
    }
    if (privateExists) {
      results.push({ ...item, action: 'already-private' })
      continue
    }
    results.push({ ...item, action: execute ? 'copied' : 'would-copy' })
    if (execute) {
      await fs.mkdir(path.dirname(privatePath), { recursive: true })
      await fs.copyFile(legacyPath, privatePath)
    }
  }
  console.log(JSON.stringify({ ok: true, executed: execute, checked: candidates.length, results }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => prisma.$disconnect())
