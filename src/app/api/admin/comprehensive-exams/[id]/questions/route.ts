import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { validateComprehensiveQuestion } from '@/lib/comprehensive-exam'

export const runtime = 'nodejs'

async function loadDraftExam(examId: string) {
  const exam = await db.comprehensiveExam.findUnique({ where: { id: examId }, select: { id: true, status: true, title: true } })
  return exam
}

// GET /api/admin/comprehensive-exams/[id]/questions?status= — أسئلة الامتحان
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin()
    const { id } = await ctx.params
    const status = req.nextUrl.searchParams.get('status') || undefined
    const exam = await loadDraftExam(id)
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    const questions = await db.comprehensiveExamQuestion.findMany({
      where: { examId: id, ...(status ? { status } : {}) },
      orderBy: { order: 'asc' },
    })
    return NextResponse.json({ ok: true, questions })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam questions list error:', e)
    return NextResponse.json({ error: 'تعذر تحميل أسئلة الامتحان' }, { status: 500 })
  }
}

// POST /api/admin/comprehensive-exams/[id]/questions — إضافة يدوية واحدة
// (صح/خطأ أو اختيار متعدد فقط) — تبدأ بانتظار المراجعة.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await ctx.params
    const exam = await loadDraftExam(id)
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (exam.status !== 'DRAFT') {
      return NextResponse.json({ error: 'لا يمكن إضافة أسئلة لامتحان منشور — ألغِ نشره أولاً' }, { status: 409 })
    }
    const body = await req.json()
    const checked = validateComprehensiveQuestion({
      ...(body || {}),
      correctAnswerIndexBase: body?.correctAnswerIndexBase === 0 ? 0 : 1,
    })
    if (!checked.ok) return NextResponse.json({ error: checked.errors.join('؛ ') }, { status: 400 })
    const last = await db.comprehensiveExamQuestion.findFirst({
      where: { examId: id },
      orderBy: { order: 'desc' },
      select: { order: true },
    })
    const created = await db.comprehensiveExamQuestion.create({
      data: {
        examId: id,
        order: (last?.order ?? 0) + 1,
        type: checked.question.type,
        text: checked.question.text,
        options: JSON.stringify(checked.question.options),
        correctAnswer: checked.question.correctAnswer,
        source: 'MANUAL',
        sourceEvidence: checked.question.sourceEvidence,
        status: 'PENDING_REVIEW',
        createdById: admin.id,
      },
    })
    await audit(
      { id: admin.id, name: admin.name },
      'ADD_COMPREHENSIVE_EXAM_QUESTION',
      'ComprehensiveExamQuestion',
      created.id,
      `إضافة سؤال يدوي (${checked.question.type}) إلى الامتحان الشامل «${exam.title}» — بانتظار المراجعة`,
    )
    return NextResponse.json({ ok: true, questionId: created.id }, { status: 201 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam question add error:', e)
    return NextResponse.json({ error: 'تعذر إضافة السؤال' }, { status: 500 })
  }
}
