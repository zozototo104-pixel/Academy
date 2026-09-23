import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { getServiceFlow } from '@/lib/service-flows'

// GET /api/admin/stats — إحصائيات لوحة الإدارة
export async function GET() {
  try {
    await requireAdmin()

    const [totalStudents, totalEnrollments, totalAttempts, totalChats, pendingAgents, pendingAdmissionApps, serviceDeliveryApps, passedAttempts, recentAttempts, programCounts] =
      await Promise.all([
        db.user.count({ where: { role: 'STUDENT', enrollments: { some: {} } } }),
        db.enrollment.count(),
        db.examAttempt.count(),
        db.chatMessage.count({ where: { role: 'user' } }),
        db.agentApplication.count({ where: { status: 'PENDING' } }),
        db.admissionApplication.findMany({
          where: { status: { in: ['PENDING', 'AWAITING_FEE', 'UNDER_REVIEW'] } },
          select: { programRef: { select: { slug: true, category: true } } },
        }),
        db.admissionApplication.findMany({
          where: { status: { in: ['RESULT_APPROVED', 'CERTIFIED'] } },
          select: {
            programRef: { select: { slug: true, category: true } },
            payments: { select: { status: true } },
            deliverables: { select: { status: true, visibleToStudent: true } },
          },
        }),
        db.examAttempt.count({ where: { passed: true } }),
        db.examAttempt.findMany({
          orderBy: { submittedAt: 'desc' },
          take: 10,
          include: {
            user: { select: { name: true, email: true } },
            exam: { include: { unit: { select: { title: true, program: { select: { titleAr: true } } } } } },
          },
        }),
        db.program.findMany({
          select: { id: true, titleAr: true, _count: { select: { enrollments: true } } },
          orderBy: { order: 'asc' },
        }),
      ])

    const passRate = totalAttempts > 0 ? Math.round((passedAttempts / totalAttempts) * 100) : 0
    const pendingAdmissions = pendingAdmissionApps.filter((app) => {
      const flow = getServiceFlow(app.programRef?.slug)
      return flow ? flow.isStudyProgram : app.programRef?.category !== 'SERVICE'
    }).length
    const pendingServices = pendingAdmissionApps.length - pendingAdmissions
    const paidServicesWaitingDelivery = serviceDeliveryApps.filter((app) => {
      const flow = getServiceFlow(app.programRef?.slug)
      const isService = flow ? !flow.isStudyProgram : app.programRef?.category === 'SERVICE'
      if (!isService) return false
      const paid = app.payments.length > 0 && app.payments.every((p) => p.status === 'PAID')
      const hasVisibleOutput = app.deliverables.some((d) => d.status === 'PUBLISHED' && d.visibleToStudent !== false)
      return paid && !hasVisibleOutput
    }).length

    return NextResponse.json({
      stats: {
        totalStudents,
        totalEnrollments,
        totalAttempts,
        totalChats,
        pendingAgents,
        pendingAdmissions,
        pendingServices,
        paidServicesWaitingDelivery,
        passRate,
      },
      recentAttempts: recentAttempts.map((a) => ({
        id: a.id,
        student: a.user.name,
        email: a.user.email,
        exam: a.exam?.title || '',
        program: a.exam?.unit?.program?.titleAr || '',
        score: a.score,
        passed: a.passed,
        submittedAt: a.submittedAt,
      })),
      programCounts: programCounts.map((p) => ({
        titleAr: p.titleAr,
        enrollments: p._count.enrollments,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('Admin stats error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الإحصائيات' }, { status: 500 })
  }
}
