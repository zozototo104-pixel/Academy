import { db } from '@/lib/db'
import { getFileBufferFromStorageOrBase64 } from '@/lib/storage'
import {
  loadUnitRegenerationSources,
  markUnitRegenerationJobFailed,
  runUnitRegeneration,
  type UnitRegenerationSources,
} from '@/lib/unit-regeneration'

// Repair-first async link (PR #212): a damaged unit whose sources are
// garbled does NOT generate and is NOT refused while a book repair can
// still fix its sources. The regenerate request defers (HTTP 202) with a
// UnitRegenerationIntent, and the repair driver (SCAN route hook) / cron
// backstop resumes generation automatically when the repair finishes.
// Exclusion applies ONLY after the repair is exhausted (COMPLETED with
// garbled sources remaining). This lib never touches the repair job's
// progress, counters, lease, or STOP/RESUME semantics — it only reads the
// job's status and creates a QUEUED job when none exists.

export const REPAIR_RUNNING_MESSAGE = 'جارٍ إصلاح مصادر الكتاب، وسيستكمل التوليد تلقائياً دون الحاجة لضغطة جديدة'

// A generation attempt needs a real slice of the remaining budget; below
// this the resume leaves the intent PENDING for the next driver run
// instead of starting a generation it cannot finish.
export const RESUME_MIN_GENERATION_BUDGET_MS = 90_000

export type BookRepairJobStatus = string

export type RegenerationIntentRow = {
  id: string
  unitId: string
  programId: string
  bookId: string
  repairJobId: string | null
  status: string
  resolution: string | null
  createdAt: Date
  resolvedAt: Date | null
}

// The SCAN route's PDF preflight, minus the PDFDocument page-count load:
// the original file must still be readable as a PDF before a repair job is
// worth enqueueing. Unreadable → null, and the caller falls through to the
// existing exclusion/refusal path instead of deferring.
export async function loadReadableBookPdfBuffer(book: {
  storageProvider: string | null
  storageKey: string | null
  fileUrl: string | null
  data: string | null
  mimeType: string | null
}): Promise<Buffer | null> {
  try {
    const stored = await getFileBufferFromStorageOrBase64({
      provider: book.storageProvider, key: book.storageKey,
      url: book.fileUrl, data: book.data, mimeType: book.mimeType,
    })
    if (stored?.buffer?.length && stored.buffer.subarray(0, 5).toString() === '%PDF-') return stored.buffer
  } catch (error) {
    console.warn('Unit regeneration link PDF preflight failed:', error)
  }
  return null
}

export async function findLatestBookRepairJob(bookId: string) {
  return db.bookRepairJob.findFirst({ where: { bookId }, orderBy: { createdAt: 'desc' } })
}

// Repair is exhausted only when the latest job COMPLETED: remaining==0
// means every distorted chunk was corrected or sent to review, so no
// further repair pass can improve the unit's sources. Any other terminal
// state (FAILED / STOPPED) is NOT exhaustion — the admin can start a new
// SCAN job — and an active or PAUSED job is still repair in progress.
export function isBookRepairExhausted(job: { status: string } | null): boolean {
  return job?.status === 'COMPLETED'
}

// Find the active repair job for the book, or enqueue a fresh QUEUED SCAN
// job (the same enqueue the SCAN button uses, WITHOUT running a step).
// Never creates a second job while one is active.
export async function ensureBookRepairJob(bookId: string, programId: string) {
  const active = await db.bookRepairJob.findFirst({
    where: { bookId, status: { in: ['QUEUED', 'RUNNING', 'PAUSED'] } },
    orderBy: { createdAt: 'desc' },
  })
  if (active) return active
  return db.bookRepairJob.create({ data: { bookId, programId, status: 'QUEUED', mode: 'SCAN' } })
}

export async function findPendingRegenerationIntent(unitId: string): Promise<RegenerationIntentRow | null> {
  return db.unitRegenerationIntent.findFirst({ where: { unitId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } })
}

// One PENDING intent per unit, enforced by @@unique([unitId, status]).
// Reuses the existing PENDING intent on a second deferral (updating its
// repairJobId when a newer job superseded the old one); on a P2002 race
// re-fetches the existing row instead of failing.
export async function upsertPendingRegenerationIntent(params: {
  unitId: string
  programId: string
  bookId: string
  repairJobId: string | null
}): Promise<RegenerationIntentRow> {
  const existing = await findPendingRegenerationIntent(params.unitId)
  if (existing) {
    if (existing.repairJobId !== params.repairJobId) {
      return db.unitRegenerationIntent.update({ where: { id: existing.id }, data: { repairJobId: params.repairJobId } })
    }
    return existing
  }
  try {
    return await db.unitRegenerationIntent.create({
      data: { unitId: params.unitId, programId: params.programId, bookId: params.bookId, repairJobId: params.repairJobId, status: 'PENDING' },
    })
  } catch (error: any) {
    if (error?.code === 'P2002') {
      const refetched = await findPendingRegenerationIntent(params.unitId)
      if (refetched) return refetched
    }
    throw error
  }
}

// Resolve a PENDING intent exactly once (CAS on status) — only after the
// draft is created or a final refusal is recorded, never before.
export async function resolvePendingRegenerationIntent(
  unitId: string,
  resolution: 'DRAFT_CREATED' | 'REFUSED_NO_HEALTHY_SOURCES',
): Promise<boolean> {
  const resolved = await db.unitRegenerationIntent.updateMany({
    where: { unitId, status: 'PENDING' },
    data: { status: 'RESOLVED', resolution, resolvedAt: new Date() },
  })
  return resolved.count > 0
}

export type DeferralDecision =
  | { deferred: false }
  | {
      deferred: true
      repairJobId: string
      repairStatus: string
      intentId: string
      message: string
    }

// Repair-first deferral, decided AFTER loading chunks+knowledge and
// assessing, BEFORE any generation job is created and BEFORE the
// healthy-sources assertion:
// - healthy sources → null (generate immediately, no repair job created)
// - latest repair COMPLETED → null (exhausted → existing exclusion/refusal)
// - latest repair active/paused/failed/stopped → 202 with that job
//   (never a second job; a PAUSED job is never auto-resumed)
// - no repair job yet → PDF preflight; unreadable → null (fall through
//   to exclusion/refusal, never defer); readable → enqueue one QUEUED
//   SCAN job + upsert the intent → 202
export async function maybeDeferUnitRegenerationForRepair(
  sources: UnitRegenerationSources,
): Promise<DeferralDecision> {
  const { unit, assessment } = sources
  if (!assessment.affected) return { deferred: false }
  const latest = await findLatestBookRepairJob(unit.sourceBookId)
  if (isBookRepairExhausted(latest)) return { deferred: false }
  if (latest) {
    const intent = await upsertPendingRegenerationIntent({
      unitId: unit.id, programId: unit.programId, bookId: unit.sourceBookId, repairJobId: latest.id,
    })
    return { deferred: true, repairJobId: latest.id, repairStatus: latest.status, intentId: intent.id, message: REPAIR_RUNNING_MESSAGE }
  }
  const book = await db.book.findUnique({
    where: { id: unit.sourceBookId },
    select: { id: true, storageProvider: true, storageKey: true, fileUrl: true, data: true, mimeType: true },
  })
  if (!book) return { deferred: false }
  const buffer = await loadReadableBookPdfBuffer(book)
  if (!buffer) return { deferred: false }
  const repairJob = await ensureBookRepairJob(unit.sourceBookId, unit.programId)
  const intent = await upsertPendingRegenerationIntent({
    unitId: unit.id, programId: unit.programId, bookId: unit.sourceBookId, repairJobId: repairJob.id,
  })
  return { deferred: true, repairJobId: repairJob.id, repairStatus: repairJob.status, intentId: intent.id, message: REPAIR_RUNNING_MESSAGE }
}

export type ResumeIntentResult = {
  intentId: string
  unitId: string
  outcome: 'DRAFT_CREATED' | 'REFUSED_NO_HEALTHY_SOURCES' | 'STILL_PENDING' | 'SKIPPED'
  reason: string
}

export type ResumePendingResult = {
  bookId: string
  attempted: number
  resolved: number
  skipped: number
  results: ResumeIntentResult[]
}

// Auto-resume driver: for each PENDING intent for the book (oldest
// first), re-assess the unit's sources against the LATEST repair job:
// - repair COMPLETED (exhausted) → run the regeneration (it applies the
//   existing exclusion/refusal) and resolve the intent with the outcome
// - sources now healthy (repair fixed them) → run it and resolve
//   DRAFT_CREATED — note this can only happen after a COMPLETED repair,
//   because a still-active repair leaves the intent pending below
// - repair still active / paused / failed / stopped, or no repair job
//   at all → leave PENDING, never generate
// - remaining budget below RESUME_MIN_GENERATION_BUDGET_MS → stop
//   (leave PENDING, do not mark anything)
// An intent resolves ONLY after a draft is created or a final refusal is
// recorded. The repair job itself is only ever READ, never written.
export async function resumePendingUnitRegenerations(
  bookId: string,
  opts: { deadlineMs: number },
): Promise<ResumePendingResult> {
  const intents = await db.unitRegenerationIntent.findMany({
    where: { bookId, status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
  })
  const results: ResumeIntentResult[] = []
  let attempted = 0
  let resolved = 0
  for (const intent of intents) {
    const push = (outcome: ResumeIntentResult['outcome'], reason: string) => {
      results.push({ intentId: intent.id, unitId: intent.unitId, outcome, reason })
      if (outcome === 'SKIPPED') return
      if (outcome === 'STILL_PENDING') return
      resolved++
    }
    if (Date.now() > opts.deadlineMs - RESUME_MIN_GENERATION_BUDGET_MS) {
      push('SKIPPED', 'INSUFFICIENT_BUDGET')
      break
    }
    const latestRepair = await findLatestBookRepairJob(bookId)
    if (!latestRepair) {
      push('STILL_PENDING', 'NO_REPAIR_JOB')
      continue
    }
    if (!isBookRepairExhausted(latestRepair)) {
      push('STILL_PENDING', `REPAIR_${latestRepair.status}`)
      continue
    }
    let sources: UnitRegenerationSources
    try {
      sources = await loadUnitRegenerationSources(intent.unitId)
    } catch (error) {
      push('STILL_PENDING', `SOURCES_UNAVAILABLE:${String((error as any)?.message || error)}`)
      continue
    }
    void sources
    attempted++
    try {
      const result = await runUnitRegeneration(intent.unitId, { deadlineMs: opts.deadlineMs })
      if (result.outcome === 'DRAFT_CREATED') {
        await resolvePendingRegenerationIntent(intent.unitId, 'DRAFT_CREATED')
        push('DRAFT_CREATED', 'DRAFT_CREATED')
      } else if (result.outcome === 'LEASE_LOST' || result.outcome === 'ALREADY_RUNNING' || result.outcome === 'STALE_JOB_FAILED') {
        push('STILL_PENDING', result.outcome)
      }
    } catch (error: any) {
      const message = String(error?.message || error)
      if (error?.regenerationJobId) await markUnitRegenerationJobFailed(error.regenerationJobId, error)
      if (message === 'UNIT_SOURCE_REQUIRES_REPAIR') {
        await resolvePendingRegenerationIntent(intent.unitId, 'REFUSED_NO_HEALTHY_SOURCES')
        push('REFUSED_NO_HEALTHY_SOURCES', 'UNIT_SOURCE_REQUIRES_REPAIR')
      } else {
        push('STILL_PENDING', `GENERATION_FAILED:${message.slice(0, 160)}`)
      }
    }
  }
  return {
    bookId,
    attempted,
    resolved,
    skipped: results.filter((r) => r.outcome === 'SKIPPED').length,
    results,
  }
}
