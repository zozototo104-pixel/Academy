import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resolveExamAppeal, type AttemptKind } from '@/lib/supervisor-grade-review'
import { isAssignedStudent, requireSupervisor, supervisorStudentIds } from '@/lib/supervisor-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value: unknown, max = 100) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// GET /api/supervisor/appeals — التماسات مراجعة طلابه المعلّقة (وحدات + فصلي)
export async function GET() {
  try {
    const actor = await requireSupervisor()
    const studentIds = await supervisorStudentIds(actor)
    if (!studentIds.length) return NextResponse.json({ appeals: [] })
    const dbAny = db as any
    const [unitAppeals, programAppeals] = await Promise.all([
      dbAny.examAttempt.findMany({
        where: { userId: { in: studentIds }, appealStatus: 'PENDING' },
        orderBy: { appealedAt: 'asc' },
        take: 100,
        select: {
          id: true, score: true, passed: true, appealReason: true, appealedAt: true, submittedAt: true,
          user: { select: { id: true, name: true, email: true } },
          exam: { select: { id: true, title: true, passScore: true, unit: { select: { title: true, program: { select: { titleAr: true } } } } } },
        },
      }),
      dbAny.programExamAttempt.findMany({
        where: { userId: { in: studentIds }, appealStatus: 'PENDING' },
        orderBy: { appealedAt: 'asc' },
        take: 100,
        select: {
          id: true, score: true, finalScore: true, passed: true, appealReason: true, appealedAt: true, submittedAt: true,
          user: { select: { id: true, name: true, email: true } },
          exam: { select: { id: true, title: true, passScore: true, program: { select: { titleAr: true } } } },
        },
      }),
    ])
    const appeals = [
      ...unitAppeals.map((a: any) => ({ type: 'UNIT', id: a.id, score: a.score, finalScore: null, passed: a.passed, appealReason: a.appealReason, appealedAt: a.appealedAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, passScore: a.exam.passScore, programTitle: a.exam.unit.program.titleAr, unitTitle: a.exam.unit.title } })),
      ...programAppeals.map((a: any) => ({ type: 'PROGRAM', id: a.id, score: a.score, finalScore: a.finalScore, passed: a.passed, appealReason: a.appealReason, appealedAt: a.appealedAt, student: a.user, exam: { id: a.exam.id, title: a.exam.title, passScore: a.exam.passScore, programTitle: a.exam.program.titleAr, unitTitle: null } })),
    ].sort((a, b) => new Date(a.appealedAt || 0).getTime() - new Date(b.appealedAt || 0).getTime())
    return NextResponse.json({ appeals })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    console.error('supervisor appeals GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الالتماسات' }, { status: 500 })
  }
}

// PATCH /api/supervisor/appeals — البتّ في التماس طالب معيّن عليه
export async function PATCH(req: NextRequest) {
  try {
    const actor = await requireSupervisor()
    const body = await req.json().catch(() => ({}))
    const type = clean(body?.type, 20).toUpperCase() as AttemptKind
    const attemptId = clean(body?.attemptId, 100)
    const action = clean(body?.action, 20).toUpperCase()
    if (type !== 'UNIT' && type !== 'PROGRAM') return NextResponse.json({ error: 'نوع المحاولة غير صالح' }, { status: 400 })
    if (!attemptId) return NextResponse.json({ error: 'معرف المحاولة مطلوب' }, { status: 400 })
    if (action !== 'APPROVE' && action !== 'REJECT') return NextResponse.json({ error: 'قرار الالتماس غير صالح' }, { status: 400 })

    const dbAny = db as any
    const attempt: any = type === 'UNIT'
      ? await dbAny.examAttempt.findUnique({ where: { id: attemptId }, select: { userId: true } })
      : await dbAny.programExamAttempt.findUnique({ where: { id: attemptId }, select: { userId: true } })
    if (!attempt) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    if (!(await isAssignedStudent(actor, attempt.userId))) {
      return NextResponse.json({ error: 'هذا الالتماس ليس لطالب معيّن عليك' }, { status: 403 })
    }
    const result = await resolveExamAppeal(actor, type, attemptId, action, String(body?.response || ''), body?.finalScore)
    return NextResponse.json({ ok: true, ...result })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    if (e?.userMessage) return NextResponse.json({ error: e.userMessage }, { status: e.status || 400 })
    console.error('supervisor appeals PATCH error:', e)
    return NextResponse.json({ error: 'تعذر البت في الالتماس' }, { status: 500 })
  }
}
