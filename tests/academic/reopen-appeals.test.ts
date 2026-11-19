import { describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// التماسات إعادة الفتح (المرحلة 4): إنشاء ضمن فصل قائم، بتّ إداري
// مشروط بالحالة، تصعيد عند تأخر البتّ بلا رفض تلقائي، ومنع إغلاق
// الفصل ما دام التماس مؤثر بدرجة معلّقًا.
function makeWorld() {
  const state: any = { appeals: [] as any[], outbox: [] as any[], closed: false, role: 'ADMIN', seq: 0, supervisors: { p1: 'sup-p1', p2: 'sup-p2' } as Record<string, string | null>, candidates: [] as any[], assignments: [] as any[] }
  const match = (row: any, where: any): boolean =>
    Object.entries(where || {}).every(([k, v]) => {
      if (k === 'OR') return Array.isArray(v) && v.some((branch: any) => match(row, branch))
      if (v === undefined) return true
      if (v === null) return row[k] === null || row[k] === undefined
      if (typeof v === 'object') {
        if ('lt' in (v as any)) return new Date(row[k]).getTime() < new Date((v as any).lt).getTime()
        return true
      }
      return row[k] === v
    })
  const db: any = {
    $transaction: async (cb: any) => cb(db),
    user: { findUnique: async () => ({ role: state.role, name: 'مسؤول' }), findMany: async () => [{ id: 'u1', name: 'طالب تجريبي' }] },
    program: { findMany: async () => [{ id: 'p1', titleAr: 'برنامج أول' }, { id: 'p2', titleAr: 'برنامج ثان' }] },
    unit: { findUnique: async ({ where }: any) => (where.id === 'u1a' ? { id: 'u1a', programId: 'p1', semester: 1 } : null), findMany: async () => [] },
    enrollment: { findUnique: async () => ({ id: 'enr1', userId: 'u1', programId: 'p1' }) },
    admissionApplication: {
      findFirst: async ({ where }: any) => ({ supervisorId: state.supervisors[where.programId] || null }),
      findMany: async ({ where }: any) => where.supervisorId
        ? state.candidates.filter((a: any) => a.supervisorId === where.supervisorId)
        : state.assignments,
    },
    enrollmentSemesterState: {
      findUnique: async () => (state.closed ? { status: 'CLOSED' } : { status: 'OPEN' }),
    },
    reopenAppeal: {
      create: async ({ data }: any) => { const row = { id: `ap-${++state.seq}`, escalatedAt: null, ...data }; state.appeals.push(row); return row },
      findFirst: async ({ where }: any) => state.appeals.find((r: any) => match(r, where)) ?? null,
      findUnique: async ({ where }: any) => state.appeals.find((r: any) => r.id === where.id) ?? null,
      findMany: async ({ where }: any) => state.appeals.filter((r: any) => match(r, where)),
      count: async ({ where }: any) => state.appeals.filter((r: any) => match(r, where)).length,
      updateMany: async ({ where, data }: any) => {
        let count = 0
        for (const row of state.appeals) if (match(row, where)) { Object.assign(row, data); count++ }
        return { count }
      },
    },
    notificationOutbox: {
      create: async ({ data }: any) => { const row = { id: `ob-${state.outbox.length}`, ...data }; state.outbox.push(row); return row },
      findUnique: async ({ where }: any) => state.outbox.find((r: any) => r.idempotencyKey === where.idempotencyKey) ?? null,
    },
    // أسطح حارس الاعتماد (لمحك المانع):
    exam: { findMany: async () => [] },
    programExam: { findMany: async () => [] },
    programAssignment: { findMany: async () => [] },
    gradeApproval: { findMany: async () => [] },
  }
  return { state, db }
}

const world = makeWorld()
mock.module('@/lib/db', () => ({ db: world.db }))
mock.module('@/lib/notify', () => ({ audit: async () => {}, notify: async () => {}, notifyAdmins: async () => {} }))
mock.module('@/lib/mailer', () => ({ emailTemplate: (t: string) => t, sendEmailDetailed: async () => 'SKIPPED' }))
mock.module('@/lib/supervisor-scope', () => ({
  requireSupervisor: async () => {
    if (!['SUPERVISOR', 'ADMIN'].includes(world.state.role)) throw new Error('UNAUTHORIZED')
    return { id: 'sup-p1', role: world.state.role, name: 'مشرف' }
  },
  supervisorStudentIds: async () => ['u1'],
  isAssignedStudent: async () => true,
}))
mock.module('@/lib/supervisor-grade-review', () => ({ resolveExamAppeal: async () => ({}) }))
const { createReopenAppeal, decideReopenAppeal, escalateOverdueReopenAppeals } = await import('../../src/lib/reopen-appeals')
const { collectSemesterApprovalBlockers } = await import('../../src/lib/semester-approval')
const { submissionWindowCheck } = await import('../../src/lib/semester-lifecycle')
const { GET: getSupervisorAppeals } = await import('../../src/app/api/supervisor/appeals/route')
const { pathForView } = await import('../../src/lib/app-routes')

function reset() {
  world.state.appeals = []
  world.state.outbox = []
  world.state.closed = false
  world.state.role = 'ADMIN'
  world.state.seq = 0
  world.state.supervisors = { p1: 'sup-p1', p2: 'sup-p2' }
  world.state.candidates = []
  world.state.assignments = []
}

describe('التماسات إعادة الفتح', () => {
  test('إنشاء ضمن فصل قائم: معلّق بمهلة بتّ 7 أيام وإشعار للإدارة', async () => {
    reset()
    const r = await createReopenAppeal(world.db, { userId: 'u1', unitId: 'u1a', reason: 'مرضت يوم الامتحان' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.appeal.status).toBe('PENDING')
      const days = (new Date(r.appeal.decisionDeadline).getTime() - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(6.9)
      expect(days).toBeLessThanOrEqual(7)
    }
    expect(world.state.outbox.map((o: any) => o.kind)).toContain('REOPEN_APPEAL_CREATED')
  })

  test('إشعار إعادة الفتح يذهب لمشرف برنامج الوحدة الفعلي مع رابط للمتابعة فقط', async () => {
    reset()
    const created = await createReopenAppeal(world.db, {
      userId: 'u1', unitId: 'u1a', programId: 'p2', semester: 2, reason: 'تعذر تقديم الوحدة',
    })
    expect(created.ok).toBe(true)
    const supervisorNotice = world.state.outbox.find((o: any) => o.recipientUserId?.startsWith('sup-'))
    expect(supervisorNotice?.recipientUserId).toBe('sup-p1')
    expect(supervisorNotice?.link).toBe('/supervisor?section=review')
    expect(supervisorNotice?.body).toContain('القرار للإدارة')
    expect(world.state.outbox.find((o: any) => o.recipientRole === 'ADMINS')?.link).toBe('/admin?tab=grading-review')
  })

  test('بدون مشرف على برنامج الالتماس لا يصل تنبيه لمشرف برنامج آخر', async () => {
    reset()
    world.state.supervisors.p1 = null
    const created = await createReopenAppeal(world.db, { userId: 'u1', unitId: 'u1a', reason: 'سبب' })
    expect(created.ok).toBe(true)
    expect(world.state.outbox.some((o: any) => o.recipientUserId?.startsWith('sup-'))).toBe(false)
    expect(world.state.outbox.some((o: any) => o.recipientRole === 'ADMINS')).toBe(true)
  })

  test('المشرف يطّلع على التماسات برنامجه الحالي فقط لا التعيين التاريخي في برنامج آخر', async () => {
    reset()
    world.state.role = 'SUPERVISOR'
    world.state.candidates = [
      { userId: 'u1', programId: 'p1', supervisorId: 'sup-p1' },
      { userId: 'u1', programId: 'p2', supervisorId: 'sup-p1' },
    ]
    world.state.assignments = [
      { userId: 'u1', programId: 'p1', supervisorId: 'sup-p1' },
      { userId: 'u1', programId: 'p2', supervisorId: 'sup-p2' },
      { userId: 'u1', programId: 'p2', supervisorId: 'sup-p1' },
    ]
    world.state.appeals = [
      { id: 'ap-one', userId: 'u1', programId: 'p1', semester: 1, unitId: 'u1a', reason: 'سبب أول', status: 'PENDING' },
      { id: 'ap-two', userId: 'u1', programId: 'p2', semester: 1, unitId: null, reason: 'سبب ثان', status: 'PENDING' },
    ]
    const response = await getSupervisorAppeals(new NextRequest('http://localhost/api/supervisor/appeals?view=reopen'))
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.appeals.map((a: any) => a.id)).toEqual(['ap-one'])
    expect(data.appeals[0].studentName).toBe('طالب تجريبي')
  })

  test('المشرف السابق والطالب الغريب لا يستطيعان الاطلاع على طلب إعادة الفتح', async () => {
    reset()
    world.state.role = 'SUPERVISOR'
    world.state.candidates = [{ userId: 'u1', programId: 'p1', supervisorId: 'sup-p1' }]
    world.state.assignments = [{ userId: 'u1', programId: 'p1', supervisorId: 'sup-p2' }]
    world.state.appeals = [{ id: 'secret', userId: 'u1', programId: 'p1', reason: 'تفاصيل خاصة', status: 'PENDING' }]
    const former = await getSupervisorAppeals(new NextRequest('http://localhost/api/supervisor/appeals?view=reopen'))
    expect((await former.json()).appeals).toEqual([])
    world.state.role = 'STUDENT'
    const stranger = await getSupervisorAppeals(new NextRequest('http://localhost/api/supervisor/appeals?view=reopen'))
    expect(stranger.status).toBe(403)
  })

  test('شاشة المشرف تقرأ إعادة الفتح فقط، والإدارة ما زالت صاحبة قرار الموافقة', () => {
    const root = join(import.meta.dir, '..', '..')
    const view = readFileSync(join(root, 'src/components/aact/SupervisorGradeReviewTab.tsx'), 'utf8')
    const shell = readFileSync(join(root, 'src/components/aact/Shell.tsx'), 'utf8')
    expect(view).toContain('/api/supervisor/appeals?view=reopen')
    expect(view).toContain('هذه القائمة للاطلاع والمتابعة فقط')
    expect(view).toContain('قرار إعادة فتح الفصل أو الوحدة أو الواجب من صلاحية الإدارة وحدها')
    expect(shell).toContain('aact-supervisor-section')
    expect(pathForView('supervisor', { section: 'review' })).toBe('/supervisor?section=review')
    expect(pathForView('supervisor')).toBe('/supervisor')
  })

  test('التماس مكرر معلّق لنفس الوحدة مرفوض، وبعد إغلاق الفصل مرفوض أصلًا', async () => {
    reset()
    await createReopenAppeal(world.db, { userId: 'u1', unitId: 'u1a', reason: 'سبب' })
    const dup = await createReopenAppeal(world.db, { userId: 'u1', unitId: 'u1a', reason: 'سبب آخر' })
    expect(dup).toEqual({ ok: false, code: 'APPEAL_ALREADY_PENDING' })
    world.state.closed = true
    const closed = await createReopenAppeal(world.db, { userId: 'u1', programId: 'p1', semester: 2, reason: 'سبب' })
    expect(closed).toEqual({ ok: false, code: 'SEMESTER_CLOSED' })
  })

  test('البتّ: إداري فقط، مشروط بالحالة، وقبوله منحة تعمل في حارس النوافذ', async () => {
    reset()
    const created = await createReopenAppeal(world.db, { userId: 'u1', unitId: 'u1a', reason: 'سبب' })
    if (!created.ok) throw new Error('create failed')
    world.state.role = 'SUPERVISOR'
    const forbidden = await decideReopenAppeal(world.db, { appealId: created.appeal.id, actor: { id: 'x' }, approve: true })
    expect(forbidden).toEqual({ ok: false, code: 'FORBIDDEN' })
    world.state.role = 'ADMIN'
    const decided = await decideReopenAppeal(world.db, { appealId: created.appeal.id, actor: { id: 'admin' }, approve: true, note: 'بالتوفيق' })
    expect(decided.ok).toBe(true)
    const again = await decideReopenAppeal(world.db, { appealId: created.appeal.id, actor: { id: 'admin' }, approve: false })
    expect(again).toEqual({ ok: false, code: 'APPEAL_ALREADY_DECIDED' })
    // المنحة ترفع رفض نافذة الوحدة في حارس التقديم (داخل فترة الفصل):
    const program = { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 }
    const unitsClient: any = {
      unit: { findMany: async () => [{ id: 'u1a', semester: 1, order: 1 }, { id: 'u1b', semester: 1, order: 2 }, { id: 'u2', semester: 2, order: 1 }] },
      enrollmentSemesterState: world.db.enrollmentSemesterState,
      reopenAppeal: world.db.reopenAppeal,
    }
    const v = await submissionWindowCheck(unitsClient, {
      enrollment: { id: 'enr1', programId: 'p1', createdAt: new Date('2026-01-01T00:00:00Z'), extensionDays: 0 },
      program, semester: 1, unitId: 'u1a', now: new Date('2026-01-30T00:00:00Z'),
    })
    expect(v.ok).toBe(true)
  })

  test('قبول التماس الفصل ينبّه الطالب أن الوحدات تحتاج التماسًا مستقلًا', async () => {
    reset()
    const created = await createReopenAppeal(world.db, { userId: 'u1', programId: 'p1', semester: 1, reason: 'تعذر التسليم في الوقت' })
    if (!created.ok) throw new Error('create failed')
    const decided = await decideReopenAppeal(world.db, { appealId: created.appeal.id, actor: { id: 'admin' }, approve: true })
    expect(decided.ok).toBe(true)
    const notice = world.state.outbox.find((o: any) => o.kind === 'REOPEN_APPEAL_DECIDED')
    expect(notice?.body).toContain('الواجبات غير المرتبطة بوحدة')
    expect(notice?.body).toContain('الوحدات التي انتهت مدتها ما زالت مغلقة')
    expect(notice?.body).toContain('التماس إعادة فتح مستقل لكل وحدة')
  })

  test('تصعيد المتأخر دون رفض تلقائي، والالتماس المعلّق يمنع إغلاق الفصل', async () => {
    reset()
    const created = await createReopenAppeal(world.db, { userId: 'u1', unitId: 'u1a', reason: 'سبب' })
    if (!created.ok) throw new Error('create failed')
    world.state.appeals[0].decisionDeadline = new Date('2026-01-05T00:00:00Z')
    const n = await escalateOverdueReopenAppeals(world.db, new Date('2026-01-10T00:00:00Z'))
    expect(n).toBe(1)
    expect(world.state.appeals[0].status).toBe('PENDING')
    expect(world.state.appeals[0].escalatedAt).not.toBeNull()
    expect(await escalateOverdueReopenAppeals(world.db, new Date('2026-01-11T00:00:00Z'))).toBe(0)
    const blockers = await collectSemesterApprovalBlockers(world.db, { userId: 'u1', programId: 'p1', semester: 1 })
    expect(blockers).toContainEqual({ code: 'REOPEN_APPEALS_PENDING', count: 1 })
  })
})
