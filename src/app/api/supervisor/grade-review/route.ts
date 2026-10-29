import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { applyScoreAdjustments, reviewAttemptDetail, type AttemptKind } from '@/lib/supervisor-grade-review'
import { isAssignedStudent, requireSupervisor, supervisorStudentIds } from '@/lib/supervisor-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value: unknown, max = 100) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// GET /api/supervisor/grade-review — محاولات طلابه المصححة (بالذكاء أو
// بانتظار مراجعة) ليراجعها ويعدّل درجاتها. ?type=UNIT|PROGRAM&id= للتفصيل.
export async function GET(req: NextRequest) {
  try {
    const actor = await requireSupervisor()
    const type = clean(req.nextUrl.searchParams.get('type'), 20).toUpperCase() as AttemptKind
    const id = clean(req.nextUrl.searchParams.get('id'), 100)
    if (id && (type === 'UNIT' || type === 'PROGRAM')) {
      const detail = await reviewAttemptDetail(type, id)
      if (!detail) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
      if (!(await isAssignedStudent(actor, detail.student.id))) {
        return NextResponse.json({ error: 'هذه المحاولة ليست لطالب معيّن عليك' }, { status: 403 })
      }
      return NextResponse.json({ attempt: detail })
    }

    const studentIds = await supervisorStudentIds(actor)
    if (!studentIds.length) return NextResponse.json({ attempts: [] })
    const dbAny = db as any
    const [unitAttempts, programAttempts] = await Promise.all([
      dbAny.examAttempt.findMany({
        where: { userId: { in: studentIds }, status: { in: ['GRADED', 'NEEDS_REVIEW'] } },
        orderBy: { submittedAt: 'desc' },
        take: 100,
        select: {
          id: true, status: true, score: true, passed: true, aiGraded: true, submittedAt: true,
          appealStatus: true, reviewedAt: true,
          user: { select: { id: true, name: true, email: true } },
          exam: { select: { id: true, title: true, unit: { select: { title: true, program: { select: { titleAr: true } } } } } },
        },
      }),
      dbAny.programExamAttempt.findMany({
        where: { userId: { in: studentIds }, status: { in: ['GRADED', 'NEEDS_REVIEW'] } },
        orderBy: { submittedAt: 'desc' },
        take: 100,
        select: {
          id: true, status: true, score: true, finalScore: true, passed: true, submittedAt: true,
          appealStatus: true, reviewedAt: true,
          user: { select: { id: true, name: true, email: true } },
          exam: { select: { id: true, title: true, program: { select: { titleAr: true } } } },
        },
      }),
    ])
    const attempts = [
      ...unitAttempts.map((a: any) => ({ type: 'UNIT', id: a.id, status: a.status, score: a.score, finalScore: null, passed: a.passed, aiGraded: a.aiGraded, appealStatus: a.appealStatus ?? 'NONE', reviewedAt: a.reviewedAt, submittedAt: a.submittedAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, programTitle: a.exam.unit.program.titleAr, unitTitle: a.exam.unit.title } })),
      ...programAttempts.map((a: any) => ({ type: 'PROGRAM', id: a.id, status: a.status, score: a.score, finalScore: a.finalScore, passed: a.passed, aiGraded: true, appealStatus: a.appealStatus ?? 'NONE', reviewedAt: a.reviewedAt, submittedAt: a.submittedAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, programTitle: a.exam.program.titleAr, unitTitle: null } })),
    ].sort((a, b) => new Date(b.submittedAt || 0).getTime() - new Date(a.submittedAt || 0).getTime())
    return NextResponse.json({ attempts })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    console.error('supervisor grade-review GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل محاولات المراجعة' }, { status: 500 })
  }
}

// PATCH /api/supervisor/grade-review — تعديل درجات إجابات طالب عنده
// واعتماد النتيجة المحدثة (تصل الطالب فورًا كما هي الآلية اليوم).
export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireSupervisor()
    const body = await req.json().catch(() => ({}))
    const type = clean(body?.type, 20).toUpperCase() as AttemptKind
    const attemptId = clean(body?.attemptId, 100)
    const scores = body?.scores && typeof body.scores === 'object' ? (body.scores as Record<string, unknown>) : {}
    if (type !== 'UNIT' && type !== 'PROGRAM') return NextResponse.json({ error: 'نوع المحاولة غير صالح' }, { status: 400 })
    if (!attemptId) return NextResponse.json({ error: 'معرف المحاولة مطلوب' }, { status: 400 })
    if (!Object.keys(scores).length) return NextResponse.json({ error: 'لا توجد درجات معدّلة' }, { status: 400 })

    const detail = await reviewAttemptDetail(type, attemptId)
    if (!detail) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    if (!(await isAssignedStudent(actor, detail.student.id))) {
      return NextResponse.json({ error: 'هذه المحاولة ليست لطالب معيّن عليك' }, { status: 403 })
    }
    const result = await applyScoreAdjustments(actor, type, attemptId, scores)
    return NextResponse.json({ ok: true, ...result })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    if (e?.userMessage) return NextResponse.json({ error: e.userMessage }, { status: e.status || 400 })
    console.error('supervisor grade-review PATCH error:', e)
    return NextResponse.json({ error: 'تعذر اعتماد نتيجة المراجعة' }, { status: 500 })
  }
}
