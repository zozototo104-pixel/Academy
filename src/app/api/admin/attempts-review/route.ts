import { NextRequest, NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { EssayNeedsReviewError, gradeEssayWithRubric } from '@/lib/essay-grading'
import { buildEssaySourceMap } from '@/lib/essay-source'
import { notifyStudentReviewResolved } from '@/lib/exam-attempt-notifications'
import { calculateSemesterReadiness } from '@/lib/semester-readiness'
import { registerGraduationRequest } from '@/lib/enrollment-completion'
import { findDuplicateAnswerQuestionIds, findMissingAnswerQuestionIds, findUngradedAnswers, sumRequiredAnswerPoints, gradeObjectiveAnswer, parseObjectiveIndex, parseObjectiveOptions } from '@/lib/answer-completeness'

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
  // No prefix cut: relevance selection inside the grader works from the
  // full stored book text, so a correct answer near the end of a long
  // chunk still reaches it.
  if (knowledgeItemId && map.get(knowledgeItemId)) return map.get(knowledgeItemId)!
  return clean(fallback, 8000)
}

// مصدر إعادة التصحيح هو مصدر التصحيح نفسه: نص مقطع الكتاب المخزّن يقود،
// لا الاقتباس القصير وحده — البنك قد يلتقط جزءًا فقط مما يقوله الكتاب.
async function buildExcerptMap(ids: Array<string | null | undefined>) {
  return buildEssaySourceMap(ids)
}

// Attempts claimed (SUBMITTED) whose grading never finished and never
// flipped to NEEDS_REVIEW are invisible in every queue. Surface the stale
// ones (older than 30 minutes) alongside the review list so an admin can
// find them instead of depending on the student returning to the exam.
const STUCK_SUBMITTED_MS = 30 * 60 * 1000

async function listReviewAttempts(statusFilter: string = 'NEEDS_REVIEW') {
  const statuses = statusFilter === 'ALL' ? ['NEEDS_REVIEW', 'GRADED'] : statusFilter === 'GRADED' ? ['GRADED'] : ['NEEDS_REVIEW']
  const [unitAttempts, programAttempts] = await Promise.all([
    db.examAttempt.findMany({
      where: { status: { in: statuses as any } },
      orderBy: { submittedAt: 'desc' },
      take: 100,
      select: { id: true, status: true, score: true, submittedAt: true, user: { select: { id: true, name: true, email: true } }, exam: { select: { id: true, title: true, unit: { select: { title: true, program: { select: { titleAr: true } } } } } } },
    }),
    db.programExamAttempt.findMany({
      where: { status: { in: statuses as any } },
      orderBy: { submittedAt: 'desc' },
      take: 100,
      select: { id: true, status: true, score: true, submittedAt: true, user: { select: { id: true, name: true, email: true } }, exam: { select: { id: true, title: true, program: { select: { titleAr: true } } } } },
    }),
  ])
  let stuckUnit: Array<any> = []
  let stuckProgram: Array<any> = []
  if (statusFilter !== 'GRADED') {
    const stuckBefore = new Date(Date.now() - STUCK_SUBMITTED_MS)
    ;[stuckUnit, stuckProgram] = await Promise.all([
      db.examAttempt.findMany({
        where: { status: 'SUBMITTED', submittedAt: { lt: stuckBefore } },
        orderBy: { submittedAt: 'desc' },
        take: 100,
        select: { id: true, status: true, score: true, submittedAt: true, user: { select: { id: true, name: true, email: true } }, exam: { select: { id: true, title: true, unit: { select: { title: true, program: { select: { titleAr: true } } } } } } },
      }),
      db.programExamAttempt.findMany({
        where: { status: 'SUBMITTED', OR: [{ submittedAt: { lt: stuckBefore } }, { submittedAt: null, createdAt: { lt: stuckBefore } }] },
        orderBy: { submittedAt: 'desc' },
        take: 100,
        select: { id: true, status: true, score: true, submittedAt: true, createdAt: true, user: { select: { id: true, name: true, email: true } }, exam: { select: { id: true, title: true, program: { select: { titleAr: true } } } } },
      }),
    ])
  }
  const rows: Array<any> = [
    ...unitAttempts.map((a) => ({ type: 'UNIT', id: a.id, status: a.status, score: (a as any).score ?? null, submittedAt: a.submittedAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, programTitle: a.exam.unit.program.titleAr, unitTitle: a.exam.unit.title } })),
    ...programAttempts.map((a) => ({ type: 'PROGRAM', id: a.id, status: a.status, score: (a as any).score ?? null, submittedAt: a.submittedAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, programTitle: a.exam.program.titleAr } })),
    ...stuckUnit.map((a) => ({ type: 'UNIT', id: a.id, status: a.status, score: (a as any).score ?? null, stuck: true, submittedAt: a.submittedAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, programTitle: a.exam.unit.program.titleAr, unitTitle: a.exam.unit.title } })),
    ...stuckProgram.map((a) => ({ type: 'PROGRAM', id: a.id, status: a.status, score: (a as any).score ?? null, stuck: true, submittedAt: a.submittedAt ?? a.createdAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, programTitle: a.exam.program.titleAr } })),
  ].sort((a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime())
  // حالة المصادقة الرسمية لكل درجة نهائية — من سجلات المصادقة المخزونة
  // وبنفس قاعدة الصلاحية (المساواة مع الدرجة الحالية). دفعة واحدة لكل
  // القائمة، ودفاعي: أي فشل يترك الحالة غير معروفة ولا يُسقط القائمة.
  try {
    const gradedIds = rows.filter((r) => r.status === 'GRADED').map((r) => r.id)
    if (gradedIds.length) {
      const approvals = await db.gradeApproval.findMany({
        where: { attemptId: { in: gradedIds } },
        select: { targetType: true, attemptId: true, score: true },
      })
      const approvedScore = new Map(approvals.map((a) => [`${a.targetType}:${a.attemptId}`, a.score]))
      for (const r of rows) {
        if (r.status !== 'GRADED') { r.approvalState = null; continue }
        const key = `${r.type === 'UNIT' ? 'UNIT_EXAM' : 'PROGRAM_EXAM'}:${r.id}`
        r.approvalState = !approvedScore.has(key) ? 'NONE' : approvedScore.get(key) === r.score ? 'APPROVED' : 'STALE'
      }
    }
  } catch { /* approvalState stays unset — the list still renders */ }
  return rows
}

async function unitDetail(id: string) {
  const attempt = await db.examAttempt.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } }, exam: { include: { unit: { include: { program: { select: { titleAr: true } } } } } }, answers: { include: { question: true }, orderBy: { question: { order: 'asc' } } } },
  })
  if (!attempt) return null
  const excerptById = await buildExcerptMap(attempt.answers.map((a) => a.question.knowledgeItemId))
  const rows = attempt.answers.map((a) => {
    // The review screen covers EVERY question type, not only open ones:
    // an ungraded objective answer blocks approval, so the admin must be
    // able to see it here (its key, the student's pick) and regrade it.
    const isObjective = a.question.type === 'MCQ' || a.question.type === 'TF'
    const options = isObjective ? parseObjectiveOptions(a.question.options) : []
    const correctIndex = isObjective ? parseObjectiveIndex(a.question.correctAnswer) : null
    const correctAnswerText = isObjective && correctIndex !== null ? options[correctIndex] || '' : ''
    return {
      answerId: a.id,
      questionId: a.questionId,
      order: a.question.order,
      questionType: a.question.type,
      question: a.question.text,
      studentAnswer: isObjective
        ? (a.selectedOption !== null && a.selectedOption !== undefined && options[a.selectedOption] ? options[a.selectedOption] : '(لم يجب)')
        : (a.answerText || ''),
      modelAnswer: isObjective ? correctAnswerText : (a.question.modelAnswer || ''),
      source: isObjective ? '' : sourceFromMap(excerptById, a.question.knowledgeItemId, a.question.sourceEvidence),
      rubric: a.question.rubric || null,
      optionsRaw: a.question.options ?? null,
      correctAnswer: a.question.correctAnswer ?? null,
      selectedOption: a.selectedOption ?? null,
      isCorrect: a.isCorrect ?? null,
      points: a.points,
      maxPoints: a.maxPoints || a.question.points,
      aiFeedback: a.aiFeedback,
    }
  })
  return { type: 'UNIT', id: attempt.id, status: attempt.status, student: attempt.user, exam: { id: attempt.exam.id, title: attempt.exam.title, unitTitle: attempt.exam.unit.title, programTitle: attempt.exam.unit.program.titleAr, passScore: attempt.exam.passScore }, answers: rows }
}

async function programDetail(id: string) {
  const attempt = await db.programExamAttempt.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } }, exam: { include: { program: { select: { titleAr: true } } } }, answers: { include: { question: true }, orderBy: { question: { order: 'asc' } } } },
  })
  if (!attempt) return null
  const excerptById = await buildExcerptMap(attempt.answers.map((a) => a.question.knowledgeItemId))
  const rows = attempt.answers.map((a) => {
    // The review screen covers EVERY question type, not only open ones:
    // an ungraded objective answer blocks approval, so the admin must be
    // able to see it here (its key, the student's pick) and regrade it.
    const isObjective = a.question.type === 'MCQ' || a.question.type === 'TF'
    const options = isObjective ? parseObjectiveOptions(a.question.options) : []
    const correctIndex = isObjective ? parseObjectiveIndex(a.question.correctAnswer) : null
    const correctAnswerText = isObjective && correctIndex !== null ? options[correctIndex] || '' : ''
    return {
      answerId: a.id,
      questionId: a.questionId,
      order: a.question.order,
      questionType: a.question.type,
      question: a.question.text,
      studentAnswer: isObjective
        ? (a.selectedOption !== null && a.selectedOption !== undefined && options[a.selectedOption] ? options[a.selectedOption] : '(لم يجب)')
        : (a.answerText || ''),
      modelAnswer: isObjective ? correctAnswerText : (a.question.modelAnswer || ''),
      source: isObjective ? '' : sourceFromMap(excerptById, a.question.knowledgeItemId, a.question.sourceEvidence),
      rubric: a.question.rubric || null,
      optionsRaw: a.question.options ?? null,
      correctAnswer: a.question.correctAnswer ?? null,
      selectedOption: a.selectedOption ?? null,
      isCorrect: a.isCorrect ?? null,
      points: a.points,
      maxPoints: a.maxPoints || a.question.points,
      aiFeedback: a.aiFeedback,
    }
  })
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

async function ensureAllAnswersGraded(tx: any, type: AttemptType, attemptId: string) {
  // Completeness has two halves, and approval needs BOTH:
  // (1) Coverage — every required question must have an answer ROW.
  //     Recompute divides by the required questions' points, so a
  //     missing row (question added/published after submission, or a
  //     legacy partial record) would silently score that question zero.
  //     Required = all questions of a unit exam; PUBLISHED questions of
  //     a program exam (the same sets the recompute denominators use).
  // (2) Graded — every existing answer must carry points, for EVERY
  //     type. An interrupted grading run leaves answers at points =
  //     null, and recompute would count them as zero.
  const attemptRow = type === 'UNIT'
    ? await tx.examAttempt.findUnique({ where: { id: attemptId }, select: { examId: true } })
    : await tx.programExamAttempt.findUnique({ where: { id: attemptId }, select: { examId: true } })
  if (!attemptRow) throw apiError('ATTEMPT_NOT_FOUND', 'المحاولة غير موجودة', 404)
  const required = type === 'UNIT'
    ? await tx.question.findMany({ where: { examId: attemptRow.examId }, select: { id: true } })
    : await tx.programQuestion.findMany({ where: { examId: attemptRow.examId, status: 'PUBLISHED' }, select: { id: true } })
  const rows = type === 'UNIT'
    ? await tx.answer.findMany({ where: { attemptId }, select: { id: true, questionId: true, points: true, question: { select: { type: true } } } })
    : await tx.programAnswer.findMany({ where: { attemptId }, select: { id: true, questionId: true, points: true, question: { select: { type: true } } } })
  const requiredIds = required.map((q: any) => q.id)
  if (!requiredIds.length) throw apiError('EXAM_HAS_NO_QUESTIONS', 'لا يمكن اعتماد امتحان بلا أسئلة مطلوبة', 400)
  const duplicates = findDuplicateAnswerQuestionIds(rows)
  if (duplicates.length) {
    throw apiError('DUPLICATE_ANSWER_ROWS', `لا يمكن اعتماد النتيجة: تكررت إجابة ${duplicates.length} سؤال في سجلات المحاولة. يلزم مراجعة البيانات دون حذفها تلقائياً.`, 409)
  }
  const missing = findMissingAnswerQuestionIds(requiredIds, rows)
  if (missing.length) {
    throw apiError('ANSWERS_COVERAGE_INCOMPLETE', `لا يمكن اعتماد النتيجة: ${missing.length} سؤال مطلوب بلا سجل إجابة — أكمل بيانات المحاولة أو راجع أسئلة الامتحان أولاً`, 400)
  }
  const eligible = new Set(requiredIds)
  const ungraded = findUngradedAnswers(rows.filter((row) => eligible.has(row.questionId)))
  if (ungraded.length) {
    const types = [...new Set(ungraded.map((row) => row.type))].join('، ')
    throw apiError('ANSWERS_NOT_FULLY_GRADED', `لا يمكن اعتماد النتيجة قبل إكمال تصحيح كل الإجابات: ${ungraded.length} إجابة بلا نقاط (${types})`, 400)
  }
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
  const total = sumRequiredAnswerPoints(attempt.exam.questions.map((q: any) => q.id), attempt.answers)
  const score = maxTotal > 0 ? Math.round((total / maxTotal) * 1000) / 10 : 0
  const passed = score >= attempt.exam.passScore
  await tx.examAttempt.update({ where: { id: attemptId }, data: { score, passed, status: 'GRADED', aiGraded: true, feedback: JSON.stringify({ summary: 'تم اعتماد النتيجة بعد مراجعة التصحيح.' }) } })
  return { score, passed }
}

async function recomputeProgramAttempt(tx: any, attemptId: string, readiness: ReviewReadiness) {
  const attempt = await tx.programExamAttempt.findUnique({
    where: { id: attemptId },
    include: { exam: { include: { questions: { where: { status: 'PUBLISHED' } } } }, answers: true },
  })
  const maxTotal = attempt.exam.questions.reduce((s: number, q: any) => s + Math.max(0, Number(q.points || 0)), 0)
  const total = sumRequiredAnswerPoints(attempt.exam.questions.map((q: any) => q.id), attempt.answers)
  const rawScore = maxTotal > 0 ? (total / maxTotal) * 100 : 0
  const score = Math.round(rawScore * 10) / 10
  const passed = score >= attempt.exam.passScore
  await tx.programExamAttempt.update({
    where: { id: attemptId },
    data: {
      score, finalScore: score, passed, status: 'GRADED',
      feedback: JSON.stringify({
        summary: 'تم اعتماد النتيجة بعد مراجعة التصحيح.',
        rawScoreBeforeCourseworkCap: score,
        maxExamScore: 100,
        gradeCapApplied: false,
        readiness,
      }),
      // submittedAt is the student's original submission time; approval
      // must never rewrite it (the review moment lives in this feedback).
    },
  })
  return { score, passed }
}

async function registerGraduationAfterReview(type: AttemptType, attemptId: string, passed: boolean) {
  // A failed individual exam can still increase the weighted cumulative total.
  void passed
  if (type === 'UNIT') {
    const attempt = await db.examAttempt.findUnique({ where: { id: attemptId }, select: { userId: true, exam: { select: { unit: { select: { programId: true } } } } } })
    const programId = attempt?.exam?.unit?.programId
    if (!attempt?.userId || !programId) return null
    const enrollment = await db.enrollment.findUnique({ where: { userId_programId: { userId: attempt.userId, programId } }, select: { id: true } })
    return enrollment ? registerGraduationRequest({ enrollmentId: enrollment.id }) : null
  }
  const attempt = await db.programExamAttempt.findUnique({ where: { id: attemptId }, select: { userId: true, exam: { select: { programId: true } } } })
  const programId = attempt?.exam?.programId
  if (!attempt?.userId || !programId) return null
  const enrollment = await db.enrollment.findUnique({ where: { userId_programId: { userId: attempt.userId, programId } }, select: { id: true } })
  return enrollment ? registerGraduationRequest({ enrollmentId: enrollment.id }) : null
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const type = clean(req.nextUrl.searchParams.get('type'), 20) as AttemptType | ''
    const id = clean(req.nextUrl.searchParams.get('id'), 100)
    if (id && type === 'UNIT') return NextResponse.json({ attempt: await unitDetail(id) })
    if (id && type === 'PROGRAM') return NextResponse.json({ attempt: await programDetail(id) })
    return NextResponse.json({ attempts: await listReviewAttempts(clean(req.nextUrl.searchParams.get('status'), 30).toUpperCase()) })
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
    if (body?.action === 'MARK_NEEDS_REVIEW') {
      // Rescue a stuck claimed attempt into the review queue. Guarded by
      // status AND age so a grading run still in flight is never touched.
      const stuckBefore = new Date(Date.now() - STUCK_SUBMITTED_MS)
      const flipped = type === 'UNIT'
        ? await db.examAttempt.updateMany({ where: { id, status: 'SUBMITTED', submittedAt: { lt: stuckBefore } }, data: { status: 'NEEDS_REVIEW' } })
        : await db.programExamAttempt.updateMany({ where: { id, status: 'SUBMITTED', OR: [{ submittedAt: { lt: stuckBefore } }, { submittedAt: null, createdAt: { lt: stuckBefore } }] }, data: { status: 'NEEDS_REVIEW' } })
      if (!flipped.count) return NextResponse.json({ error: 'المحاولة ليست عالقة، أو لم يمضِ على تعليقها وقت كافٍ بعد' }, { status: 409 })
      return NextResponse.json({ ok: true, status: 'NEEDS_REVIEW' })
    }
    const detail = type === 'UNIT' ? await unitDetail(id) : await programDetail(id)
    if (!detail) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    if (detail.status !== 'NEEDS_REVIEW') return NextResponse.json({ error: 'تم اعتماد هذه المحاولة مسبقاً' }, { status: 409 })
    const readiness = type === 'PROGRAM' ? await readinessForProgramAttempt(id) : null
    const graded: Array<{ answerId: string; points: number; feedback: string; isCorrect?: boolean }> = []
    // A program exam may retain answer rows for questions rejected after
    // submission. Regrade only the PUBLISHED set used by the final score.
    // Historical rejected answers stay stored and visible for audit.
    const eligibleProgramQuestionIds = type === 'PROGRAM'
      ? new Set((await db.programQuestion.findMany({
          where: { examId: detail.exam.id, status: 'PUBLISHED' },
          select: { id: true },
        })).map((q) => q.id))
      : null
    for (const answer of detail.answers) {
      if (eligibleProgramQuestionIds && !eligibleProgramQuestionIds.has(answer.questionId)) continue
      if (answer.questionType === 'MCQ' || answer.questionType === 'TF') {
        // Objective answers regrade deterministically from the approved
        // key — exactly as at submit time; no AI is involved.
        const objective = gradeObjectiveAnswer({ optionsRaw: answer.optionsRaw, correctAnswerRaw: answer.correctAnswer, selectedOption: answer.selectedOption, maxPoints: answer.maxPoints })
        if (!objective) throw apiError('ANSWER_KEY_MISSING', `مفتاح التصحيح غير مكتمل للسؤال رقم ${answer.order}. راجع مفتاح الإجابة من إدارة الامتحان أولاً.`, 422)
        graded.push({
          answerId: answer.answerId,
          points: objective.points,
          isCorrect: objective.isCorrect,
          feedback: objective.isCorrect ? 'إجابة صحيحة وفق مفتاح التصحيح المعتمد.' : `إجابة غير صحيحة. الإجابة الصحيحة المعتمدة: «${objective.correctAnswerText}».`,
        })
        continue
      }
      const result = await gradeEssayWithRubric({ question: answer.question, modelAnswer: answer.modelAnswer, rubric: answer.rubric, sourceExcerpt: answer.source, studentAnswer: answer.studentAnswer, maxPoints: answer.maxPoints, deadlineMs: Date.now() + 45_000 })
      graded.push({ answerId: answer.answerId, points: result.points, feedback: JSON.stringify(result) })
    }
    const result = await db.$transaction(async (tx) => {
      await ensureNeedsReview(tx, type, id)
      for (const item of graded) {
        const data = { points: item.points, isCorrect: item.isCorrect !== undefined ? item.isCorrect : (item.points > 0 ? null : false), aiFeedback: item.feedback }
        if (type === 'UNIT') await tx.answer.update({ where: { id: item.answerId }, data })
        else await tx.programAnswer.update({ where: { id: item.answerId }, data })
      }
      await ensureAllAnswersGraded(tx, type, id)
      return type === 'UNIT' ? recomputeUnitAttempt(tx, id) : recomputeProgramAttempt(tx, id, readiness)
    }, { timeout: 120000, maxWait: 10000 })
    const registration = await registerGraduationAfterReview(type, id, result.passed)
    try {
      if (detail.student?.id) {
        await notifyStudentReviewResolved({ studentId: detail.student.id, examTitle: detail.exam.title, score: result.score })
      }
    } catch {
      // إشعار الطالب باعتماد نتيجته لا يعطّل الاعتماد نفسه أبدًا.
    }
    return NextResponse.json({ ok: true, ...result, certificateNo: registration?.certificateNo || null })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (error instanceof EssayNeedsReviewError) {
      const descriptions: Record<string, string> = {
        ESSAY_MODEL_ANSWER_MISSING: 'الإجابة النموذجية لهذا السؤال غير موجودة. استخدم التصحيح اليدوي أو أكمل المرجع المعتمد أولاً.',
        ESSAY_LOW_CONFIDENCE: 'المصحح الآلي غير واثق من النتيجة. راجع إجابة الطالب يدوياً ولا تعتمد علامة تلقائية.',
        ESSAY_CRITERION_MISSING: 'لم يرجع المصحح جميع معايير التصحيح المطلوبة. راجع الإجابة يدوياً أو حاول إعادة التصحيح.',
        ESSAY_CRITERION_UNKNOWN: 'أرجع المصحح معياراً غير موجود في الروبرك المعتمد. يلزم مراجعة يدوية.',
        ESSAY_CRITERION_DUPLICATED: 'كرر المصحح أحد معايير التقييم. يلزم مراجعة يدوية.',
      }
      return NextResponse.json({
        error: descriptions[error.code] || 'التصحيح الآلي غير مكتمل، والمحاولة ما زالت بانتظار المراجعة.',
        code: error.code,
        reviewRequired: true,
      }, { status: 422 })
    }
    // جواب المصحح الآلي مشوّه الشكل (ZodError من مخطط النتيجة الصارم أو
    // SyntaxError من تحليل JSON): نفس معاملة نتيجة المراجعة الناقصة —
    // رسالة واضحة 422 والمحاولة تبقى بانتظار المراجعة، لا 500 عامة.
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return NextResponse.json({
        error: 'أرجع المصحح الآلي نتيجة غير صالحة الشكل، والمحاولة ما زالت بانتظار المراجعة. حاول إعادة التصحيح أو صحّح يدويًا.',
        code: 'ESSAY_GRADE_INVALID_SHAPE',
        reviewRequired: true,
      }, { status: 422 })
    }
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
      await ensureAllAnswersGraded(tx, type, id)
      return type === 'UNIT' ? recomputeUnitAttempt(tx, id) : recomputeProgramAttempt(tx, id, readiness)
    }, { timeout: 120000, maxWait: 10000 })
    const registration = await registerGraduationAfterReview(type, id, result.passed)
    try {
      const resolvedAttempt = type === 'UNIT'
        ? await db.examAttempt.findUnique({ where: { id }, select: { userId: true, exam: { select: { title: true } } } })
        : await db.programExamAttempt.findUnique({ where: { id }, select: { userId: true, exam: { select: { title: true } } } })
      if (resolvedAttempt?.userId) {
        await notifyStudentReviewResolved({ studentId: resolvedAttempt.userId, examTitle: resolvedAttempt.exam?.title || 'الامتحان', score: result.score })
      }
    } catch {
      // إشعار الطالب باعتماد نتيجته لا يعطّل الاعتماد نفسه أبدًا.
    }
    return NextResponse.json({ ok: true, ...result, certificateNo: registration?.certificateNo || null })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (error?.code) return NextResponse.json({ error: error.userMessage || String(error.message || error) }, { status: error.status || 400 })
    console.error('attempts-review PATCH error:', error)
    return NextResponse.json({ error: 'تعذر اعتماد نتيجة المراجعة' }, { status: 500 })
  }
}
