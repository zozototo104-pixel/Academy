import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getServiceFlow } from '@/lib/service-flows'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const user = await requireUser()
    const [rawAdmissions, payments, enrollments, notifications, unread, assignmentSubmissions, thesis, deliverables] = await Promise.all([
      db.admissionApplication.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: {
          id: true,
          reference: true,
          status: true,
          program: true,
          programId: true,
          createdAt: true,
          programRef: { select: { titleAr: true, slug: true, category: true } },
        },
      }),
      db.payment.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { id: true, admissionId: true, invoiceNo: true, status: true, amount: true, purpose: true, description: true, paidAt: true, createdAt: true },
      }),
      db.enrollment.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, status: true, completedUnits: true, finalScore: true, program: { select: { id: true, titleAr: true } } },
      }),
      db.notification.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, type: true, title: true, body: true, link: true, read: true, createdAt: true },
      }),
      db.notification.count({ where: { userId: user.id, read: false } }),
      db.assignmentSubmission.findMany({
        where: { userId: user.id },
        orderBy: { submittedAt: 'desc' },
        take: 8,
        select: { id: true, status: true, score: true, feedback: true, submittedAt: true, assignment: { select: { title: true, points: true, program: { select: { titleAr: true } } } } },
      }),
      db.thesisSubmission.findFirst({
        where: { userId: user.id },
        orderBy: { updatedAt: 'desc' },
        select: { id: true, title: true, status: true, reviewNote: true, defenseDate: true, resultScore: true, reviewedAt: true, updatedAt: true },
      }),
      db.serviceDeliverable.findMany({
        where: { admission: { userId: user.id }, status: 'PUBLISHED', visibleToStudent: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, admissionId: true, type: true, title: true, createdAt: true },
      }),
    ])

    const admissions = rawAdmissions.map((a) => {
      const flow = getServiceFlow(a.programRef?.slug)
      const isStudyProgram = flow ? flow.isStudyProgram : a.programRef?.category !== 'SERVICE'
      return {
        ...a,
        requestType: isStudyProgram ? 'STUDY' : 'SERVICE',
        serviceKind: flow?.kind || null,
        displayTitle: a.programRef?.titleAr || a.program,
      }
    })
    const studyAdmissions = admissions.filter((a) => a.requestType === 'STUDY')
    const serviceAdmissions = admissions.filter((a) => a.requestType === 'SERVICE')
    const latestAdmission = admissions[0] || null
    const unpaidPayments = payments.filter((p) => p.status !== 'PAID')
    const paidPayments = payments.filter((p) => p.status === 'PAID')
    const activeEnrollment = enrollments.find((e) => e.status === 'ACTIVE') || enrollments[0] || null

    const latestService = serviceAdmissions[0] || null
    const latestStudy = studyAdmissions[0] || null
    const paidServiceWithoutOutput = serviceAdmissions.find((a) => {
      const servicePayments = payments.filter((p) => p.admissionId === a.id)
      if (!servicePayments.length || !servicePayments.every((p) => p.status === 'PAID')) return false
      return !deliverables.some((d) => d.admissionId === a.id)
    })

    let requiredAction: { title: string; body: string; target: string } | null = null
    if (unpaidPayments.length) {
      requiredAction = { title: 'دفعة مطلوبة', body: `يوجد ${unpaidPayments.length} دفعة/فاتورة تحتاج متابعة.`, target: 'payments' }
    } else if (paidServiceWithoutOutput) {
      requiredAction = { title: 'خدمة مدفوعة بانتظار التسليم', body: `طلب ${paidServiceWithoutOutput.reference || ''} مدفوع. ستظهر المخرجات في تبويب «مخرجاتي» عند نشرها من الإدارة.`, target: 'deliverables' }
    } else if (latestAdmission && ['PENDING', 'UNDER_REVIEW', 'SUBMITTED'].includes(latestAdmission.status)) {
      requiredAction = { title: latestAdmission.requestType === 'SERVICE' ? 'طلب الخدمة قيد المراجعة' : 'طلب الالتحاق قيد المراجعة', body: `طلب ${latestAdmission.reference || ''} بانتظار قرار الإدارة.`, target: 'notifications' }
    } else if (!activeEnrollment && !latestService) {
      requiredAction = { title: 'ابدأ طلباً جديداً', body: 'اختر برنامجاً دراسياً أو خدمة مهنية من صفحة التقديم.', target: 'payments' }
    } else if (thesis?.status === 'PLAN_NEEDS_REVISION') {
      requiredAction = { title: 'عدّل خطة البحث', body: thesis.reviewNote || 'خطة البحث تحتاج تعديلًا قبل الاعتماد.', target: 'thesis' }
    } else if (thesis?.status === 'FINAL_NEEDS_REVISION') {
      requiredAction = { title: 'عدّل البحث النهائي', body: thesis.reviewNote || 'البحث النهائي يحتاج تعديلًا قبل المناقشة.', target: 'thesis' }
    } else if (notifications.some((n) => !n.read)) {
      requiredAction = { title: 'لديك إشعارات جديدة', body: `يوجد ${unread} إشعار غير مقروء.`, target: 'notifications' }
    }

    return NextResponse.json({
      admissions,
      payments,
      enrollments,
      notifications,
      unread,
      assignmentSubmissions,
      thesis,
      summary: {
        latestAdmission,
        activeEnrollment,
        unpaidPayments: unpaidPayments.length,
        paidPayments: paidPayments.length,
        requiredAction,
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })
    console.error('student dashboard summary error:', e)
    return NextResponse.json({ error: 'تعذر تحميل ملخص الطالب' }, { status: 500 })
  }
}
