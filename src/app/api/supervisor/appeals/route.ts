import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { resolveExamAppeal, type AttemptKind } from '@/lib/supervisor-grade-review'
import { isAssignedStudent, requireSupervisor, supervisorStudentIds } from '@/lib/supervisor-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function clean(value: unknown, max = 100) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

// Read-only reopening appeals, scoped to the student's CURRENT supervisor in
// the same programme. All decisions remain in /api/admin/reopen-appeals.
async function readReopenAppeals(actor: { id: string; role: string }) {
  let scope: any = {}
  if (actor.role !== 'ADMIN') {
    const candidates = await db.admissionApplication.findMany({
      where: { supervisorId: actor.id, userId: { not: null }, programId: { not: null } },
      select: { userId: true, programId: true },
    })
    if (!candidates.length) return NextResponse.json({ appeals: [] })

    // Old admission rows must not grant access after a supervisor change.
    const userIds = [...new Set(candidates.map((a) => a.userId).filter((id): id is string => Boolean(id)))]
    const programIds = [...new Set(candidates.map((a) => a.programId).filter((id): id is string => Boolean(id)))]
    const assignments = await db.admissionApplication.findMany({
      where: { userId: { in: userIds }, programId: { in: programIds } },
      orderBy: [{ supervisorAt: 'desc' }, { createdAt: 'desc' }],
      select: { userId: true, programId: true, supervisorId: true },
    })
    const latest = new Map<string, string | null>()
    for (const assignment of assignments) {
      if (!assignment.userId || !assignment.programId) continue
      const key = JSON.stringify([assignment.userId, assignment.programId])
      if (!latest.has(key)) latest.set(key, assignment.supervisorId)
    }
    const pairs = candidates.filter((a) => a.userId && a.programId && latest.get(JSON.stringify([a.userId, a.programId])) === actor.id)
    if (!pairs.length) return NextResponse.json({ appeals: [] })
    scope = { OR: pairs.map((a) => ({ userId: a.userId!, programId: a.programId! })) }
  }

  const appeals = await db.reopenAppeal.findMany({
    where: scope,
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: {
      id: true, userId: true, programId: true, semester: true, unitId: true,
      reason: true, status: true, createdAt: true, decisionDeadline: true,
      decidedAt: true, decisionNote: true,
    },
  })
  const userIds = [...new Set(appeals.map((a) => a.userId))]
  const programIds = [...new Set(appeals.map((a) => a.programId))]
  const unitIds = [...new Set(appeals.map((a) => a.unitId).filter((id): id is string => Boolean(id)))]
  const [students, programs, units] = await Promise.all([
    userIds.length ? db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    programIds.length ? db.program.findMany({ where: { id: { in: programIds } }, select: { id: true, titleAr: true, titleEn: true } }) : [],
    unitIds.length ? db.unit.findMany({ where: { id: { in: unitIds } }, select: { id: true, title: true } }) : [],
  ])
  const names = new Map<string, string>(students.map((row) => [row.id, row.name] as [string, string]))
  const titles = new Map<string, string>(programs.map((row) => [row.id, row.titleAr || row.titleEn || ''] as [string, string]))
  const unitTitles = new Map<string, string>(units.map((row) => [row.id, row.title] as [string, string]))
  return NextResponse.json({ appeals: appeals.map((a) => ({
    ...a,
    studentName: names.get(a.userId) || 'طالب',
    programTitle: titles.get(a.programId) || 'برنامج',
    unitTitle: a.unitId ? unitTitles.get(a.unitId) || 'وحدة' : null,
  })) })
}

// GET /api/supervisor/appeals — التماسات مراجعة طلابه المعلّقة (وحدات + فصلي)
// ?view=reopen returns read-only reopening appeals for those same students.
export async function GET(req?: NextRequest) {
  try {
    const actor = await requireSupervisor()
    if (req?.nextUrl.searchParams.get('view') === 'reopen') return await readReopenAppeals(actor)
    const studentIds = await supervisorStudentIds(actor)
    if (!studentIds.length) return NextResponse.json({ appeals: [] })
    // A student can have multiple programmes with different supervisors.
    const assignedPairs = actor.role === 'ADMIN' ? [] : await db.admissionApplication.findMany({
      where: { supervisorId: actor.id, userId: { not: null }, programId: { not: null } },
      select: { userId: true, programId: true },
    })
    if (actor.role !== 'ADMIN' && !assignedPairs.length) return NextResponse.json({ appeals: [] })
    const unitScope = actor.role === 'ADMIN'
      ? { userId: { in: studentIds } }
      : { OR: assignedPairs.map((p) => ({ userId: p.userId!, exam: { unit: { programId: p.programId! } } })) }
    const programScope = actor.role === 'ADMIN'
      ? { userId: { in: studentIds } }
      : { OR: assignedPairs.map((p) => ({ userId: p.userId!, exam: { programId: p.programId! } })) }
    const dbAny = db as any
    const [unitAppeals, programAppeals] = await Promise.all([
      dbAny.examAttempt.findMany({
        where: { ...unitScope, appealStatus: 'PENDING' },
        orderBy: { appealedAt: 'asc' },
        take: 100,
        select: {
          id: true, score: true, passed: true, appealReason: true, appealedAt: true, submittedAt: true,
          user: { select: { id: true, name: true, email: true } },
          exam: { select: { id: true, title: true, passScore: true, unit: { select: { title: true, program: { select: { titleAr: true } } } } } },
        },
      }),
      dbAny.programExamAttempt.findMany({
        where: { ...programScope, appealStatus: 'PENDING' },
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
      ? await dbAny.examAttempt.findUnique({ where: { id: attemptId }, select: { userId: true, exam: { select: { unit: { select: { programId: true } } } } } })
      : await dbAny.programExamAttempt.findUnique({ where: { id: attemptId }, select: { userId: true, exam: { select: { programId: true } } } })
    if (!attempt) return NextResponse.json({ error: 'المحاولة غير موجودة' }, { status: 404 })
    const programId = type === 'UNIT' ? attempt.exam?.unit?.programId : attempt.exam?.programId
    if (!programId || !(await isAssignedStudent(actor, attempt.userId, programId))) {
      return NextResponse.json({ error: 'هذا الالتماس ليس ضمن الطالب والبرنامج المعيّنين عليك' }, { status: 403 })
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
