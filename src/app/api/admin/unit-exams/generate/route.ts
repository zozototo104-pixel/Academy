import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { ensureQuestionBankGenerationJob, runQuestionBankGenerationJobStep } from '@/lib/question-bank-job'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function cleanText(value: unknown, max = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function parseArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [] } catch { return [] }
}

function hasFlag(value: unknown, flag: string) {
  return parseArray(value).map(String).includes(flag)
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

function toExamQuestion(item: any, index: number, needsReview: boolean) {
  const type = String(item.type || 'MCQ').toUpperCase()
  if (type === 'MCQ') {
    const shuffled = shuffleWithAnswer(parseArray(item.options), item.correctAnswer)
    return { order: index + 1, type: 'MCQ', text: cleanText(`${needsReview ? '[يحتاج تدقيق] ' : ''}${item.text}`, 1200), options: JSON.stringify(shuffled.options), correctAnswer: shuffled.correctAnswer, modelAnswer: cleanText(item.modelAnswer || item.correctRationale || item.sourceEvidence, 1800), points: 10 }
  }
  if (type === 'TF') {
    const shuffled = shuffleWithAnswer(['صح', 'خطأ'], item.correctAnswer)
    return { order: index + 1, type: 'TF', text: cleanText(`${needsReview ? '[يحتاج تدقيق] ' : ''}${item.text}`, 1200), options: JSON.stringify(shuffled.options), correctAnswer: shuffled.correctAnswer, modelAnswer: cleanText(item.modelAnswer || item.correctRationale || item.sourceEvidence, 1800), points: 10 }
  }
  return { order: index + 1, type: type === 'ESSAY' ? 'ESSAY' : 'SHORT', text: cleanText(`${needsReview ? '[يحتاج تدقيق] ' : ''}${item.text}`, 1200), options: JSON.stringify([]), correctAnswer: null, modelAnswer: cleanText(item.modelAnswer || item.sourceEvidence, 1800), points: 10 }
}

function selectBalanced(items: any[], count: number) {
  const byType = (type: string) => items.filter((item) => String(item.type).toUpperCase() === type)
  const selected: any[] = []
  const takeOne = (type: string) => {
    const found = byType(type).find((item) => !selected.some((x) => x.id === item.id))
    if (found) selected.push(found)
  }
  takeOne('MCQ')
  takeOne('TF')
  takeOne('SHORT')
  for (const item of items) {
    if (selected.length >= count) break
    if (!selected.some((x) => x.id === item.id)) selected.push(item)
  }
  return selected.slice(0, count)
}

async function scopedQuestions(programId: string, unitId: string, count: number) {
  const grounded = await db.questionBankItem.findMany({
    where: { programId, unitId, status: 'APPROVED', qualityFlags: { contains: 'SOURCE_GROUNDED' } },
    orderBy: [{ usageCount: 'asc' }, { createdAt: 'desc' }],
    take: Math.max(30, count * 3),
  })
  let selected = selectBalanced(grounded, count)
  if (selected.length < count) {
    const job = await ensureQuestionBankGenerationJob({ programId, unitId, requested: count - selected.length, startNew: false })
    await runQuestionBankGenerationJobStep(job.id)
    const refreshed = await db.questionBankItem.findMany({
      where: { programId, unitId, qualityFlags: { contains: 'SOURCE_GROUNDED' }, status: { in: ['APPROVED', 'PENDING_REVIEW'] } },
      orderBy: [{ status: 'asc' }, { usageCount: 'asc' }, { createdAt: 'desc' }],
      take: Math.max(40, count * 4),
    })
    selected = selectBalanced(refreshed, count)
  }
  return selected
}

// POST /api/admin/unit-exams/generate
// body: { programId, unitId, count?, replace? }
export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const programId = cleanText(body?.programId, 80)
    const unitId = cleanText(body?.unitId, 80)
    const count = Math.max(3, Math.min(20, Number(body?.count || 10)))
    const replace = body?.replace !== false

    if (!programId || !unitId) return NextResponse.json({ ok: false, error: 'معرف البرنامج والوحدة مطلوبان' }, { status: 400 })
    const unit = await db.unit.findFirst({ where: { id: unitId, programId }, include: { exam: { select: { id: true, title: true, _count: { select: { questions: true, attempts: true } } } } } })
    if (!unit) return NextResponse.json({ ok: false, error: 'الوحدة غير موجودة ضمن البرنامج المحدد' }, { status: 404 })
    if (unit.exam?._count.attempts && replace) return NextResponse.json({ ok: false, error: 'لا يمكن إعادة توليد اختبار وحدة لديه محاولات طلابية محفوظة. أنشئ وحدة/اختباراً جديداً بدلاً من مسح سجل الطلاب.' }, { status: 409 })

    const bankItems = await scopedQuestions(programId, unitId, count)
    if (bankItems.length < 3) return NextResponse.json({ ok: false, error: 'لا توجد أسئلة موثقة كافية لهذه الوحدة. تم تشغيل وظيفة بنك الأسئلة؛ أعد المحاولة بعد اكتمالها.' }, { status: 409 })
    const reviewRequired = bankItems.some((item) => item.status !== 'APPROVED' || !hasFlag(item.qualityFlags, 'SOURCE_GROUNDED')) || bankItems.length < count
    const examQuestions = bankItems.map((item, index) => toExamQuestion(item, index, item.status !== 'APPROVED'))

    const result = await db.$transaction(async (tx) => {
      const exam = unit.exam
        ? await tx.exam.update({ where: { id: unit.exam.id }, data: { title: `${reviewRequired ? '[يحتاج تدقيق] ' : ''}اختبار وحدة: ${unit.title}`, passScore: 60 } })
        : await tx.exam.create({ data: { unitId: unit.id, title: `${reviewRequired ? '[يحتاج تدقيق] ' : ''}اختبار وحدة: ${unit.title}`, passScore: 60 } })
      if (replace) {
        await tx.examDraft.deleteMany({ where: { examId: exam.id, examType: 'UNIT' } })
        await tx.question.deleteMany({ where: { examId: exam.id } })
      }
      const existingCount = replace ? 0 : await tx.question.count({ where: { examId: exam.id } })
      for (const [index, question] of examQuestions.entries()) await tx.question.create({ data: { examId: exam.id, ...question, order: existingCount + index + 1 } })
      await tx.questionBankItem.updateMany({ where: { id: { in: bankItems.map((item) => item.id) } }, data: { usageCount: { increment: 1 } } })
      await tx.program.update({ where: { id: programId }, data: { academicReadinessStatus: 'READY_FOR_REVIEW', academicApproved: false, academicApprovedAt: null, academicApprovedById: null } })
      return tx.exam.findUnique({ where: { id: exam.id }, select: { id: true, title: true, passScore: true, _count: { select: { questions: true, attempts: true } } } })
    })

    return NextResponse.json({ ok: true, exam: result, reviewRequired, sourceGroundedRatio: bankItems.filter((item) => item.status === 'APPROVED' && hasFlag(item.qualityFlags, 'SOURCE_GROUNDED')).length / bankItems.length, message: reviewRequired ? 'تم توليد اختبار الوحدة مع عناصر تحتاج تدقيقاً قبل النشر.' : 'تم توليد اختبار الوحدة من بنك الأسئلة الموثق.' })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ ok: false, error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('unit exam generator error:', e)
    return NextResponse.json({ ok: false, error: 'تعذر توليد اختبار الوحدة' }, { status: 500 })
  }
}
