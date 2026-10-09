import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { buildUnitStudyGuideDraft, generateUnitContentWithAi, providerUnavailableStatus, validateStudyGuideSources, type UnitContentSection } from '@/lib/outline-units'

export const runtime = 'nodejs'
export const maxDuration = 240
export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ unitId: string }> }

function parseContent(value: unknown): UnitContentSection[] {
  if (!value) return []
  if (Array.isArray(value)) return value as UnitContentSection[]
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function pageRef(pageStart?: number | null, pageEnd?: number | null) {
  if (!pageStart && !pageEnd) return ''
  if (pageStart && pageEnd && pageStart !== pageEnd) return `صفحات ${pageStart}–${pageEnd}`
  return `صفحة ${pageStart || pageEnd}`
}

function mapUnit(unit: any) {
  return {
    id: unit.id,
    title: unit.title,
    summary: unit.summary,
    objectives: (() => { try { return JSON.parse(unit.objectives || '[]') } catch { return [] } })(),
    content: parseContent(unit.content),
    order: unit.order,
    semester: unit.semester,
    status: unit.status,
    sourceBookId: unit.sourceBookId,
    outlineSectionId: unit.outlineSectionId,
    chunkStartIndex: unit.chunkStartIndex,
    chunkEndIndex: unit.chunkEndIndex,
    generationVersion: unit.generationVersion,
  }
}

export async function POST(req: NextRequest, context: Context) {
  let job: { id: string } | null = null
  try {
    const admin = await requireAdmin()
    const { unitId } = await context.params
    const body = await req.json().catch(() => ({}))
    const force = Boolean(body?.regenerate || body?.force)
    const activeJob = await db.unitGenerationJob.findFirst({ where: { unitId, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } })
    if (activeJob) {
      if (activeJob.status === 'RUNNING' && activeJob.lockedUntil && activeJob.lockedUntil.getTime() <= Date.now()) {
        const failedJob = await db.unitGenerationJob.update({ where: { id: activeJob.id }, data: { status: 'FAILED', lastError: 'توقفت، أعد المحاولة', lockedUntil: null, finishedAt: new Date() } })
        return NextResponse.json({ ok: false, job: failedJob, error: 'توقفت، أعد المحاولة' }, { status: 409 })
      }
      return NextResponse.json({ ok: true, job: activeJob, resumed: true })
    }
    const unit = await db.unit.findUnique({
      where: { id: unitId },
      include: { program: { select: { id: true, titleAr: true, titleEn: true } } },
    })
    if (!unit) return NextResponse.json({ error: 'UNIT_NOT_FOUND' }, { status: 404 })
    if (unit.status === 'APPROVED') {
      return NextResponse.json({ ok: true, skipped: 'APPROVED_UNIT_NOT_MODIFIED', unit: mapUnit(unit) })
    }
    if (!unit.sourceBookId || unit.chunkStartIndex == null || unit.chunkEndIndex == null || !unit.outlineSectionId) {
      return NextResponse.json({ error: 'UNIT_OUTLINE_SOURCE_REQUIRED' }, { status: 400 })
    }
    if (!force && parseContent(unit.content).some((section) => section.sourceKnowledgeIds?.length || section.sourceChunkIndexes?.length)) {
      return NextResponse.json({ ok: true, skipped: 'UNIT_ALREADY_HAS_REFERENCED_CONTENT', unit: mapUnit(unit) })
    }

    let createdJob: { id: string }
    try {
      createdJob = await db.unitGenerationJob.create({
        data: { unitId: unit.id, programId: unit.programId, status: 'RUNNING', phase: 'CONTENT', unitsTotal: 1, unitsDone: 0, startedAt: new Date(), lockedUntil: new Date(Date.now() + 240_000) },
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
      where: { bookId: unit.sourceBookId, index: { gte: unit.chunkStartIndex, lte: unit.chunkEndIndex } },
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

    const generated = await generateUnitContentWithAi({
      programTitle: unit.program.titleAr || unit.program.titleEn || 'البرنامج الأكاديمي',
      unitTitle: unit.title,
      unitPages: pageRef(chunks[0]?.pageStart, chunks[chunks.length - 1]?.pageEnd),
      chunks,
      knowledge,
      deadlineMs: Date.now() + 210_000,
    })

    const guideDraft = buildUnitStudyGuideDraft({
      programTitle: unit.program.titleAr || unit.program.titleEn || 'البرنامج الأكاديمي',
      unitTitle: unit.title,
      unitSummary: generated.summary,
      semester: unit.semester,
      knowledge,
      unitContent: generated.content,
    })
    const sourceKnowledgeIds = validateStudyGuideSources(guideDraft.sourceKnowledgeIds, knowledge.map((item) => item.id))
    const existingGuide = await db.programStudyGuide.findFirst({ where: { unitId: unit.id }, select: { id: true } })

    const updatedUnit = await db.unit.update({
      where: { id: unit.id },
      data: {
        summary: generated.summary,
        objectives: JSON.stringify(generated.objectives),
        content: JSON.stringify(generated.content),
        generationVersion: { increment: 1 },
      },
    })

    const guideData = {
      programId: unit.programId,
      unitId: unit.id,
      semester: unit.semester,
      title: guideDraft.title,
      overview: guideDraft.overview,
      objectives: JSON.stringify(guideDraft.objectives),
      keyTerms: JSON.stringify(guideDraft.keyTerms),
      sections: JSON.stringify(guideDraft.sections),
      activities: JSON.stringify(guideDraft.activities),
      discussionQuestions: JSON.stringify(guideDraft.discussionQuestions),
      sourceKnowledgeIds: JSON.stringify(sourceKnowledgeIds),
      status: 'DRAFT',
      generatedBy: 'AI',
    }
    const guide = existingGuide
      ? await db.programStudyGuide.update({ where: { id: existingGuide.id }, data: guideData })
      : await db.programStudyGuide.create({ data: guideData })

    await db.unitGenerationJob.update({ where: { id: job.id }, data: { status: 'COMPLETED', phase: 'GUIDE', unitsDone: 1, finishedAt: new Date(), lockedUntil: null, lastError: null } })
    await audit(admin, 'GENERATE_OUTLINE_UNIT', 'Unit', unit.id, `توليد محتوى ودليل وحدة من فهرس الكتاب: ${unit.title}`)
    return NextResponse.json({ ok: true, unit: mapUnit(updatedUnit), guide, job: { id: job.id, status: 'COMPLETED' } })
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
    }
    if (message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('outline unit generation error:', error)
    return NextResponse.json({ error: message || 'تعذر توليد محتوى الوحدة' }, { status: 500 })
  }
}
