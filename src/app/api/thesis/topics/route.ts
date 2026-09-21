import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { enforceApiRateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'

function clean(value: unknown, max = 2000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

async function allowedProgramIdsForUser(userId: string) {
  const enrollments = await db.enrollment.findMany({ where: { userId }, select: { programId: true } })
  return enrollments.map((e) => e.programId)
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser()
    const requestedProgramId = req.nextUrl.searchParams.get('programId') || undefined
    const allowedProgramIds = user.role === 'ADMIN' ? [] : await allowedProgramIdsForUser(user.id)
    const programId = requestedProgramId || allowedProgramIds[0]
    if (!programId) return NextResponse.json({ topics: [], requests: [], message: 'لا يوجد برنامج مسجل مرتبط بحسابك بعد.' })
    if (user.role !== 'ADMIN' && !allowedProgramIds.includes(programId)) {
      return NextResponse.json({ error: 'لا تملك وصولًا لهذا البرنامج' }, { status: 403 })
    }
    const [topics, requests] = await Promise.all([
      db.thesisTopic.findMany({
        where: { programId, status: 'APPROVED' },
        select: { id: true, title: true, description: true, objectives: true, methodology: true, keywords: true, source: true },
        orderBy: [{ createdAt: 'desc' }],
      }),
      db.thesisTopicRequest.findMany({
        where: { userId: user.id, programId },
        include: { topic: { select: { title: true } } },
        orderBy: [{ createdAt: 'desc' }],
        take: 20,
      }),
    ])
    return NextResponse.json({ programId, topics, requests })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })
    console.error('student thesis topics GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل عناوين بحث التخرج' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser()
    const limited = enforceApiRateLimit(req, 'student-thesis-topic-request', 6, 60 * 1000, user.id)
    if (limited) return limited
    const body = await req.json()
    const programId = clean(body?.programId, 120)
    const allowedProgramIds = await allowedProgramIdsForUser(user.id)
    if (!programId || !allowedProgramIds.includes(programId)) {
      return NextResponse.json({ error: 'اختر برنامجًا مسجلًا في حسابك' }, { status: 400 })
    }
    const topicId = body?.topicId ? String(body.topicId) : null
    let proposedTitle = clean(body?.proposedTitle, 260)
    if (topicId) {
      const topic = await db.thesisTopic.findFirst({ where: { id: topicId, programId, status: 'APPROVED' }, select: { title: true } })
      if (!topic) return NextResponse.json({ error: 'العنوان المختار غير متاح' }, { status: 404 })
      proposedTitle = topic.title
    }
    if (!proposedTitle) return NextResponse.json({ error: 'عنوان البحث مطلوب' }, { status: 400 })
    const request = await db.thesisTopicRequest.create({
      data: {
        userId: user.id,
        programId,
        topicId,
        proposedTitle,
        rationale: clean(body?.rationale, 1500) || null,
        status: 'PENDING',
      },
    })
    return NextResponse.json({ ok: true, request })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'تسجيل الدخول مطلوب' }, { status: 401 })
    console.error('student thesis topics POST error:', e)
    return NextResponse.json({ error: 'تعذر إرسال مقترح عنوان البحث' }, { status: 500 })
  }
}
