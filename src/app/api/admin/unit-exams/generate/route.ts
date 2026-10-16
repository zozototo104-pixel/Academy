import { after, NextRequest, NextResponse } from 'next/server'
import type { QuestionBankItem } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { getSetting } from '@/lib/settings'
import { cognitivePolicyArabicMessage, validateCognitiveDistribution } from '@/lib/exam-cognitive-policy'
import { ensureQuestionBankGenerationJob, runQuestionBankGenerationJobStepsUntil } from '@/lib/question-bank-job'
import { UNIT_EXAM_REVIEW_LABEL, selectUnitExamQuestionsApprovedFirst, unitExamQuestionTextWithReviewLabel, unitExamRequiredQuestions, type UnitExamSelection } from '@/lib/unit-exam-policy'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

type UnitExamBankItem = Pick<QuestionBankItem, 'id' | 'status' | 'type' | 'text' | 'options' | 'correctAnswer' | 'modelAnswer' | 'knowledgeItemId' | 'sourceEvidence' | 'rubric' | 'correctRationale' | 'qualityFlags' | 'cognitiveSkill' | 'usageCount' | 'createdAt'>
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

function sourceFields(item: UnitExamBankItem) {
  return { knowledgeItemId: item.knowledgeItemId || null, sourceEvidence: item.sourceEvidence || null, rubric: item.rubric || null }
}

function toExamQuestion(item: UnitExamBankItem, index: number, needsReview: boolean) {
  const type = String(item.type || 'MCQ').toUpperCase()
  const text = unitExamQuestionTextWithReviewLabel(item.text, needsReview)
  if (type === 'MCQ') {
    const shuffled = shuffleWithAnswer(parseStringArray(item.options), item.correctAnswer)
    return { order: index + 1, type: 'MCQ', text: cleanText(text, 1200), options: JSON.stringify(shuffled.options), correctAnswer: shuffled.correctAnswer, modelAnswer: cleanText(item.modelAnswer || item.correctRationale || item.sourceEvidence, 1800), points: 10, ...sourceFields(item) }
  }
  if (type === 'TF') {
    const answerText = cleanText(item.correctAnswer, 20)
    const correctAnswer = answerText === '1' || /^خطأ|false$/iu.test(answerText) ? '1' : '0'
    return { order: index + 1, type: 'TF', text: cleanText(text, 1200), options: JSON.stringify(['صح', 'خطأ']), correctAnswer, modelAnswer: cleanText(item.modelAnswer || item.correctRationale || item.sourceEvidence, 1800), points: 10, ...sourceFields(item) }
  }
  return { order: index + 1, type: type === 'ESSAY' ? 'ESSAY' : 'SHORT', text: cleanText(text, 1200), options: JSON.stringify([]), correctAnswer: null, modelAnswer: cleanText(item.modelAnswer || item.sourceEvidence, 1800), points: 10, ...sourceFields(item) }
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
  const approvedAndPending = await unitQuestionCandidates(programId, unitId, requiredQuestions, true)
  const approvedOnly = selectItems(approvedAndPending, requiredQuestions)
  return { questions: approvedOnly.questions, selection: approvedOnly.selection, requiredQuestions }
}

async function queueQuestionBankJob(programId: string, unitId: string, requiredQuestions: number) {
  const job = await ensureQuestionBankGenerationJob({ programId, unitId, requested: requiredQuestions, startNew: false, manual: true })
  after(() => runQuestionBankGenerationJobStepsUntil(job.id, { budgetMs: 260_000 }).catch((error) => console.error('unit question bank after() runner failed:', error)))
  return job
}

async function unitKnowledgeAvailability(programId: string, unit: any) {
  const minRaw = await getSetting('UNIT_MIN_KNOWLEDGE_ITEMS').catch(() => process.env.UNIT_MIN_KNOWLEDGE_ITEMS || '15')
  const minItems = Math.max(1, Number(minRaw || 15) || 15)
  const where: any = { programId }

  if (unit?.sourceBookId) {
    where.bookId = unit.sourceBookId
    if (Number.isFinite(Number(unit.chunkStartIndex)) && Number.isFinite(Number(unit.chunkEndIndex))) {
      const chunks = await db.bookChunk.findMany({
        where: { bookId: unit.sourceBookId, index: { gte: Number(unit.chunkStartIndex), lte: Number(unit.chunkEndIndex) } },
        select: { id: true },
      }).catch(() => [])
      const chunkIds = chunks.map((chunk) => chunk.id)
      if (chunkIds.length) where.chunkId = { in: chunkIds }
    } else if (Number.isFinite(Number(unit.semester))) {
      where.semester = Number(unit.semester)
    }
  } else if (Number.isFinite(Number(unit.semester))) {
    where.semester = Number(unit.semester)
  }

  // BookKnowledgeItem does not have a review status column; persisted items are treated as the approved/equivalent knowledge source.
  const count = await db.bookKnowledgeItem.count({ where }).catch(() => 0)
  return { count, minItems, limited: count < minItems }
}

function limitedKnowledgeQuestionCount(requested: number, available: number, minimum: number) {
  if (available >= minimum) return requested
  const ratio = Math.max(0, available) / Math.max(1, minimum)
  return Math.max(5, Math.min(requested, Math.floor(requested * ratio)))
}

// POST /api/admin/unit-exams/generate
// body: { programId, unitId, count?, replace? }
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = bodyRecord(await req.json().catch(() => ({})))
    const programId = cleanText(body.programId, 80)
    const unitId = cleanText(body.unitId, 80)
    const requestedQuestions = unitExamRequiredQuestions(body.count)
    const replace = body.replace !== false
    const overrideCognitivePolicy = body.overrideCognitivePolicy === true
    const overrideReason = cleanText(body.overrideReason, 1000)

    if (!programId || !unitId) return NextResponse.json({ ok: false, error: 'معرف البرنامج والوحدة مطلوبان' }, { status: 400 })
    const unit = await db.unit.findFirst({ where: { id: unitId, programId }, include: { exam: { select: { id: true, title: true, status: true, _count: { select: { questions: true, attempts: true } } } } } })
    if (!unit) return NextResponse.json({ ok: false, error: 'الوحدة غير موجودة ضمن البرنامج المحدد' }, { status: 404 })
    if (unit.exam?._count.attempts && replace) return NextResponse.json({ ok: false, error: 'لا يمكن إعادة توليد اختبار وحدة لديه محاولات طلابية محفوظة. أنشئ وحدة/اختباراً جديداً بدلاً من مسح سجل الطلاب.' }, { status: 409 })

    const knowledge = await unitKnowledgeAvailability(programId, unit)
    const limitedKnowledge = knowledge.limited
    const requiredQuestions = limitedKnowledge ? limitedKnowledgeQuestionCount(requestedQuestions, knowledge.count, knowledge.minItems) : requestedQuestions

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
        requestedQuestions,
        requiredQuestions,
        warning: limitedKnowledge ? 'LIMITED_KNOWLEDGE' : null,
        knowledgeItems: knowledge.count,
        minKnowledgeItems: knowledge.minItems,
        error: `لا يكفي عدد الأسئلة المعتمدة: ${scoped.selection.currentEligibleCount} من ${requiredQuestions}. في ${scoped.selection.pendingReviewCount} أسئلة بانتظار المراجعة.`,
      }, { status: 202 })
    }

    const cognitive = validateCognitiveDistribution(scoped.questions, 'UNIT')
    if (!cognitive.ok) {
      if (!overrideCognitivePolicy || overrideReason.length < 8) {
        return NextResponse.json(
          { ok: false, error: cognitivePolicyArabicMessage(cognitive), details: cognitive.details, code: 'COGNITIVE_DISTRIBUTION_FAILED' },
          { status: 409 }
        )
      }
      await audit({ id: admin.id, name: admin.name }, 'OVERRIDE_UNIT_COGNITIVE_DISTRIBUTION', 'Unit', unitId, `${overrideReason} — ${cognitive.details.join(' | ')}`)
    }

    const reviewRequired = false
    const examStatus = reviewRequired ? 'DRAFT' : 'READY'
    const generationWarning = limitedKnowledge ? 'LIMITED_KNOWLEDGE' : null
    const examQuestions = scoped.questions.map((item, index) => toExamQuestion(item, index, reviewRequired))

    const result = await db.$transaction(async (tx) => {
      const exam = unit.exam
        ? await tx.exam.update({ where: { id: unit.exam.id }, data: { title: `${reviewRequired ? `[${UNIT_EXAM_REVIEW_LABEL}] ` : ''}اختبار وحدة: ${unit.title}`, status: examStatus, passScore: 60, generationWarning } })
        : await tx.exam.create({ data: { unitId: unit.id, title: `${reviewRequired ? `[${UNIT_EXAM_REVIEW_LABEL}] ` : ''}اختبار وحدة: ${unit.title}`, status: examStatus, passScore: 60, generationWarning } })
      if (replace) {
        await tx.examDraft.deleteMany({ where: { examId: exam.id, examType: 'UNIT' } })
        await tx.question.deleteMany({ where: { examId: exam.id } })
      }
      const existingCount = replace ? 0 : await tx.question.count({ where: { examId: exam.id } })
      for (const [index, question] of examQuestions.entries()) await tx.question.create({ data: { examId: exam.id, ...question, order: existingCount + index + 1 } })
      await tx.questionBankItem.updateMany({ where: { id: { in: scoped.questions.map((item) => item.id) } }, data: { usageCount: { increment: 1 } } })
      await tx.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
      return tx.exam.findUnique({ where: { id: exam.id }, select: { id: true, title: true, status: true, passScore: true, generationWarning: true, _count: { select: { questions: true, attempts: true } } } })
    })

    if (limitedKnowledge) {
      await audit({ id: admin.id, name: admin.name }, 'LIMITED_UNIT_KNOWLEDGE_EXAM', 'Unit', unitId, `LIMITED_KNOWLEDGE: ${knowledge.count}/${knowledge.minItems}; requested ${requestedQuestions}, generated ${requiredQuestions}`)
    }

    return NextResponse.json({
      ok: true,
      exam: result,
      reviewRequired,
      currentQuestions: scoped.selection.currentEligibleCount,
      requestedQuestions,
      requiredQuestions,
      warning: limitedKnowledge ? 'LIMITED_KNOWLEDGE' : null,
      knowledgeItems: knowledge.count,
      minKnowledgeItems: knowledge.minItems,
      pendingReviewQuestions: scoped.selection.pendingReviewCount,
      sourceGroundedRatio: scoped.questions.length ? scoped.selection.approvedCount / scoped.questions.length : 0,
      message: reviewRequired ? 'تم حفظ اختبار الوحدة كمسودة لأنه يحتوي أسئلة تحتاج مراجعة. لن يظهر للطلاب حتى تعتمد الأسئلة.' : 'تم توليد اختبار الوحدة من أسئلة معتمدة وموثقة ضمن نطاق الوحدة.',
    })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('unit exam generator error:', error)
    return NextResponse.json({ ok: false, error: 'تعذر توليد اختبار الوحدة' }, { status: 500 })
  }
}
