import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { hasUnitExamAttempts } from '@/lib/outline-units'
import { countUnitExamQuestionsNeedingReview } from '@/lib/unit-exam-policy'
import { readQuestionBankJobTrace } from '@/lib/question-bank-job'

function cleanText(value: unknown, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseObjectives(value: unknown) {
  if (Array.isArray(value)) return value.map((x) => cleanText(x, 240)).filter((x) => x.length > 3).slice(0, 12)
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed.map((x) => cleanText(x, 240)).filter((x) => x.length > 3).slice(0, 12)
    } catch (error) {
      console.warn('Failed to parse unit objectives JSON; falling back to delimited text.', error)
    }
    return value.split(/\n|،|,/).map((x) => cleanText(x, 240)).filter((x) => x.length > 3).slice(0, 12)
  }
  return []
}

function parseContent(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((x: any) => ({
      heading: cleanText(x?.heading, 160) || 'محور',
      body: cleanText(x?.body, 1600),
      pageRefs: Array.isArray(x?.pageRefs) ? x.pageRefs.map((r: any) => cleanText(r, 80)).filter(Boolean) : [],
      sourceKnowledgeIds: Array.isArray(x?.sourceKnowledgeIds) ? x.sourceKnowledgeIds.map((id: any) => cleanText(id, 100)).filter(Boolean) : [],
      sourceChunkIndexes: Array.isArray(x?.sourceChunkIndexes) ? x.sourceChunkIndexes.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n)) : [],
    })).filter((x) => x.body).slice(0, 12)
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parseContent(parsed)
    } catch (error) {
      console.warn('Failed to parse unit content JSON; falling back to plain text.', error)
    }
    return [{ heading: 'محتوى الوحدة', body: cleanText(value, 1200), pageRefs: [], sourceKnowledgeIds: [], sourceChunkIndexes: [] }]
  }
  return []
}

function jsonArray(value: unknown) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
  }
  return []
}

function mapStudyGuide(guide: any | null) {
  if (!guide) return null
  return {
    id: guide.id,
    unitId: guide.unitId,
    semester: guide.semester,
    title: guide.title,
    overview: guide.overview,
    objectives: jsonArray(guide.objectives),
    keyTerms: jsonArray(guide.keyTerms),
    sections: jsonArray(guide.sections),
    activities: jsonArray(guide.activities),
    discussionQuestions: jsonArray(guide.discussionQuestions),
    sourceKnowledgeIds: jsonArray(guide.sourceKnowledgeIds),
    status: guide.status,
    generatedBy: guide.generatedBy,
    updatedAt: guide.updatedAt,
  }
}

async function listProgramUnits(programId: string) {
  const units = await db.unit.findMany({
    where: { programId },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
    include: {
      exam: {
        select: {
          id: true,
          title: true,
          status: true,
          passScore: true,
          questions: { select: { text: true } },
          _count: { select: { questions: true, attempts: true } },
        },
      },
    },
  })
  const unitIds = units.map((unit) => unit.id)
  const outlineSectionIds = [...new Set(units.map((unit) => unit.outlineSectionId).filter((id): id is string => Boolean(id)))]
  const bookIds = [...new Set(units.map((unit) => unit.sourceBookId).filter((id): id is string => Boolean(id)))]
  const [guides, jobs, questionBankJobs, questionBankCounts, sections, books] = await Promise.all([
    unitIds.length ? db.programStudyGuide.findMany({ where: { unitId: { in: unitIds } }, orderBy: { updatedAt: 'desc' } }) : [],
    unitIds.length ? db.unitGenerationJob.findMany({ where: { unitId: { in: unitIds } }, orderBy: { updatedAt: 'desc' } }) : [],
    unitIds.length ? db.questionBankGenerationJob.findMany({ where: { unitId: { in: unitIds } }, orderBy: { updatedAt: 'desc' } }) : [],
    unitIds.length ? db.questionBankItem.groupBy({ by: ['unitId', 'status'], where: { unitId: { in: unitIds }, status: { in: ['APPROVED', 'PENDING_REVIEW', 'REJECTED'] } }, _count: { _all: true } }) : [],
    outlineSectionIds.length ? db.bookOutlineSection.findMany({ where: { id: { in: outlineSectionIds } }, select: { id: true, title: true, pageStart: true, pageEnd: true, chunkStartIndex: true, chunkEndIndex: true } }) : [],
    bookIds.length ? db.book.findMany({ where: { id: { in: bookIds } }, select: { id: true, title: true } }) : [],
  ])
  const guideByUnit = new Map<string, any>()
  for (const guide of guides) if (guide.unitId && !guideByUnit.has(guide.unitId)) guideByUnit.set(guide.unitId, guide)
  const jobByUnit = new Map<string, any>()
  for (const job of jobs) if (!jobByUnit.has(job.unitId)) jobByUnit.set(job.unitId, job)
  const questionBankJobByUnit = new Map<string, (typeof questionBankJobs)[number]>()
  for (const job of questionBankJobs) if (job.unitId && !questionBankJobByUnit.has(job.unitId)) questionBankJobByUnit.set(job.unitId, job)
  const questionBankCountsByUnit = new Map<string, { approved: number; pendingReview: number; rejected: number }>()
  for (const row of questionBankCounts) {
    if (!row.unitId) continue
    const current = questionBankCountsByUnit.get(row.unitId) || { approved: 0, pendingReview: 0, rejected: 0 }
    if (row.status === 'APPROVED') current.approved += row._count._all
    if (row.status === 'PENDING_REVIEW') current.pendingReview += row._count._all
    if (row.status === 'REJECTED') current.rejected += row._count._all
    questionBankCountsByUnit.set(row.unitId, current)
  }
  const questionBankTraceByJob = new Map(await Promise.all([...questionBankJobByUnit.values()].map(async (job) => [job.id, await readQuestionBankJobTrace(job.id)] as const)))
  const sectionById = new Map(sections.map((section) => [section.id, section] as const))
  const bookById = new Map(books.map((book) => [book.id, book] as const))
  return units.map((u) => {
    const section = u.outlineSectionId ? sectionById.get(u.outlineSectionId) : null
    const book = u.sourceBookId ? bookById.get(u.sourceBookId) : null
    return {
      id: u.id,
      title: u.title,
      summary: u.summary,
      objectives: parseObjectives(u.objectives),
      content: parseContent(u.content),
      order: u.order,
      semester: u.semester,
      status: u.status,
      sourceBookId: u.sourceBookId,
      outlineSectionId: u.outlineSectionId,
      chunkStartIndex: u.chunkStartIndex,
      chunkEndIndex: u.chunkEndIndex,
      generationVersion: u.generationVersion,
      source: section || book ? {
        bookTitle: book?.title || null,
        sectionTitle: section?.title || null,
        pageStart: section?.pageStart ?? null,
        pageEnd: section?.pageEnd ?? null,
        chunkStartIndex: section?.chunkStartIndex ?? u.chunkStartIndex,
        chunkEndIndex: section?.chunkEndIndex ?? u.chunkEndIndex,
      } : null,
      studyGuide: mapStudyGuide(guideByUnit.get(u.id) || null),
      generationJob: jobByUnit.get(u.id) ? {
        id: jobByUnit.get(u.id).id,
        status: jobByUnit.get(u.id).status,
        phase: jobByUnit.get(u.id).phase,
        unitsDone: jobByUnit.get(u.id).unitsDone,
        unitsTotal: jobByUnit.get(u.id).unitsTotal,
        lastError: jobByUnit.get(u.id).lastError,
        retryAt: jobByUnit.get(u.id).retryAt,
        updatedAt: jobByUnit.get(u.id).updatedAt,
      } : null,
      questionBankSummary: {
        approved: questionBankCountsByUnit.get(u.id)?.approved || 0,
        pendingReview: questionBankCountsByUnit.get(u.id)?.pendingReview || 0,
        rejected: questionBankCountsByUnit.get(u.id)?.rejected || 0,
      },
      questionBankJob: questionBankJobByUnit.get(u.id) ? {
        id: questionBankJobByUnit.get(u.id)!.id,
        status: questionBankJobByUnit.get(u.id)!.status,
        requested: questionBankJobByUnit.get(u.id)!.requested,
        saved: questionBankJobByUnit.get(u.id)!.saved,
        approvedQuestions: questionBankCountsByUnit.get(u.id)?.approved || 0,
        pendingReviewQuestions: questionBankCountsByUnit.get(u.id)?.pendingReview || 0,
        currentQuestions: (questionBankCountsByUnit.get(u.id)?.approved || 0) + (questionBankCountsByUnit.get(u.id)?.pendingReview || 0),
        lastError: questionBankJobByUnit.get(u.id)!.lastError,
        retryAt: questionBankJobByUnit.get(u.id)!.retryAt,
        updatedAt: questionBankJobByUnit.get(u.id)!.updatedAt,
        trace: questionBankTraceByJob.get(questionBankJobByUnit.get(u.id)!.id) || null,
      } : null,
      exam: u.exam
        ? {
            id: u.exam.id,
            title: u.exam.title,
            status: u.exam.status,
            passScore: u.exam.passScore,
            questionsCount: u.exam._count.questions,
            attemptsCount: u.exam._count.attempts,
            reviewQuestionsCount: countUnitExamQuestionsNeedingReview(u.exam.questions),
          }
        : null,
    }
  })
}

// GET /api/admin/program-units?programId=...
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = cleanText(req.nextUrl.searchParams.get('programId'), 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const program = await db.program.findUnique({
      where: { id: programId },
      select: { id: true, titleAr: true, semestersCount: true, academicReadinessStatus: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    return NextResponse.json({ program, units: await listProgramUnits(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program units GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل وحدات البرنامج' }, { status: 500 })
  }
}

// POST /api/admin/program-units — إضافة وحدة بشرية أثناء المراجعة
export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const count = await db.unit.count({ where: { programId } })
    const unit = await db.unit.create({
      data: {
        programId,
        order: Number(body?.order || count + 1),
        semester: Math.max(1, Math.min(12, Number(body?.semester || 1))),
        status: ['DRAFT', 'APPROVED', 'NEEDS_REVISION'].includes(String(body?.status || '').toUpperCase()) ? String(body.status).toUpperCase() : 'DRAFT',
        title: cleanText(body?.title, 220) || 'وحدة جديدة',
        summary: cleanText(body?.summary, 2000) || 'ملخص الوحدة',
        objectives: JSON.stringify(parseObjectives(body?.objectives).length ? parseObjectives(body?.objectives) : ['هدف تعلم قابل للقياس']),
        content: JSON.stringify(parseContent(body?.content).length ? parseContent(body?.content) : [{ heading: 'محتوى الوحدة', body: cleanText(body?.summary, 1000) || 'محتوى قابل للمراجعة البشرية.' }]),
      },
    })
    await db.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
    return NextResponse.json({ ok: true, unit, units: await listProgramUnits(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program units POST error:', e)
    return NextResponse.json({ error: 'تعذر إضافة الوحدة' }, { status: 500 })
  }
}

// PATCH /api/admin/program-units — تعديل وحدة أو إعادة ترتيب الوحدات
export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json()
    const unitId = cleanText(body?.unitId, 80)
    const programId = cleanText(body?.programId, 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })

    if (Array.isArray(body?.orders)) {
      for (const item of body.orders) {
        const id = cleanText(item?.id, 80)
        if (!id) continue
        await db.unit.updateMany({ where: { id, programId }, data: { order: Number(item.order || 0) } })
      }
    } else {
      if (!unitId) return NextResponse.json({ error: 'معرف الوحدة مطلوب' }, { status: 400 })
      const data: any = {}
      if (body?.title !== undefined) data.title = cleanText(body.title, 220) || 'وحدة بلا عنوان'
      if (body?.summary !== undefined) data.summary = cleanText(body.summary, 2500) || null
      if (body?.objectives !== undefined) data.objectives = JSON.stringify(parseObjectives(body.objectives))
      if (body?.content !== undefined) data.content = JSON.stringify(parseContent(body.content))
      if (body?.order !== undefined) data.order = Number(body.order || 0)
      if (body?.semester !== undefined) data.semester = Math.max(1, Math.min(12, Number(body.semester || 1)))
      if (body?.status !== undefined) {
        const status = String(body.status || '').toUpperCase()
        if (['DRAFT', 'APPROVED', 'NEEDS_REVISION'].includes(status)) data.status = status
      }
      await db.unit.updateMany({ where: { id: unitId, programId }, data })
    }

    await db.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
    return NextResponse.json({ ok: true, units: await listProgramUnits(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program units PATCH error:', e)
    return NextResponse.json({ error: 'تعذر تعديل وحدات البرنامج' }, { status: 500 })
  }
}

// DELETE /api/admin/program-units?programId=...&unitId=...
export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = cleanText(req.nextUrl.searchParams.get('programId'), 80)
    const unitId = cleanText(req.nextUrl.searchParams.get('unitId'), 80)
    const force = req.nextUrl.searchParams.get('force') === 'true'
    if (!programId || !unitId) return NextResponse.json({ error: 'معرف البرنامج والوحدة مطلوبان' }, { status: 400 })
    const unit = await db.unit.findFirst({
      where: { id: unitId, programId },
      select: { id: true, title: true, status: true, exam: { select: { _count: { select: { attempts: true } } } } },
    })
    if (!unit) return NextResponse.json({ error: 'الوحدة غير موجودة' }, { status: 404 })
    const blocked = unit.status === 'APPROVED' || hasUnitExamAttempts(unit)
    if (blocked && !force) {
      const reasons = [unit.status === 'APPROVED' ? 'الوحدة معتمدة' : '', hasUnitExamAttempts(unit) ? 'لها محاولات طلاب مرتبطة بالاختبار' : ''].filter(Boolean).join(' و')
      return NextResponse.json({ error: `لا يمكن حذف هذه الوحدة لأنها ${reasons}. استخدم الحذف الإجباري بعد تأكيد إداري صريح.` }, { status: 409 })
    }
    await db.unit.deleteMany({ where: { id: unitId, programId } })
    await db.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
    return NextResponse.json({ ok: true, units: await listProgramUnits(programId) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program units DELETE error:', e)
    return NextResponse.json({ error: 'تعذر حذف الوحدة' }, { status: 500 })
  }
}
