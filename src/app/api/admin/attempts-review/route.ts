import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { gradeEssayWithRubric } from '@/lib/essay-grading'
import { calculateSemesterReadiness } from '@/lib/semester-readiness'

export const runtime = 'nodejs'
export const maxDuration = 300

type AttemptType = 'UNIT' | 'PROGRAM'
type ReviewReadiness = Awaited<ReturnType<typeof calculateSemesterReadiness>> | null

function clean(value: unknown, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function manualPoints(value: unknown, max: number): number | null {
  if (value == null || String(value).trim() === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(Math.max(0, max), n))
}

function apiError(code: string, message: string, status = 400) {
  const error: any = new Error(code)
  error.code = code
  error.userMessage = message
  error.status = status
  return error
}

function sourceFromMap(map: Map<string, string>, knowledgeItemId?: string | null, fallback?: string | null) {
  if (knowledgeItemId && map.get(knowledgeItemId)) return map.get(knowledgeItemId)!.slice(0, 3000)
  return clean(fallback, 3000)
}

async function buildExcerptMap(ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (!unique.length) return new Map<string, string>()
  const rows = await db.bookKnowledgeItem.findMany({ where: { id: { in: unique } }, select: { id: true, excerpt: true } })
  return new Map(rows.map((row) => [row.id, row.excerpt || ''] as const))
}

async function listReviewAttempts() {
  const [unitAttempts, programAttempts] = await Promise.all([
    db.examAttempt.findMany({
      where: { status: 'NEEDS_REVIEW' },
      orderBy: { submittedAt: 'desc' },
      take: 100,
      select: { id: true, submittedAt: true, user: { select: { id: true, name: true, email: true } }, exam: { select: { id: true, title: true, unit: { select: { title: true, program: { select: { titleAr: true } } } } } } },
    }),
    db.programExamAttempt.findMany({
      where: { status: 'NEEDS_REVIEW' },
      orderBy: { submittedAt: 'desc' },
      take: 100,
      select: { id: true, submittedAt: true, user: { select: { id: true, name: true, email: true } }, exam: { select: { id: true, title: true, program: { select: { titleAr: true } } } } },
    }),
  ])
  return [
    ...unitAttempts.map((a) => ({ type: 'UNIT', id: a.id, submittedAt: a.submittedAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, programTitle: a.exam.unit.program.titleAr, unitTitle: a.exam.unit.title } })),
    ...programAttempts.map((a) => ({ type: 'PROGRAM', id: a.id, submittedAt: a.submittedAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, programTitle: a.exam.program.titleAr } })),
  ].sort((a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime())
}

async function unitDetail(id: string) {
  const attempt = await db.examAttempt.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } }, exam: { include: { unit: { include: { program: { select: { titleAr: true } } } } } }, answers: { include: { question: true }, orderBy: { question: { order: 'asc' } } } },
  })
  if (!attempt) return null
  const excerptById = await buildExcerptMap(attempt.answers.map((a) => a.question.knowledgeItemId))
  const rows = attempt.answers.filter((a) => ['ESSAY', 'SHORT'].includes(a.question.type)).map((a) => ({
    answerId: a.id,
    questionId: a.questionId,
    order: a.question.order,
    question: a.question.text,
    studentAnswer: a.answerText || '',
    modelAnswer: a.question.modelAnswer || '',
    source: sourceFromMap(excerptById, a.question.knowledgeItemId, a.question.sourceEvidence),
    rubric: a.question.rubric || null,
    points: a.points,
    maxPoints: a.maxPoints || a.question.points,
    aiFeedback: a.aiFeedback,
  }))
  return { type: 'UNIT', id: attempt.id, status: attempt.status, student: attempt.user, exam: { id: attempt.exam.id, title: attempt.exam.title, unitTitle: attempt.exam.unit.title, programTitle: attempt.exam.unit.program.titleAr, passScore: attempt.exam.passScore }, answers: rows }
}

async function programDetail(id: string) {
  const attempt = await db.programExamAttempt.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } }, exam: { include: { program: { select: { titleAr: true } } } }, answers: { include: { question: true }, orderBy: { question: { order: 'asc' } } } },
  })
  if (!attempt) return null
  const excerptById = await buildExcerptMap(attempt.answers.map((a) => a.question.knowledgeItemId))
  const rows = attempt.answers.filter((a) => ['ESSAY', 'SHORT'].includes(a.question.type)).map((a) => ({
    answerId: a.id,
    questionId: a.questionId,
    order: a.question.order,
    question: a.question.text,
    studentAnswer: a.answerText || '',
    modelAnswer: a.question.modelAnswer || '',
    source: sourceFromMap(excerptById, a.question.knowledgeItemId, a.question.sourceEvidence),
    rubric: a.question.rubric || null,
    points: a.points,
    maxPoints: a.maxPoints || a.question.points,
    aiFeedback: a.aiFeedback,
  }))
  return { type: 'PROGRAM', id: attempt.id, status: attempt.status, student: attempt.user, exam: { id: attempt.exam.id, title: attempt.exam.title, programTitle: attempt.exam.program.titleAr, passScore: attempt.exam.passScore }, answers: rows }
}

async function readinessForProgramAttempt(attemptId: string): Promise<ReviewReadiness> {
  const attempt = await db.programExamAttempt.findUnique({ where: { id: attemptId }, select: { userId: true, exam: { select: { programId: true, semester: true } } } })
  if (!attempt) return null
  return calculateSemesterReadiness(attempt.userId, attempt.exam.programId, attempt.exam.semester)
}

async function ensureNeedsReview(tx: any, type: AttemptType, attemptId: string) {
  const table = type === 'UNIT' ? tx.examAttempt : tx.programExamAttempt
  const guarded = await table.updateMany({ where: { id: attemptId, status: 'NEEDS_REVIEW' }, data: { status: 'NEEDS_REVIEW' } })
  if (guarded.count === 0) throw apiError('ATTEMPT_ALREADY_APPROVED', 'تم اعتماد هذه المحاولة مسبقاً', 409)
}

async function ensureNoNullOpenAnswers(tx: any, type: AttemptType, attemptId: string) {
  const rows = type === 'UNIT'
    ? await tx.answer.findMany({ where: { attemptId, question: { type: { in: ['ESSAY', 'SHORT'] } } }, select: { id: true, points: true } })
    : await tx.programAnswer.findMany({ where: { attemptId, question: { type: { in: ['ESSAY', 'SHORT'] } } }, select: { id: true, points: true } })
  if (rows.some((row: any) => row.points == null)) throw apiError('OPEN_ANSWER_POINTS_REQUIRED', 'لا يمكن اعتماد النتيجة قبل تحديد نقاط كل سؤال مقالي/قصير', 400)
}

async function ensureManualAnswerIdsBelongToAttempt(tx: any, type: AttemptType, attemptId: string, answerIds: string[]) {
  if (!answerIds.length) return
  const rows = type === 'UNIT'
    ? await tx.answer.findMany({ where: { id: { in: answerIds }, attemptId }, select: { id: true } })
    : await tx.programAnswer.findMany({ where: { id: { in: answerIds }, attemptId }, select: { id: true } })
  if (rows.length !== answerIds.length) throw apiError('ANSWER_NOT_IN_ATTEMPT', 'يوجد answerId لا يتبع هذه المحاولة', 400)
}

async function recomputeUnitAttempt(tx: any, attemptId: string) {
  const attempt = await tx.examAttempt.findUnique({ where: { id: attemptId }, include: { exam: { include: { questions: true } }, answers: true } })
  const maxTotal = attempt.exam.questions.reduce((s: number, q: any) => s + q.points, 0)
  const total = attempt.answers.reduce((s: number, a: any) => s + Number(a.points || 0), 0)
  const score = maxTotal > 0 ? Math.round((total / maxTotal) * 1000) / 10 : 0
  const passed = score >= attempt.exam.passScore
  await tx.examAttempt.update({ where: { id: attemptId }, data: { score, passed, status: 'GRADED', aiGraded: true, feedback: JSON.stringify({ summary: 'تم اعتماد النتيجة بعد مراجعة التصحيح.' }) } })
  return { score, passed }
}

async function recomputeProgramAttempt(tx: any, attemptId: string, readiness: ReviewReadiness) {
  const attempt = await tx.programExamAttempt.findUnique({ where: { id: attemptId }, include: { exam: { include: { questions: true } }, answers: true } })
  const maxTotal = attempt.exam.questions.reduce((s: number, q: any) => s + q.points, 0)
  const total = attempt.answers.reduce((s: number, a: any) => s + Number(a.points || 0), 0)
  const rawScore = maxTotal > 0 ? (total / maxTotal) * 100 : 0
  const capped = Math.min(rawScore, readiness?.maxExamScore ?? 100)
  const score = Math.round(capped * 10) / 10
  const rawRounded = Math.round(rawScore * 10) / 10
  const passed = score >= attempt.exam.passScore
  await tx.programExamAttempt.update({ where: { id: attemptId }, data: { score, finalScore: score, passed, status: 'GRADED', feedback: JSON.stringify({ summary: 'تم اعتماد النتيجة بعد مراجعة التصحيح.', rawScoreBeforeCourseworkCap: rawRounded, maxExamScore: readiness?.maxExamScore ?? 100, readiness }), submittedAt: new Date() } })
  return { score, passed }
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const type = clean(req.nextUrl.searchParams.get('type'), 20) as AttemptType | ''
    const id = clean(req.nextUrl.searchParams.get('id'), 100)
    if (id && type === 'UNIT') return NextResponse.json({ attempt: await unitDetail(id) })
    if (id && type === 'PROGRAM') return NextResponse.json({ attempt: await programDetail(id) })
    return NextResponse.json({ attempts: await listReviewAttempts() })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('attempts-review GET error:', error)
    return NextResponse.json({ error: 'تعذر تحميل محاولات المراجعة' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json()
    const type = clean(body?.type, 20) as AttemptType
    const id = clean(body?.attemptId, 100)
    const detail = type === 'UNIT' ? await unitDetail(id) : await programDetail(id)
    if (!detail) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    if (detail.status !== 'NEEDS_REVIEW') return NextResponse.json({ error: 'تم اعتماد هذه المحاولة مسبقاً' }, { status: 409 })
    const readiness = type === 'PROGRAM' ? await readinessForProgramAttempt(id) : null
    const graded: Array<{ answerId: string; points: number; feedback: string }> = []
    for (const answer of detail.answers) {
      const result = await gradeEssayWithRubric({ question: answer.question, modelAnswer: answer.modelAnswer, rubric: answer.rubric, sourceExcerpt: answer.source, studentAnswer: answer.studentAnswer, maxPoints: answer.maxPoints, deadlineMs: Date.now() + 45_000 })
      graded.push({ answerId: answer.answerId, points: result.points, feedback: JSON.stringify(result) })
    }
    const result = await db.$transaction(async (tx) => {
      await ensureNeedsReview(tx, type, id)
      for (const item of graded) {
        if (type === 'UNIT') await tx.answer.update({ where: { id: item.answerId }, data: { points: item.points, isCorrect: item.points > 0 ? null : false, aiFeedback: item.feedback } })
        else await tx.programAnswer.update({ where: { id: item.answerId }, data: { points: item.points, isCorrect: item.points > 0 ? null : false, aiFeedback: item.feedback } })
      }
      await ensureNoNullOpenAnswers(tx, type, id)
      return type === 'UNIT' ? recomputeUnitAttempt(tx, id) : recomputeProgramAttempt(tx, id, readiness)
    }, { timeout: 120000, maxWait: 10000 })
    return NextResponse.json({ ok: true, ...result })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (error?.code) return NextResponse.json({ error: error.userMessage || String(error.message || error) }, { status: error.status || 400 })
    console.error('attempts-review POST error:', error)
    return NextResponse.json({ error: 'تعذر إعادة التصحيح الآلي' }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json()
    const type = clean(body?.type, 20) as AttemptType
    const id = clean(body?.attemptId, 100)
    const scores = body?.scores && typeof body.scores === 'object' ? body.scores as Record<string, unknown> : {}
    const answerIds = Object.keys(scores).map((answerId) => clean(answerId, 120)).filter(Boolean)
    const readiness = type === 'PROGRAM' ? await readinessForProgramAttempt(id) : null
    const result = await db.$transaction(async (tx) => {
      await ensureNeedsReview(tx, type, id)
      await ensureManualAnswerIdsBelongToAttempt(tx, type, id, answerIds)
      for (const [answerId, score] of Object.entries(scores)) {
        if (type === 'UNIT') {
          const answer = await tx.answer.findUnique({ where: { id: answerId }, select: { maxPoints: true } })
          if (answer) {
            const points = manualPoints(score, answer.maxPoints || 0)
            await tx.answer.update({ where: { id: answerId }, data: { points, isCorrect: points == null ? null : points > 0 ? null : false, aiFeedback: 'تم تعديل الدرجة يدوياً من الإدارة.' } })
          }
        } else {
          const answer = await tx.programAnswer.findUnique({ where: { id: answerId }, select: { maxPoints: true } })
          if (answer) {
            const points = manualPoints(score, answer.maxPoints || 0)
            await tx.programAnswer.update({ where: { id: answerId }, data: { points, isCorrect: points == null ? null : points > 0 ? null : false, aiFeedback: 'تم تعديل الدرجة يدوياً من الإدارة.' } })
          }
        }
      }
      await ensureNoNullOpenAnswers(tx, type, id)
      return type === 'UNIT' ? recomputeUnitAttempt(tx, id) : recomputeProgramAttempt(tx, id, readiness)
    }, { timeout: 120000, maxWait: 10000 })
    return NextResponse.json({ ok: true, ...result })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (error?.code) return NextResponse.json({ error: error.userMessage || String(error.message || error) }, { status: error.status || 400 })
    console.error('attempts-review PATCH error:', error)
    return NextResponse.json({ error: 'تعذر اعتماد نتيجة المراجعة' }, { status: 500 })
  }
}
