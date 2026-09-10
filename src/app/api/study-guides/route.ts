import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

function jsonArray(value: string | null) {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function mapGuide(g: any) {
  return {
    id: g.id,
    programId: g.programId,
    semester: g.semester,
    title: g.title,
    overview: g.overview,
    objectives: jsonArray(g.objectives),
    keyTerms: jsonArray(g.keyTerms),
    sections: jsonArray(g.sections),
    activities: jsonArray(g.activities),
    discussionQuestions: jsonArray(g.discussionQuestions),
    status: g.status,
    updatedAt: g.updatedAt,
  }
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const programId = req.nextUrl.searchParams.get('programId') || undefined
    const enrollments = await db.enrollment.findMany({
      where: { userId: user.id, status: { in: ['ACTIVE', 'COMPLETED'] }, ...(programId ? { programId } : {}) },
      select: { programId: true },
    })
    const programIds = enrollments.map((e) => e.programId)
    if (!programIds.length) return NextResponse.json({ guides: [] })

    const guides = await db.programStudyGuide.findMany({
      where: { programId: { in: programIds }, status: 'PUBLISHED' },
      orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }],
    })

    return NextResponse.json({ guides: guides.map(mapGuide) })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('student study guides GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل أدلة الدراسة' }, { status: 500 })
  }
}
