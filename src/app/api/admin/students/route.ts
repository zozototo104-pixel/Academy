import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

// GET /api/admin/students — قائمة الطلاب مع تسجيلاتهم ونتائجهم
export async function GET() {
  try {
    await requireAdmin()
    const students = await db.user.findMany({
      where: { role: 'STUDENT' },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        enrollments: {
          include: { program: { select: { titleAr: true } } },
        },
        examAttempts: {
          orderBy: { submittedAt: 'desc' },
          take: 5,
          select: { score: true, passed: true, submittedAt: true },
        },
        _count: { select: { chatMessages: { where: { role: 'user' } } } },
      },
    })

    const studentIds = students.map((s) => s.id)
    const studentEmails = students.map((s) => s.email).filter(Boolean)
    const admissions = students.length
      ? await db.admissionApplication.findMany({
          where: {
            OR: [
              { userId: { in: studentIds } },
              { email: { in: studentEmails } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          select: { id: true, reference: true, userId: true, email: true, status: true, program: true, createdAt: true },
        })
      : []

    const latestAdmissionByStudent = new Map<string, typeof admissions[number]>()
    for (const app of admissions) {
      if (app.userId && !latestAdmissionByStudent.has(app.userId)) latestAdmissionByStudent.set(app.userId, app)
      const emailKey = app.email.toLowerCase()
      if (emailKey && !latestAdmissionByStudent.has(emailKey)) latestAdmissionByStudent.set(emailKey, app)
    }

    return NextResponse.json({
      students: students.map((s) => {
        const latestAdmission = latestAdmissionByStudent.get(s.id) || latestAdmissionByStudent.get(s.email.toLowerCase()) || null
        return ({
        id: s.id,
        name: s.name,
        email: s.email,
        country: s.country,
        createdAt: s.createdAt,
        enrollments: s.enrollments.map((e) => ({
          program: e.program.titleAr,
          status: e.status,
          progress: (() => {
            try {
              const done = JSON.parse(e.completedUnits || '[]').length
              return e.program ? done : 0
            } catch {
              return 0
            }
          })(),
          certificateNo: e.certificateNo,
          finalScore: e.finalScore,
        })),
        attemptsCount: s.examAttempts.length,
        bestScore: s.examAttempts.reduce<number | null>(
          (best, a) => (a.score !== null && (best === null || (a.score || 0) > best) ? a.score : best),
          null
        ),
        aiChats: s._count.chatMessages,
        latestAdmission: latestAdmission
          ? {
              id: latestAdmission.id,
              reference: latestAdmission.reference,
              status: latestAdmission.status,
              program: latestAdmission.program,
              createdAt: latestAdmission.createdAt,
            }
          : null,
        })
      }),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('Admin students error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الطلاب' }, { status: 500 })
  }
}
