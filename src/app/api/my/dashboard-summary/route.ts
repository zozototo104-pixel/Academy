import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

export const runtime = 'nodejs'

export async function GET() {
  try {
    const user = await requireUser()
    const [admissions, payments, enrollments, notifications, unread, assignmentSubmissions, thesis] = await Promise.all([
      db.admissionApplication.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, reference: true, status: true, program: true, createdAt: true, programRef: { select: { titleAr: true } } },
      }),
      db.payment.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, invoiceNo: true, status: true, amount: true, purpose: true, description: true, paidAt: true, createdAt: true },
      }),
      db.enrollment.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, status: true, progress: true, finalScore: true, program: { select: { id: true, titleAr: true } } },
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
        select: { id: true, title: true, status: true, reviewNote: true, defenseDate: true, resultScore: true, resultApprovedAt: true, updatedAt: true },
      }),
    ])

    const latestAdmission = admissions[0] || null
    const unpaidPayments = payments.filter((p) => p.status !== 'PAID')
    const paidPayments = payments.filter((p) => p.status === 'PAID')
    const activeEnrollment = enrollments.find((e) => e.status === 'ACTIVE') || enrollments[0] || null

    let requiredAction: { title: string; body: string; target: string } | null = null
    if (latestAdmission && ['PENDING', 'UNDER_REVIEW', 'SUBMITTED'].includes(latestAdmission.status)) {
      requiredAction = { title: 'طلبك قيد المراجعة', body: `طلب ${latestAdmission.reference || ''} بانتظار قرار الإدارة.`, target: 'payments' }
    } else if (unpaidPayments.length) {
      requiredAction = { title: 'دفعة مطلوبة', body: `يوجد ${unpaidPayments.length} دفعة/فاتورة تحتاج متابعة.`, target: 'payments' }
    } else if (!activeEnrollment) {
      requiredAction = { title: 'ابدأ التسجيل في برنامج', body: 'اختر برنامجًا مناسبًا وقدم طلب الالتحاق.', target: 'programs' }
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
