import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

// GET /api/comprehensive-exams/ready — البرامج التي لها امتحان شامل
// منشور، لاختيار البرنامج في صفحة التقديم العامة.
// لا يظهر هنا إلا الامتحان المنشور؛ لا أسئلة ولا إجابات.
export async function GET(_req: NextRequest) {
  try {
    const exams = await db.comprehensiveExam.findMany({
      where: { status: 'READY' },
      orderBy: { updatedAt: 'desc' },
      select: {
        id: true,
        programId: true,
        title: true,
        durationMin: true,
        passScore: true,
        program: { select: { id: true, titleAr: true, titleEn: true } },
      },
    })
    return NextResponse.json({
      ok: true,
      exams: exams.map((e: any) => ({
        id: e.id,
        programId: e.programId,
        programTitle: e.program?.titleAr || e.program?.titleEn || e.title,
        title: e.title,
        durationMin: e.durationMin,
        passScore: e.passScore,
      })),
    })
  } catch (e) {
    console.error('comprehensive exams ready error:', e)
    return NextResponse.json({ error: 'تعذر تحميل البرامج المتاحة' }, { status: 500 })
  }
}
