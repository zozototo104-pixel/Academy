import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import {
  COMPREHENSIVE_EXAM_QUESTION_COUNT,
  COMPREHENSIVE_EXAM_POINTS_PER_QUESTION,
  checkComprehensivePublishGate,
} from '@/lib/comprehensive-exam'
import { internetQuestionAcademicIssue } from '@/lib/comprehensive-exam'

export const runtime = 'nodejs'

// POST /api/admin/comprehensive-exams/[id]/publish
// { action: 'publish' } — ينجح فقط مع 100 سؤال معتمد بالضبط.
// { action: 'unpublish' } — يعيد المنشور مسودة (بلا دعوات في المرحلة 1).
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await ctx.params
    const body = await req.json().catch(() => ({}))
    const action = String(body?.action || 'publish')
    const exam = await db.comprehensiveExam.findUnique({ where: { id }, select: { id: true, status: true, title: true } })
    if (!exam) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })

    if (action === 'unpublish') {
      if (exam.status !== 'READY') return NextResponse.json({ error: 'الامتحان ليس منشوراً' }, { status: 409 })
      const result = await db.$transaction(async (tx) => {
        const activeAttempts = await tx.comprehensiveExamAttempt.count({ where: { examId: id, status: 'STARTED' } })
        const pendingInvitations = await tx.comprehensiveExamInvitation.count({
          where: { status: 'PENDING', candidate: { examId: id } },
        })
        if (activeAttempts || pendingInvitations) return { blocked: true, count: 0 }
        const change = await tx.comprehensiveExam.updateMany({
          where: { id, status: 'READY' },
          data: { status: 'DRAFT', publishedAt: null, publishedById: null },
        })
        return { blocked: false, count: change.count }
      }, { isolationLevel: 'Serializable' })
      if (result.blocked) {
        return NextResponse.json({ error: 'لا يمكن إلغاء نشر امتحان لديه دعوات سارية أو محاولات جارية', code: 'EXAM_HAS_ACTIVE_INVITATIONS_OR_ATTEMPTS' }, { status: 409 })
      }
      if (result.count !== 1) return NextResponse.json({ error: 'تغيرت حالة الامتحان — حدّث القائمة', code: 'EXAM_STATUS_CHANGED' }, { status: 409 })
      await audit({ id: admin.id, name: admin.name }, 'UNPUBLISH_COMPREHENSIVE_EXAM', 'ComprehensiveExam', id, `إلغاء نشر الامتحان الشامل «${exam.title}» — عاد مسودة`)
      return NextResponse.json({ ok: true, status: 'DRAFT' })
    }

    if (action === 'archive') {
      if (exam.status === 'ARCHIVED') return NextResponse.json({ ok: true, status: 'ARCHIVED' })
      if (exam.status !== 'DRAFT' && exam.status !== 'READY') {
        return NextResponse.json({ error: 'لا يمكن أرشفة حالة الامتحان الحالية' }, { status: 409 })
      }
      const result = await db.$transaction(async (tx) => {
        const activeAttempts = await tx.comprehensiveExamAttempt.count({ where: { examId: id, status: 'STARTED' } })
        const pendingInvitations = await tx.comprehensiveExamInvitation.count({
          where: { status: 'PENDING', candidate: { examId: id } },
        })
        if (activeAttempts || pendingInvitations) return { activeAttempts, pendingInvitations, count: 0 }
        const change = await tx.comprehensiveExam.updateMany({
          where: { id, status: exam.status },
          data: { status: 'ARCHIVED', publishedAt: null, publishedById: null },
        })
        return { activeAttempts: 0, pendingInvitations: 0, count: change.count }
      }, { isolationLevel: 'Serializable' })
      if (result.activeAttempts || result.pendingInvitations) {
        return NextResponse.json({
          error: 'لا يمكن أرشفة امتحان لديه محاولات جارية أو دعوات لم تُستخدم — أنهِها أولاً',
          code: 'EXAM_HAS_ACTIVE_INVITATIONS_OR_ATTEMPTS',
          activeAttempts: result.activeAttempts,
          pendingInvitations: result.pendingInvitations,
        }, { status: 409 })
      }
      if (result.count !== 1) {
        return NextResponse.json({ error: 'تغيرت حالة الامتحان — حدّث القائمة', code: 'EXAM_STATUS_CHANGED' }, { status: 409 })
      }
      await audit({ id: admin.id, name: admin.name }, 'ARCHIVE_COMPREHENSIVE_EXAM', 'ComprehensiveExam', id, `أرشفة الامتحان الشامل «${exam.title}» مع الاحتفاظ بمحاولاته ونتائجه`)
      return NextResponse.json({ ok: true, status: 'ARCHIVED' })
    }

    if (action !== 'publish') return NextResponse.json({ error: 'إجراء غير معروف' }, { status: 400 })
    if (exam.status === 'READY') return NextResponse.json({ ok: true, status: 'READY', approved: COMPREHENSIVE_EXAM_QUESTION_COUNT })
    if (exam.status !== 'DRAFT') return NextResponse.json({ error: 'لا يمكن نشر امتحان مؤرشف' }, { status: 409 })

    // العدّ + تغيير الحالة في معاملة واحدة حتى لا ينشر طلبان متزامنان معاً.
    const result = await db.$transaction(async (tx: any) => {
      const approved = await tx.comprehensiveExamQuestion.count({ where: { examId: id, status: 'APPROVED' } })
      const gate = checkComprehensivePublishGate(approved)
      if (!gate.ok) return { gate }
      // An older internet question may have been approved before the
      // academic-scope guard existed. Never publish it silently.
      const approvedQuestions = await tx.comprehensiveExamQuestion.findMany({
        where: { examId: id, status: 'APPROVED' },
        select: { source: true, text: true },
      })
      const invalidAcademicQuestion = approvedQuestions.find((q: any) =>
        q.source === 'AI_INTERNET' && internetQuestionAcademicIssue(q.text),
      )
      if (invalidAcademicQuestion) return { gate, invalidAcademicQuestion: true }
      const updated = await tx.comprehensiveExam.update({
        where: { id, status: 'DRAFT' },
        data: {
          status: 'READY',
          publishedAt: new Date(),
          publishedById: admin.id,
          totalPoints: COMPREHENSIVE_EXAM_QUESTION_COUNT * COMPREHENSIVE_EXAM_POINTS_PER_QUESTION,
        },
      })
      return { gate, updated }
    })
    if (!result.gate.ok) {
      return NextResponse.json(
        { error: result.gate.reason, approved: result.gate.approved, needed: (result.gate as any).needed ?? null, excess: (result.gate as any).excess ?? null },
        { status: 409 },
      )
    }
    if ('invalidAcademicQuestion' in result && result.invalidAcademicQuestion) {
      return NextResponse.json({
        error: 'هناك سؤال إنترنت معتمد عن الالتحاق أو تعريف الدرجة، وليس عن كفاءة التخصص. ألغِ اعتماده وصححه قبل النشر.',
        code: 'ACADEMIC_QUESTION_OFF_TOPIC',
      }, { status: 409 })
    }
    await audit(
      { id: admin.id, name: admin.name },
      'PUBLISH_COMPREHENSIVE_EXAM',
      'ComprehensiveExam',
      id,
      `نشر الامتحان الشامل «${exam.title}» — 100 سؤال معتمد، علامة النجاح تُحسب من ${COMPREHENSIVE_EXAM_QUESTION_COUNT * COMPREHENSIVE_EXAM_POINTS_PER_QUESTION} نقطة`,
    )
    return NextResponse.json({ ok: true, status: 'READY', approved: result.gate.approved })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exam publish error:', e)
    return NextResponse.json({ error: 'تعذر نشر الامتحان الشامل' }, { status: 500 })
  }
}
