import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// GET /api/my/enrollments — تسجيلات الطالب الحالي
export async function GET() {
  try {
    const user = await requireUser()
    const enrollments = await db.enrollment.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      include: { program: { select: { id: true, titleAr: true, slug: true } } },
    })
    return NextResponse.json({
      enrollments: enrollments.map((e) => ({
        id: e.id,
        programId: e.programId,
        status: e.status,
        finalScore: e.finalScore,
        certificateNo: e.certificateNo,
        program: e.program,
      })),
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    return NextResponse.json({ error: 'خطأ في تحميل التسجيلات' }, { status: 500 })
  }
}
