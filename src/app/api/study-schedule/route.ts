import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

export const runtime = 'nodejs'

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

// الفصول متتابعة، لا متداخلة: أسبوع 1 من الفصل الثاني يبدأ بعد انتهاء
// الفصل الأول كاملًا، لا مع أسبوع 1 من الفصل الأول. مدة كل فصل = أقصى
// إزاحة فيه + أسبوع (أسبوع العنصر الأخير نفسه).
function semesterBaseOffsets(items: any[]): Map<number, number> {
  const bySemester = new Map<number, number>()
  for (const item of items) {
    const offset = item.dayOffset ?? Math.max(0, (item.week - 1) * 7)
    const span = offset + 7
    bySemester.set(item.semester, Math.max(bySemester.get(item.semester) || 0, span))
  }
  const bases = new Map<number, number>()
  let acc = 0
  for (const semester of [...bySemester.keys()].sort((a, b) => a - b)) {
    bases.set(semester, acc)
    acc += bySemester.get(semester) || 0
  }
  return bases
}

function mapItem(item: any, enrollmentCreatedAt: Date, semesterBase = 0) {
  const offset = semesterBase + (item.dayOffset ?? Math.max(0, (item.week - 1) * 7))
  return {
    id: item.id,
    programId: item.programId,
    semester: item.semester,
    week: item.week,
    dayOffset: item.dayOffset,
    title: item.title,
    description: item.description,
    type: item.type,
    unitId: item.unitId,
    studyGuideId: item.studyGuideId,
    assignmentId: item.assignmentId,
    examId: item.examId,
    durationMin: item.durationMin,
    order: item.order,
    targetDate: addDays(enrollmentCreatedAt, offset).toISOString(),
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const programId = String(req.nextUrl.searchParams.get('programId') || '').trim()
    const semesterText = req.nextUrl.searchParams.get('semester')
    const semester = semesterText ? Number(semesterText) : undefined
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const enrollment = await db.enrollment.findUnique({ where: { userId_programId: { userId: user.id, programId } }, select: { id: true, createdAt: true, status: true } })
    if (!enrollment) return NextResponse.json({ error: 'التسجيل غير موجود' }, { status: 404 })
    if (!['ACTIVE', 'COMPLETED'].includes(enrollment.status)) return NextResponse.json({ enrollmentCreatedAt: enrollment.createdAt, items: [] })
    const items = await db.studyScheduleItem.findMany({
      where: { programId, status: 'PUBLISHED', ...(Number.isFinite(semester) ? { semester } : {}) },
      orderBy: [{ semester: 'asc' }, { week: 'asc' }, { dayOffset: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
    })
    const bases = semesterBaseOffsets(items)
    return NextResponse.json({ enrollmentCreatedAt: enrollment.createdAt, items: items.map((item) => mapItem(item, enrollment.createdAt, bases.get(item.semester) || 0)) })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })
    return NextResponse.json({ error: 'تعذر تحميل جدول الدراسة' }, { status: 500 })
  }
}
