import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { buildEnrollmentReminder, REMINDER_ENROLLMENT_STATUSES } from '@/lib/student-reminders'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/student/reminders — تذكيرات الطالب الحالية (منصة فقط، بلا إرسال):
// مهامه المعلقة + مواعيد برامجه + طلبات التمديد الخاصة به.
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول أولًا' }, { status: 401 })
    const enrollments = await db.enrollment.findMany({
      where: { userId: user.id, status: { in: [...REMINDER_ENROLLMENT_STATUSES, 'EXPIRED'] } },
      include: { program: { select: { id: true, titleAr: true, category: true, maxStudyDays: true, semestersCount: true } } },
      orderBy: { createdAt: 'asc' },
    })
    const reminders: any[] = []
    for (const enrollment of enrollments) {
      if (enrollment.status === 'EXPIRED') {
        reminders.push({
          enrollmentId: enrollment.id,
          programId: enrollment.programId,
          programTitle: enrollment.program.titleAr,
          status: 'EXPIRED',
          maxDays: null,
          deadlineAt: null,
          daysLeft: null,
          unitWindows: [],
          pending: [],
          finalScore: enrollment.finalScore,
        })
        continue
      }
      reminders.push({ ...(await buildEnrollmentReminder(enrollment)), status: enrollment.status })
    }
    const requests = await db.programExtensionRequest.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, enrollmentId: true, programId: true, requestedDays: true, reason: true, status: true, grantedDays: true, adminNote: true, createdAt: true, decidedAt: true },
    })
    return NextResponse.json({ reminders, requests })
  } catch (e) {
    console.error('student reminders error', e)
    return NextResponse.json({ error: 'تعذر تحميل التذكيرات' }, { status: 500 })
  }
}
