import { db } from '@/lib/db'
import { randomUUID } from 'node:crypto'
import { planKnowledgeItemCleanup, validateGroundedKnowledgeRepair, looksLikeBrokenGeneratedArabic } from '@/lib/academic-output-quality'
import { textAiCompleteJson } from '@/lib/text-ai'

/** Preserve the existing program/semester scope. Never invokes the legacy v1 builder. */
export async function scheduleProgramKnowledgeV2(programId: string, semester?: number | null) {
  const books = await db.book.findMany({
    where: { programId, ...(semester ? { OR: [{ semester: null }, { semester }] } : {}) },
    orderBy: { createdAt: 'asc' }, select: { id: true, title: true },
  })
  if (!books.length) throw new Error('لا توجد كتب مقررة لبناء بنك المعرفة')
  const results: { bookId: string; title: string; state: 'READING' | 'ENRICHING' | 'COMPLETED' | 'PAUSED'; jobId?: string; retryAt?: Date | null }[] = []
  for (const book of books) {
    const active = await db.bookReadJob.findFirst({ where: { bookId: book.id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
    if (active) {
      results.push({ bookId: book.id, title: book.title, state: active.status === 'PAUSED' ? 'PAUSED' : active.phase === 'ENRICH' ? 'ENRICHING' : 'READING', jobId: active.id, retryAt: active.retryAt })
      continue
    }
    const chunks = await db.bookChunk.count({ where: { bookId: book.id } })
    const pending = await db.bookChunk.count({ where: { bookId: book.id, status: { in: ['PENDING', 'EXTRACTED', 'FAILED'] } } })
    const remaining = await db.bookChunk.count({ where: { bookId: book.id, status: 'ANALYZED', saturatedAt: null, analysisPasses: { lt: 3 } } })
    // Fully analyzed books with no accepted v2 knowledge still qualify for enrichment.
    const mode = !chunks || pending ? 'EXTRACT' : remaining ? 'ENRICH' : null
    if (!mode) { results.push({ bookId: book.id, title: book.title, state: 'COMPLETED' }); continue }
    let job
    try {
      job = await db.bookReadJob.create({ data: { bookId: book.id, programId, phase: mode, status: 'QUEUED' } })
    } catch (error: any) {
      if (error?.code !== 'P2002' && error?.code !== '23505') throw error
      job = await db.bookReadJob.findFirst({ where: { bookId: book.id, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } }, orderBy: { createdAt: 'desc' } })
      if (!job) throw error
    }
    results.push({ bookId: book.id, title: book.title, state: job.status === 'PAUSED' ? 'PAUSED' : job.phase === 'ENRICH' ? 'ENRICHING' : 'READING', jobId: job.id, retryAt: job.retryAt })
  }
  return { programId, results }
}

// Knowledge repair uses its own persisted cursor/lease and never writes a
// BookReadJob or changes the reading/enrichment pipeline above.
const REPAIR_PREFIX = 'KNOWLEDGE_AI_REPAIR_JOB:'
const REPAIR_RATE_GATE = 'KNOWLEDGE_AI_REPAIR_NEXT_CALL'
const REPAIR_INTERVAL_MS = 90_000 // globally at most one background call/90s
const REPAIR_LEASE_MS = 110_000

export type KnowledgeAiRepairJob = {
  programId: string
  status: 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED'
  cursor: string
  scanned: number
  repaired: number
  needsReview: number
  missingSource: number
  attempts: number
  lastError: string | null
  leaseToken: string | null
  leaseUntil: number | null
}
function parseRepair(value: string): KnowledgeAiRepairJob | null {
  try {
    const data = JSON.parse(value)
    return data && typeof data.programId === 'string' && ['QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED'].includes(data.status)
      ? data as KnowledgeAiRepairJob : null
  } catch { return null }
}
function newRepair(programId: string): KnowledgeAiRepairJob {
  return { programId, status: 'QUEUED', cursor: '', scanned: 0, repaired: 0,
    needsReview: 0, missingSource: 0, attempts: 0, lastError: null, leaseToken: null, leaseUntil: null }
}
export async function getKnowledgeAiRepairJob(programId: string) {
  const row = await db.setting.findUnique({ where: { key: REPAIR_PREFIX + programId }, select: { value: true } })
  return row ? parseRepair(row.value) : null
}
export async function enqueueKnowledgeAiRepairJob(programId: string) {
  const key = REPAIR_PREFIX + programId
  const row = await db.setting.findUnique({ where: { key }, select: { value: true } })
  const old = row ? parseRepair(row.value) : null
  if (old && ['RUNNING', 'QUEUED'].includes(old.status)) return old
  const next = newRepair(programId)
  if (old?.status === 'PAUSED') Object.assign(next, {
    cursor: old.cursor, scanned: old.scanned, repaired: old.repaired,
    needsReview: old.needsReview, missingSource: old.missingSource, attempts: old.attempts,
  })
  if (row) {
    const saved = await db.setting.updateMany({ where: { key, value: row.value }, data: { value: JSON.stringify(next) } })
    return saved.count ? next : (await getKnowledgeAiRepairJob(programId)) || next
  }
  try { await db.setting.create({ data: { key, value: JSON.stringify(next) } }) }
  catch (error: any) { if (error?.code !== 'P2002') throw error }
  return (await getKnowledgeAiRepairJob(programId)) || next
}

// A large chunk is not silently truncated to an unrelated first page.
// Without a meaningful original quote to locate the source, review manually.
function repairSourceWindow(text: string, previousExcerpt: string | null) {
  const source = String(text || '').trim()
  if (source.length < 180) return null
  let evidence = source
  if (source.length > 4800) {
    const anchor = String(previousExcerpt || '').trim()
    if (anchor.length < 40) return null
    const index = source.indexOf(anchor.slice(0, 100))
    if (index < 0) return null
    const from = Math.max(0, index - 1800)
    evidence = source.slice(from, from + 4800)
  }
  if (looksLikeBrokenGeneratedArabic(evidence)) return null
  return evidence
}
