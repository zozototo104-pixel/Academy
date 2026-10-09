import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { gradeEssayWithRubric } from '@/lib/essay-grading'

export const runtime = 'nodejs'
export const maxDuration = 300

type AttemptType = 'UNIT' | 'PROGRAM'

function clean(value: unknown, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function clamp(value: unknown, max: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(Math.max(0, max), n))
}

async function sourceExcerpt(knowledgeItemId?: string | null, fallback?: string | null) {
  if (knowledgeItemId) {
    const item = await db.bookKnowledgeItem.findUnique({ where: { id: knowledgeItemId }, select: { excerpt: true } }).catch(() => null)
    if (item?.excerpt) return item.excerpt.slice(0, 3000)
  }
  return clean(fallback, 3000)
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
  const rows = await Promise.all(attempt.answers.filter((a) => ['ESSAY', 'SHORT'].includes(a.question.type)).map(async (a) => ({
    answerId: a.id,
    questionId: a.questionId,
    order: a.question.order,
    question: a.question.text,
    studentAnswer: a.answerText || '',
    modelAnswer: a.question.modelAnswer || '',
    source: await sourceExcerpt(a.question.knowledgeItemId, a.question.sourceEvidence),
    rubric: a.question.rubric || null,
    points: a.points,
    maxPoints: a.maxPoints || a.question.points,
    aiFeedback: a.aiFeedback,
  })))
  return { type: 'UNIT', id: attempt.id, status: attempt.status, student: attempt.user, exam: { id: attempt.exam.id, title: attempt.exam.title, unitTitle: attempt.exam.unit.title, programTitle: attempt.exam.unit.program.titleAr, passScore: attempt.exam.passScore }, answers: rows }
}

async function programDetail(id: string) {
  const attempt = await db.programExamAttempt.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true, email: true } }, exam: { include: { program: { select: { titleAr: true } } } }, answers: { include: { question: true }, orderBy: { question: { order: 'asc' } } } },
  })
  if (!attempt) return null
  const rows = await Promise.all(attempt.answers.filter((a) => ['ESSAY', 'SHORT'].includes(a.question.type)).map(async (a) => ({
    answerId: a.id,
    questionId: a.questionId,
    order: a.question.order,
    question: a.question.text,
    studentAnswer: a.answerText || '',
    modelAnswer: a.question.modelAnswer || '',
    source: await sourceExcerpt(a.question.knowledgeItemId, a.question.sourceEvidence),
    rubric: a.question.rubric || null,
    points: a.points,
    maxPoints: a.maxPoints || a.question.points,
    aiFeedback: a.aiFeedback,
  })))
  return { type: 'PROGRAM', id: attempt.id, status: attempt.status, student: attempt.user, exam: { id: attempt.exam.id, title: attempt.exam.title, programTitle: attempt.exam.program.titleAr, passScore: attempt.exam.passScore }, answers: rows }
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

async function recomputeProgramAttempt(tx: any, attemptId: string) {
  const attempt = await tx.programExamAttempt.findUnique({ where: { id: attemptId }, include: { exam: { include: { questions: true } }, answers: true } })
  const maxTotal = attempt.exam.questions.reduce((s: number, q: any) => s + q.points, 0)
  const total = attempt.answers.reduce((s: number, a: any) => s + Number(a.points || 0), 0)
  const score = maxTotal > 0 ? Math.round((total / maxTotal) * 1000) / 10 : 0
  const passed = score >= attempt.exam.passScore
  await tx.programExamAttempt.update({ where: { id: attemptId }, data: { score, finalScore: score, passed, status: 'GRADED', feedback: JSON.stringify({ summary: 'تم اعتماد النتيجة بعد مراجعة التصحيح.' }), submittedAt: new Date() } })
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
    const graded: Array<{ answerId: string; points: number; feedback: string }> = []
    for (const answer of detail.answers) {
      const result = await gradeEssayWithRubric({ question: answer.question, modelAnswer: answer.modelAnswer, rubric: answer.rubric, sourceExcerpt: answer.source, studentAnswer: answer.studentAnswer, maxPoints: answer.maxPoints })
      graded.push({ answerId: answer.answerId, points: result.points, feedback: JSON.stringify(result) })
    }
    const result = await db.$transaction(async (tx) => {
      for (const item of graded) {
        if (type === 'UNIT') await tx.answer.update({ where: { id: item.answerId }, data: { points: item.points, isCorrect: item.points > 0 ? null : false, aiFeedback: item.feedback } })
        else await tx.programAnswer.update({ where: { id: item.answerId }, data: { points: item.points, isCorrect: item.points > 0 ? null : false, aiFeedback: item.feedback } })
      }
      return type === 'UNIT' ? recomputeUnitAttempt(tx, id) : recomputeProgramAttempt(tx, id)
    }, { timeout: 120000, maxWait: 10000 })
    return NextResponse.json({ ok: true, ...result })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
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
    const result = await db.$transaction(async (tx) => {
      for (const [answerId, score] of Object.entries(scores)) {
        if (type === 'UNIT') {
          const answer = await tx.answer.findUnique({ where: { id: answerId }, select: { maxPoints: true } })
          if (answer) await tx.answer.update({ where: { id: answerId }, data: { points: clamp(score, answer.maxPoints || 0), isCorrect: clamp(score, answer.maxPoints || 0) > 0 ? null : false, aiFeedback: 'تم تعديل الدرجة يدوياً من الإدارة.' } })
        } else {
          const answer = await tx.programAnswer.findUnique({ where: { id: answerId }, select: { maxPoints: true } })
          if (answer) await tx.programAnswer.update({ where: { id: answerId }, data: { points: clamp(score, answer.maxPoints || 0), isCorrect: clamp(score, answer.maxPoints || 0) > 0 ? null : false, aiFeedback: 'تم تعديل الدرجة يدوياً من الإدارة.' } })
        }
      }
      return type === 'UNIT' ? recomputeUnitAttempt(tx, id) : recomputeProgramAttempt(tx, id)
    }, { timeout: 120000, maxWait: 10000 })
    return NextResponse.json({ ok: true, ...result })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('attempts-review PATCH error:', error)
    return NextResponse.json({ error: 'تعذر اعتماد نتيجة المراجعة' }, { status: 500 })
  }
}
