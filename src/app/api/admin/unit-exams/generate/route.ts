import { after, NextRequest, NextResponse } from 'next/server'
import type { QuestionBankItem } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ensureQuestionBankGenerationJob, runQuestionBankGenerationJobStepsUntil } from '@/lib/question-bank-job'
import { UNIT_EXAM_REVIEW_LABEL, selectUnitExamQuestionsApprovedFirst, unitExamQuestionTextWithReviewLabel, unitExamRequiredQuestions, type UnitExamSelection } from '@/lib/unit-exam-policy'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

type UnitExamBankItem = Pick<QuestionBankItem, 'id' | 'status' | 'type' | 'text' | 'options' | 'correctAnswer' | 'modelAnswer' | 'sourceEvidence' | 'correctRationale' | 'qualityFlags' | 'usageCount' | 'createdAt'>
type ScopedQuestionResult = { questions: UnitExamBankItem[]; selection: UnitExamSelection; requiredQuestions: number }

function cleanText(value: unknown, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => cleanText(item, 260)).filter(Boolean)
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => cleanText(item, 260)).filter(Boolean) : []
  } catch {
    return []
  }
}

function shuffleWithAnswer(options: string[], correctAnswer: string | null | undefined) {
  const original = options.map((option) => cleanText(option, 240)).filter(Boolean)
  if (!original.length) return { options: [], correctAnswer: null as string | null }
  const correctIndex = Math.max(0, Math.min(original.length - 1, Number(correctAnswer || 0)))
  const pairs = original.map((option, index) => ({ option, correct: index === correctIndex }))
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pairs[i], pairs[j]] = [pairs[j], pairs[i]]
  }
  const nextCorrect = pairs.findIndex((pair) => pair.correct)
  return { options: pairs.map((pair) => pair.option), correctAnswer: String(Math.max(0, nextCorrect)) }
}

function toExamQuestion(item: UnitExamBankItem, index: number, needsReview: boolean) {
  const type = String(item.type || 'MCQ').toUpperCase()
  const text = unitExamQuestionTextWithReviewLabel(item.text, needsReview)
  if (type === 'MCQ') {
    const shuffled = shuffleWithAnswer(parseStringArray(item.options), item.correctAnswer)
    return { order: index + 1, type: 'MCQ', text: cleanText(text, 1200), options: JSON.stringify(shuffled.options), correctAnswer: shuffled.correctAnswer, modelAnswer: cleanText(item.modelAnswer || item.correctRationale || item.sourceEvidence, 1800), points: 10 }
  }
  if (type === 'TF') {
    const correctAnswer = String(item.correctAnswer) === '1' ? '1' : '0'
    return { order: index + 1, type: 'TF', text: cleanText(text, 1200), options: JSON.stringify(['صح', 'خطأ']), correctAnswer, modelAnswer: cleanText(item.modelAnswer || item.correctRationale || item.sourceEvidence, 1800), points: 10 }
  }
  return { order: index + 1, type: type === 'ESSAY' ? 'ESSAY' : 'SHORT', text: cleanText(text, 1200), options: JSON.stringify([]), correctAnswer: null, modelAnswer: cleanText(item.modelAnswer || item.sourceEvidence, 1800), points: 10 }
}

async function unitQuestionCandidates(programId: string, unitId: string, requiredQuestions: number, includePending: boolean): Promise<UnitExamBankItem[]> {
  return db.questionBankItem.findMany({
    where: {
      programId,
      unitId,
      qualityFlags: { contains: 'SOURCE_GROUNDED' },
      status: includePending ? { in: ['APPROVED', 'PENDING_REVIEW'] } : 'APPROVED',
    },
    orderBy: [{ status: 'asc' }, { usageCount: 'asc' }, { createdAt: 'desc' }],
    take: Math.max(40, requiredQuestions * 4),
  })
}

function selectItems(candidates: UnitExamBankItem[], requiredQuestions: number) {
  const selection = selectUnitExamQuestionsApprovedFirst(candidates, requiredQuestions)
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate] as const))
  return { selection, questions: selection.selectedIds.map((id) => byId.get(id)).filter((item): item is UnitExamBankItem => Boolean(item)) }
}

async function loadScopedQuestions(programId: string, unitId: string, requiredQuestions: number): Promise<ScopedQuestionResult> {
  const approvedOnly = selectItems(await unitQuestionCandidates(programId, unitId, requiredQuestions, false), requiredQuestions)
  if (approvedOnly.selection.readyToBuild && approvedOnly.selection.publishable) return { questions: approvedOnly.questions, selection: approvedOnly.selection, requiredQuestions }
  const mixed = selectItems(await unitQuestionCandidates(programId, unitId, requiredQuestions, true), requiredQuestions)
  return { questions: mixed.questions, selection: mixed.selection, requiredQuestions }
}

async function queueQuestionBankJob(programId: string, unitId: string, requiredQuestions: number) {
  const job = await ensureQuestionBankGenerationJob({ programId, unitId, requested: requiredQuestions, startNew: false, manual: true })
  after(() => runQuestionBankGenerationJobStepsUntil(job.id, { budgetMs: 260_000 }).catch((error) => console.error('unit question bank after() runner failed:', error)))
  return job
}

// POST /api/admin/unit-exams/generate
// body: { programId, unitId, count?, replace? }
export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = bodyRecord(await req.json().catch(() => ({})))
    const programId = cleanText(body.programId, 80)
    const unitId = cleanText(body.unitId, 80)
    const requiredQuestions = unitExamRequiredQuestions(body.count)
    const replace = body.replace !== false

    if (!programId || !unitId) return NextResponse.json({ ok: false, error: 'معرف البرنامج والوحدة مطلوبان' }, { status: 400 })
    const unit = await db.unit.findFirst({ where: { id: unitId, programId }, include: { exam: { select: { id: true, title: true, status: true, _count: { select: { questions: true, attempts: true } } } } } })
    if (!unit) return NextResponse.json({ ok: false, error: 'الوحدة غير موجودة ضمن البرنامج المحدد' }, { status: 404 })
    if (unit.exam?._count.attempts && replace) return NextResponse.json({ ok: false, error: 'لا يمكن إعادة توليد اختبار وحدة لديه محاولات طلابية محفوظة. أنشئ وحدة/اختباراً جديداً بدلاً من مسح سجل الطلاب.' }, { status: 409 })

    const scoped = await loadScopedQuestions(programId, unitId, requiredQuestions)
    if (!scoped.selection.readyToBuild) {
      const job = await queueQuestionBankJob(programId, unitId, requiredQuestions)
      return NextResponse.json({
        ok: false,
        status: job.status,
        jobId: job.id,
        saved: job.saved,
        requested: job.requested,
        currentQuestions: scoped.selection.currentEligibleCount,
        approvedQuestions: scoped.selection.approvedCount,
        pendingReviewQuestions: scoped.selection.pendingReviewCount,
        requiredQuestions,
        error: `جارٍ تجهيز بنك الأسئلة: ${scoped.selection.currentEligibleCount} من ${requiredQuestions}`,
      }, { status: 202 })
    }

    const reviewRequired = scoped.selection.pendingReviewCount > 0
    const examStatus = reviewRequired ? 'DRAFT' : 'READY'
    const examQuestions = scoped.questions.map((item, index) => toExamQuestion(item, index, item.status !== 'APPROVED'))

    const result = await db.$transaction(async (tx) => {
      const exam = unit.exam
        ? await tx.exam.update({ where: { id: unit.exam.id }, data: { title: `${reviewRequired ? `[${UNIT_EXAM_REVIEW_LABEL}] ` : ''}اختبار وحدة: ${unit.title}`, status: examStatus, passScore: 60 } })
        : await tx.exam.create({ data: { unitId: unit.id, title: `${reviewRequired ? `[${UNIT_EXAM_REVIEW_LABEL}] ` : ''}اختبار وحدة: ${unit.title}`, status: examStatus, passScore: 60 } })
      if (replace) {
        await tx.examDraft.deleteMany({ where: { examId: exam.id, examType: 'UNIT' } })
        await tx.question.deleteMany({ where: { examId: exam.id } })
      }
      const existingCount = replace ? 0 : await tx.question.count({ where: { examId: exam.id } })
      for (const [index, question] of examQuestions.entries()) await tx.question.create({ data: { examId: exam.id, ...question, order: existingCount + index + 1 } })
      await tx.questionBankItem.updateMany({ where: { id: { in: scoped.questions.map((item) => item.id) } }, data: { usageCount: { increment: 1 } } })
      await tx.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
      return tx.exam.findUnique({ where: { id: exam.id }, select: { id: true, title: true, status: true, passScore: true, _count: { select: { questions: true, attempts: true } } } })
    })

    return NextResponse.json({
      ok: true,
      exam: result,
      reviewRequired,
      currentQuestions: scoped.selection.currentEligibleCount,
      requiredQuestions,
      pendingReviewQuestions: scoped.selection.pendingReviewCount,
      sourceGroundedRatio: scoped.selection.approvedCount / scoped.questions.length,
      message: reviewRequired ? 'تم حفظ اختبار الوحدة كمسودة لأنه يحتوي أسئلة تحتاج مراجعة. لن يظهر للطلاب حتى تعتمد الأسئلة.' : 'تم توليد اختبار الوحدة من أسئلة معتمدة وموثقة ضمن نطاق الوحدة.',
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('unit exam generator error:', error)
    return NextResponse.json({ ok: false, error: 'تعذر توليد اختبار الوحدة' }, { status: 500 })
  }
}
