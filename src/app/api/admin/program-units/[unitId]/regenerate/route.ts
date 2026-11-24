import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import {
  assessUnitSources,
  assertUnitRegenerationHasHealthySources,
  buildUnitRegenerationDraftData,
  generateUnitContentWithAi,
  providerUnavailableStatus,
} from '@/lib/outline-units'

export const runtime = 'nodejs'
export const maxDuration = 240
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ unitId: string }> }

function pageRef(pageStart?: number | null, pageEnd?: number | null) {
  if (!pageStart && !pageEnd) return ''
  if (pageStart && pageEnd && pageStart !== pageEnd) return `صفحات ${pageStart}–${pageEnd}`
  return `صفحة ${pageStart || pageEnd}`
}

// POST /api/admin/program-units/[unitId]/regenerate — regenerate ONE damaged
// unit's content into a PENDING UnitRegenerationDraft preview. The published
// Unit row is NEVER written here (not even for APPROVED units — that is the
// point: a published wrong unit gets a preview first, and only an explicit
// approve applies it). Generation reuses generateUnitContentWithAi, which
// already excludes garbled chunks / pending-review items and refuses with
// UNIT_SOURCE_REQUIRES_REPAIR when nothing healthy remains; the assessment
// below reports the same gaps to the admin before the AI call.
export async function POST(req: NextRequest, context: Context) {
  let job: { id: string } | null = null
  try {
    const admin = await requireAdmin()
    const { unitId } = await context.params
    const activeJob = await db.unitGenerationJob.findFirst({ where: { unitId, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } })
    if (activeJob) {
      if (activeJob.status === 'RUNNING' && (!activeJob.lockedUntil || activeJob.lockedUntil.getTime() <= Date.now())) {
        await db.unitGenerationJob.update({ where: { id: activeJob.id }, data: { status: 'FAILED', lastError: 'توقفت، أعد المحاولة', lockedUntil: null, finishedAt: new Date() } })
        return NextResponse.json({ ok: false, error: 'توقفت، أعد المحاولة' }, { status: 409 })
      }
      return NextResponse.json({ ok: true, job: activeJob, resumed: true })
    }
    const unit = await db.unit.findUnique({
      where: { id: unitId },
      include: { program: { select: { id: true, titleAr: true, titleEn: true } } },
    })
    if (!unit) return NextResponse.json({ error: 'UNIT_NOT_FOUND' }, { status: 404 })
    if (!unit.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null) {
      return NextResponse.json({ error: 'UNIT_OUTLINE_SOURCE_REQUIRED' }, { status: 400 })
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
        if (existing) return NextResponse.json({ ok: true, job: existing, resumed: true })
      }
      throw error
    }
    job = createdJob
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
    const assessment = assessUnitSources(chunks, knowledge)
    assertUnitRegenerationHasHealthySources(assessment)
    const generated = await generateUnitContentWithAi({
      programTitle: unit.program.titleAr || unit.program.titleEn || 'البرنامج الأكاديمي',
      unitTitle: unit.title,
      unitPages: pageRef(chunks[0]?.pageStart, chunks[chunks.length - 1]?.pageEnd),
      chunks,
      knowledge,
      deadlineMs: Date.now() + 210_000,
    })
    const draftData = buildUnitRegenerationDraftData(generated, assessment.gaps)
    const draft = await db.$transaction(async (tx) => {
      await tx.unitRegenerationDraft.deleteMany({ where: { unitId: unit.id, status: 'PENDING' } })
      const created = await tx.unitRegenerationDraft.create({
        data: { unitId: unit.id, programId: unit.programId, status: 'PENDING', ...draftData },
      })
      await tx.unitGenerationJob.update({
        where: { id: job!.id },
        data: { status: 'COMPLETED', phase: 'REGENERATE', unitsDone: 1, finishedAt: new Date(), lockedUntil: null, lastError: null },
      })
      return created
    }, { maxWait: 20000, timeout: 30000 })
    await audit(admin, 'REGENERATE_DAMAGED_UNIT_PREVIEW', 'Unit', unit.id,
      `إعادة توليد محتوى الوحدة المتضررة كمسودة معاينة (لم يُمس المحتوى المنشور): ${unit.title}`
    ).catch((auditError) => console.error('Unit regeneration audit failed after commit:', auditError))
    return NextResponse.json({
      ok: true,
      draft: { id: draft.id, status: draft.status, createdAt: draft.createdAt, summary: generated.summary, objectives: generated.objectives, content: generated.content, gaps: assessment.gaps, sourceKnowledgeIds: JSON.parse(draftData.sourceKnowledgeIds) },
      gaps: assessment.gaps,
      job: { id: job.id, status: 'COMPLETED' },
    })
  } catch (error: any) {
    const message = String(error?.message || error)
    if (job?.id) {
      const paused = providerUnavailableStatus(error)
      await db.unitGenerationJob.update({
        where: { id: job.id },
        data: paused
          ? { status: 'PAUSED', lastError: message.slice(0, 1000), retryAt: new Date(Date.now() + 5 * 60_000), lockedUntil: null }
          : { status: 'FAILED', lastError: message.slice(0, 1000), lockedUntil: null, finishedAt: new Date() },
      }).catch(() => null)
      if (paused) return NextResponse.json({ ok: false, status: 'PAUSED', retryAt: new Date(Date.now() + 5 * 60_000).toISOString(), error: message }, { status: 503 })
      if (message === 'UNIT_SOURCE_REQUIRES_REPAIR') {
        return NextResponse.json({ ok: false, error: 'UNIT_SOURCE_REQUIRES_REPAIR', reason: 'لا توجد مصادر سليمة كافية لإعادة توليد هذه الوحدة — أصلح مصادر الكتاب أولاً' }, { status: 400 })
      }
    }
    if (message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('damaged unit regeneration error:', error)
    return NextResponse.json({ error: message || 'تعذر إعادة توليد محتوى الوحدة' }, { status: 500 })
  }
}
