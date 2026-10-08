import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { canPublishUnitExamFromQuestions, countUnitExamQuestionsNeedingReview } from '@/lib/unit-exam-policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value: unknown, max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin()
    const body = bodyRecord(await req.json().catch(() => ({})))
    const examId = clean(body.examId, 100)
    if (!examId) return NextResponse.json({ error: 'معرف الاختبار مطلوب' }, { status: 400 })
    const exam = await db.exam.findUnique({ where: { id: examId }, select: { id: true, title: true, questions: { select: { text: true } } } })
    if (!exam) return NextResponse.json({ error: 'الاختبار غير موجود' }, { status: 404 })
    const reviewCount = countUnitExamQuestionsNeedingReview(exam.questions)
    if (!canPublishUnitExamFromQuestions(exam.questions)) {
      return NextResponse.json({ error: `لا يمكن نشر اختبار الوحدة لأنه يحتوي ${reviewCount} سؤال يحتاج مراجعة. اعتمد أسئلة بنك الأسئلة ثم أعد بناء الاختبار.`, reviewCount }, { status: 409 })
    }
    const updated = await db.exam.update({ where: { id: exam.id }, data: { status: 'READY', title: exam.title.replace(/^\[?يحتاج مراجعة\]?\s*/u, '') }, select: { id: true, title: true, status: true } })
    return NextResponse.json({ ok: true, exam: updated })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('unit exam publish error:', error)
    return NextResponse.json({ error: 'تعذر نشر اختبار الوحدة' }, { status: 500 })
  }
}
