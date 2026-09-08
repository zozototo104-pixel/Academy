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

    return NextResponse.json({
      students: students.map((s) => ({
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
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('Admin students error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل الطلاب' }, { status: 500 })
  }
}
