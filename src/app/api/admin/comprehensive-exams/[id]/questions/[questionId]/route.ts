import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { validateComprehensiveQuestion } from '@/lib/comprehensive-exam'
import { internetQuestionAcademicIssue } from '@/lib/comprehensive-exam'

export const runtime = 'nodejs'

const REVIEW_STATUSES = new Set(['APPROVED', 'REJECTED'])

// PATCH /api/admin/comprehensive-exams/[id]/questions/[questionId]
// تعديل سؤال (نص/خيارات/إجابة) و/أو اعتماد/رفض — مسودة فقط.
// الاعتماد يعيد التحقق من السؤال كاملاً؛ الرفض يتطلب سبباً.
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; questionId: string }> },
) {
  try {
    const admin = await requireAdmin()
    const { id, questionId } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({ where: { id }, select: { id: true, status: true, title: true } })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (exam.status !== 'DRAFT') {
      return NextResponse.json({ error: 'لا يمكن تعديل أسئلة امتحان منشور — ألغِ نشره أولاً' }, { status: 409 })
    }
    const question = await db.comprehensiveExamQuestion.findUnique({ where: { id: questionId } })
    if (!question || question.examId !== id) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 })
    const body = await req.json()
    const nextStatus = body?.status !== undefined ? String(body.status) : null
    const hasEdits = body?.text !== undefined || body?.options !== undefined || body?.correctAnswer !== undefined || body?.type !== undefined || body?.sourceEvidence !== undefined
    if (nextStatus !== null && !REVIEW_STATUSES.has(nextStatus) && nextStatus !== 'PENDING_REVIEW') {
      return NextResponse.json({ error: 'حالة مراجعة غير معروفة' }, { status: 400 })
    }
    if (nextStatus === 'REJECTED' && !String(body?.rejectedReason || '').trim()) {
      return NextResponse.json({ error: 'رفض السؤال يتطلب سبباً' }, { status: 400 })
    }
    const data: Record<string, unknown> = {}
    if (hasEdits) {
      const checked = validateComprehensiveQuestion({
        type: body?.type ?? question.type,
        text: body?.text ?? question.text,
        options: body?.options ?? safeJson(question.options),
        correctAnswer: body?.correctAnswer ?? question.correctAnswer,
        correctAnswerIndexBase: body?.correctAnswer === undefined || body?.correctAnswerIndexBase === 0 ? 0 : 1,
        sourceEvidence: body?.sourceEvidence ?? question.sourceEvidence,
      })
      if (!checked.ok) return NextResponse.json({ error: checked.errors.join('؛ ') }, { status: 400 })
      data.type = checked.question.type
      data.text = checked.question.text
      data.options = JSON.stringify(checked.question.options)
      data.correctAnswer = checked.question.correctAnswer
      data.sourceEvidence = checked.question.sourceEvidence
      // أي تعديل على سؤال معتمد يعيده لانتظار المراجعة — لا تعديل صامت.
      if (question.status === 'APPROVED') {
        data.status = 'PENDING_REVIEW'
        data.approvedById = null
        data.approvedAt = null
      }
    }
    if (nextStatus === 'APPROVED') {
      if (question.source === 'AI_INTERNET' && internetQuestionAcademicIssue(String(data.text ?? question.text))) {
        return NextResponse.json({
          error: 'هذا السؤال يختبر معلومات عن الدرجة أو شروط الالتحاق، وليس كفاءة علمية في التخصص. عدّله إلى سؤال تخصصي أو ارفضه.',
          code: 'ACADEMIC_QUESTION_OFF_TOPIC',
        }, { status: 422 })
      }
      // الاعتماد يعيد التحقق من النسخة المخزنة نفسها قبل ختمها.
      const stored = validateComprehensiveQuestion({
        type: (data.type as string) ?? question.type,
        text: (data.text as string) ?? question.text,
        options: data.options !== undefined ? JSON.parse(String(data.options)) : safeJson(question.options),
        correctAnswer: (data.correctAnswer as string) ?? question.correctAnswer,
        correctAnswerIndexBase: 0,
        sourceEvidence: (data.sourceEvidence as string | null) ?? question.sourceEvidence,
      })
      if (!stored.ok) return NextResponse.json({ error: stored.errors.join('؛ ') }, { status: 400 })
      data.status = 'APPROVED'
      data.approvedById = admin.id
      data.approvedAt = new Date()
      data.rejectedReason = null
    } else if (nextStatus === 'REJECTED') {
      data.status = 'REJECTED'
      data.rejectedReason = String(body.rejectedReason).trim().slice(0, 500)
      data.approvedById = null
      data.approvedAt = null
    } else if (nextStatus === 'PENDING_REVIEW') {
      data.status = 'PENDING_REVIEW'
      data.approvedById = null
      data.approvedAt = null
      data.rejectedReason = null
    }
    if (!Object.keys(data).length) return NextResponse.json({ error: 'لا يوجد ما يُعدَّل' }, { status: 400 })
    const updated = await db.comprehensiveExamQuestion.update({ where: { id: questionId }, data })
    await audit(
      { id: admin.id, name: admin.name },
      nextStatus === 'APPROVED' ? 'APPROVE_COMPREHENSIVE_EXAM_QUESTION' : nextStatus === 'REJECTED' ? 'REJECT_COMPREHENSIVE_EXAM_QUESTION' : 'EDIT_COMPREHENSIVE_EXAM_QUESTION',
      'ComprehensiveExamQuestion',
      questionId,
      `مراجعة سؤال في الامتحان الشامل «${exam.title}» — الحالة: ${updated.status}`,
    )
    return NextResponse.json({ ok: true, question: { id: updated.id, status: updated.status } })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam question patch error:', e)
    return NextResponse.json({ error: 'تعذر تعديل السؤال' }, { status: 500 })
  }
}

// DELETE /api/admin/comprehensive-exams/[id]/questions/[questionId]
// حذف سؤال من المسودة فقط.
export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; questionId: string }> },
) {
  try {
    const admin = await requireAdmin()
    const { id, questionId } = await ctx.params
    const exam = await db.comprehensiveExam.findUnique({ where: { id }, select: { id: true, status: true, title: true } })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (exam.status !== 'DRAFT') {
      return NextResponse.json({ error: 'لا يمكن حذف أسئلة امتحان منشور — ألغِ نشره أولاً' }, { status: 409 })
    }
    const question = await db.comprehensiveExamQuestion.findUnique({ where: { id: questionId }, select: { id: true, examId: true } })
    if (!question || question.examId !== id) return NextResponse.json({ error: 'السؤال غير موجود' }, { status: 404 })
    await db.comprehensiveExamQuestion.delete({ where: { id: questionId } })
    await audit(
      { id: admin.id, name: admin.name },
      'DELETE_COMPREHENSIVE_EXAM_QUESTION',
      'ComprehensiveExamQuestion',
      questionId,
      `حذف سؤال من مسودة الامتحان الشامل «${exam.title}»`,
    )
    return NextResponse.json({ ok: true })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam question delete error:', e)
    return NextResponse.json({ error: 'تعذر حذف السؤال' }, { status: 500 })
  }
}

function safeJson(value: string | null): unknown {
  try {
    return value ? JSON.parse(value) : []
  } catch {
    return []
  }
}
