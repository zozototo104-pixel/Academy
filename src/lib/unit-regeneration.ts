import { db } from '@/lib/db'
import {
  assessUnitSources,
  assertUnitRegenerationHasHealthySources,
  buildUnitRegenerationDraftData,
  generateUnitContentWithAi,
  providerUnavailableStatus,
  type UnitSourceAssessment,
  type UnitSourceChunk,
  type UnitSourceKnowledge,
} from '@/lib/outline-units'

// Damaged-unit regeneration core (PR #212), extracted from the regenerate
// route so the route, the deferral flow and the auto-resume driver all run
// the SAME generation path: load sources → assess → assert healthy →
// generate from healthy sources only → lease-guarded persist as a PENDING
// draft. The published Unit row is NEVER written here. Behaviour is
// unchanged from the route body this was extracted from, including job
// creation BEFORE source loading (so a missing-source failure still leaves
// a FAILED job row, as before).

function pageRef(pageStart?: number | null, pageEnd?: number | null) {
  if (!pageStart && !pageEnd) return ''
  if (pageStart && pageEnd && pageStart !== pageEnd) return `صفحات ${pageStart}–${pageEnd}`
  return `صفحة ${pageStart || pageEnd}`
}

export type UnitRegenerationSources = {
  unit: {
    id: string
    programId: string
    title: string
    sourceBookId: string
    chunkStartIndex: number
    chunkEndIndex: number
    program: { id: string; titleAr: string | null; titleEn: string | null }
  }
  chunks: UnitSourceChunk[]
  knowledge: UnitSourceKnowledge[]
  assessment: UnitSourceAssessment
}

// Load the unit + its in-range chunks/knowledge and assess them. Throws
// UNIT_NOT_FOUND / UNIT_OUTLINE_SOURCE_REQUIRED /
// UNIT_SOURCE_CHUNKS_REQUIRED / UNIT_V2_KNOWLEDGE_REQUIRED, exactly as the
// route did before extraction.
export async function loadUnitRegenerationSources(unitId: string): Promise<UnitRegenerationSources> {
  const unit = await db.unit.findUnique({
    where: { id: unitId },
    include: { program: { select: { id: true, titleAr: true, titleEn: true } } },
  })
  if (!unit) throw new Error('UNIT_NOT_FOUND')
  if (!unit.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null) {
    throw new Error('UNIT_OUTLINE_SOURCE_REQUIRED')
  }
  const chunks = await db.bookChunk.findMany({
    where: { bookId: unit.sourceBookId, status: { not: 'FAILED' }, index: { gte: unit.chunkStartIndex, lte: unit.chunkEndIndex } },
    orderBy: { index: 'asc' },
    select: { id: true, index: true, pageStart: true, pageEnd: true, headingPath: true, text: true },
  })
  if (!chunks.length) throw new Error('UNIT_SOURCE_CHUNKS_REQUIRED')
  const chunkIds = chunks.map((chunk) => chunk.id)
  const knowledge = await db.bookKnowledgeItem.findMany({
    where: { bookId: unit.sourceBookId, kbVersion: 2, chunkId: { in: chunkIds } },
    orderBy: [{ pageStart: 'asc' }, { importance: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, category: true, title: true, summary: true, excerpt: true, pageStart: true, pageEnd: true, chunkId: true },
  })
  if (!knowledge.length) throw new Error('UNIT_V2_KNOWLEDGE_REQUIRED')
  return { unit, chunks, knowledge, assessment: assessUnitSources(chunks, knowledge) }
}

// An already-running generation job for the unit (QUEUED/RUNNING), or a
// stale RUNNING job whose lease expired (marked FAILED, as the route did).
// STALE_FAILED is distinct from NONE so callers can preserve the route's
// original behaviour: a stale job answers 409 «توقفت، أعد المحاولة»
// instead of silently starting a new job over it.
export type ActiveUnitGenerationJob =
  | { state: 'NONE' }
  | { state: 'STALE_FAILED'; job: { id: string; status: string } }
  | { state: 'ACTIVE'; job: { id: string; status: string } }

export async function findActiveUnitGenerationJob(unitId: string): Promise<ActiveUnitGenerationJob> {
  const activeJob = await db.unitGenerationJob.findFirst({ where: { unitId, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } })
  if (!activeJob) return { state: 'NONE' }
  if (activeJob.status === 'RUNNING' && (!activeJob.lockedUntil || activeJob.lockedUntil.getTime() <= Date.now())) {
    await db.unitGenerationJob.update({ where: { id: activeJob.id }, data: { status: 'FAILED', lastError: 'توقفت، أعد المحاولة', lockedUntil: null, finishedAt: new Date() } })
    return { state: 'STALE_FAILED', job: activeJob }
  }
  return { state: 'ACTIVE', job: activeJob }
}

// Mark a regeneration job FAILED (or PAUSED when the provider is
// unavailable, with a 5-minute retry) after a generation error. Shared by
// the route wrapper and the auto-resume driver so both finalise jobs the
// same way. The thrown error carries `regenerationJobId` so callers can
// find the job without re-querying.
export async function markUnitRegenerationJobFailed(jobId: string, error: unknown): Promise<boolean> {
  const message = String((error as any)?.message || error || '')
  const paused = providerUnavailableStatus(error)
  await db.unitGenerationJob.update({
    where: { id: jobId },
    data: paused
      ? { status: 'PAUSED', lastError: message.slice(0, 1000), retryAt: new Date(Date.now() + 5 * 60_000), lockedUntil: null }
      : { status: 'FAILED', lastError: message.slice(0, 1000), lockedUntil: null, finishedAt: new Date() },
  }).catch(() => null)
  return paused
}

export type RunUnitRegenerationResult =
  | {
      outcome: 'DRAFT_CREATED'
      draft: { id: string; status: string; createdAt: Date }
      generated: Awaited<ReturnType<typeof generateUnitContentWithAi>>
      gaps: UnitSourceAssessment['gaps']
      job: { id: string; status: string }
    }
  | { outcome: 'ALREADY_RUNNING'; job: { id: string; status: string } }
  | { outcome: 'STALE_JOB_FAILED'; job: { id: string; status: string } }
  | { outcome: 'LEASE_LOST' }

// Run ONE damaged unit's regeneration end to end (fresh UnitGenerationJob
// under the existing lease/lock rules). Throws UNIT_SOURCE_REQUIRES_REPAIR
// when nothing healthy remains, and other errors as the route did; any
// error thrown after the job is created carries `regenerationJobId` so the
// caller can finalise the job with markUnitRegenerationJobFailed.
export async function runUnitRegeneration(
  unitId: string,
  opts: { deadlineMs: number },
): Promise<RunUnitRegenerationResult> {
  let job: { id: string } | null = null
  try {
    const active = await findActiveUnitGenerationJob(unitId)
    if (active.state === 'ACTIVE') return { outcome: 'ALREADY_RUNNING', job: active.job }
    if (active.state === 'STALE_FAILED') return { outcome: 'STALE_JOB_FAILED', job: active.job }
    const unit = await db.unit.findUnique({
      where: { id: unitId },
      include: { program: { select: { id: true, titleAr: true, titleEn: true } } },
    })
    if (!unit) throw new Error('UNIT_NOT_FOUND')
    if (!unit.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null) {
      throw new Error('UNIT_OUTLINE_SOURCE_REQUIRED')
    }
    let createdJob: { id: string }
    try {
      createdJob = await db.unitGenerationJob.create({
        data: { unitId: unit.id, programId: unit.programId, status: 'RUNNING', phase: 'REGENERATE', unitsTotal: 1, unitsDone: 0, startedAt: new Date(), lockedUntil: new Date(Date.now() + 240_000) },
        select: { id: true },
      })
    } catch (error: any) {
      if (error?.code === 'P2002') {
        const existing = await db.unitGenerationJob.findFirst({ where: { unitId: unit.id, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } })
        if (existing) return { outcome: 'ALREADY_RUNNING', job: existing }
      }
      throw error
    }
    job = createdJob
    const { chunks, knowledge, assessment } = await loadUnitRegenerationSources(unitId)
    assertUnitRegenerationHasHealthySources(assessment)
    const generated = await generateUnitContentWithAi({
      programTitle: unit.program.titleAr || unit.program.titleEn || 'البرنامج الأكاديمي',
      unitTitle: unit.title,
      unitPages: pageRef(chunks[0]?.pageStart, chunks[chunks.length - 1]?.pageEnd),
      chunks,
      knowledge,
      deadlineMs: Math.min(opts.deadlineMs, Date.now() + 210_000),
    })
    const draftData = buildUnitRegenerationDraftData(generated, assessment.gaps)
    const draft = await db.$transaction(async (tx) => {
      const claimed = await tx.unitGenerationJob.updateMany({
        where: { id: job!.id, unitId: unit.id, status: 'RUNNING', phase: 'REGENERATE', lockedUntil: { gt: new Date() } },
        data: { status: 'COMPLETED', phase: 'REGENERATE', unitsDone: 1, finishedAt: new Date(), lockedUntil: null, lastError: null },
      })
      if (claimed.count !== 1) return null
      await tx.unitRegenerationDraft.deleteMany({ where: { unitId: unit.id, status: 'PENDING' } })
      return tx.unitRegenerationDraft.create({
        data: { unitId: unit.id, programId: unit.programId, status: 'PENDING', ...draftData },
      })
    }, { maxWait: 20000, timeout: 30000 })
    if (!draft) return { outcome: 'LEASE_LOST' }
    return {
      outcome: 'DRAFT_CREATED',
      draft: { id: draft.id, status: draft.status, createdAt: draft.createdAt },
      generated,
      gaps: assessment.gaps,
      job: { id: job.id, status: 'COMPLETED' },
    }
  } catch (error: any) {
    if (job?.id) (error as any).regenerationJobId = job.id
    throw error
  }
}
