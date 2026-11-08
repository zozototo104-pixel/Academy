import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ===== الخطوة 5: الرفع عند نهاية الفترة + ربط النضج + التنظيم =====

mock.module('@/lib/db', () => ({ db: {}, prisma: {} }))
mock.module('@/lib/notify', () => ({ audit: async () => {}, notify: async () => {}, notifyAdmins: async () => {} }))
mock.module('@/lib/outbox', () => ({
  enqueueOutbox: async (client: any, evt: any) => {
    if (!client.notificationOutbox?.create) return null
    try {
      return await client.notificationOutbox.create({ data: { ...evt, idempotencyKey: evt.key } })
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error
      return client.notificationOutbox.findUnique({ where: { idempotencyKey: evt.key } })
    }
  },
}))

const matureCalls: any[] = []
let matureThrows = false
mock.module('@/lib/semester-raise', () => ({
  matureSemesterRaiseIfReady: async (_client: any, input: any) => {
    matureCalls.push(input)
    if (matureThrows) throw new Error('maturity failed')
    return { decision: null, maturity: { mature: true } }
  },
}))

const { raiseGateOf, isGraduationRaiseEligible, materializeDeadlineRaises, enqueueReadyGraduationAdminNotice, reconcileReadyGraduationNotices } = await import('../../src/lib/semester-decision')
const { matureSemesterRaisesAfterGrading } = await import('../../src/lib/semester-raise-hooks')

describe('raiseGateOf — بوابة الرفع الواحدة', () => {
  test('كل الحالات من السجل والفترة', () => {
    expect(raiseGateOf({ status: 'DECIDED' }, false)).toBe('DECIDED')
    expect(raiseGateOf({ status: 'RAISED' }, false)).toBe('RAISED')
    expect(raiseGateOf({ status: 'INTENT' }, true)).toBe('PERIOD_ENDED')
    expect(raiseGateOf(null, true)).toBe('PERIOD_ENDED')
    expect(raiseGateOf({ status: 'INTENT' }, false)).toBe('INTENT_PENDING')
    expect(raiseGateOf({ status: 'WITHDRAWN' }, false)).toBe('AWAITING_STUDENT')
    expect(raiseGateOf(null, false)).toBe('AWAITING_STUDENT')
  })
  test('القرار النهائي لا يظهر من سجل أهلية مبكر أو نية لم تنضج', () => {
    expect(isGraduationRaiseEligible('AWAITING_STUDENT')).toBe(false)
    expect(isGraduationRaiseEligible('INTENT_PENDING')).toBe(false)
    expect(isGraduationRaiseEligible(null)).toBe(false)
    expect(isGraduationRaiseEligible('RAISED')).toBe(true)
    expect(isGraduationRaiseEligible('DECIDED')).toBe(true)
    expect(isGraduationRaiseEligible('PERIOD_ENDED')).toBe(true)
  })
})

function sweepWorld(createdAt: Date) {
  const decisions = new Map<string, any>()
  const notices = new Map<string, any>()
  const approvals = new Set<string>()
  const closed = new Set<string>()
  const enrollment = {
    id: 'enr1', userId: 'u1', programId: 'p1', status: 'ACTIVE',
    createdAt, extensionDays: 0,
    program: { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 },
  }
  const db: any = {
    semesterDecision: {
      findUnique: async ({ where }: any) =>
        decisions.get(`${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`) ?? null,
      updateMany: async ({ where, data }: any) => {
        const key = `${where.enrollmentId}:${where.semester}`
        const row = decisions.get(key)
        if (!row || !where.status.in.includes(row.status)) return { count: 0 }
        decisions.set(key, { ...row, ...data })
        return { count: 1 }
      },
      create: async ({ data }: any) => {
        const key = `${data.enrollmentId}:${data.semester}`
        if (decisions.has(key)) throw Object.assign(new Error('duplicate'), { code: 'P2002' })
        decisions.set(key, { ...data })
        return decisions.get(key)
      },
    },
    enrollment: {
      findMany: async () => enrollment.status === 'ACTIVE' ? [enrollment] : [],
      findUnique: async () => enrollment,
    },
    semesterResultApproval: {
      findUnique: async ({ where }: any) =>
        approvals.has(`${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`)
          ? { id: 'approved' } : null,
    },
    enrollmentSemesterState: {
      findUnique: async ({ where }: any) =>
        closed.has(`${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`)
          ? { status: 'CLOSED' } : null,
    },
    notificationOutbox: {
      create: async ({ data }: any) => {
        if (notices.has(data.idempotencyKey)) throw Object.assign(new Error('duplicate'), { code: 'P2002' })
        notices.set(data.idempotencyKey, data)
        return data
      },
      findUnique: async ({ where }: any) => notices.get(where.idempotencyKey) ?? null,
    },
    unit: {
      findMany: async () => [
        { id: 'u1', programId: 'p1', semester: 1, order: 1 },
        { id: 'u2', programId: 'p1', semester: 2, order: 1 },
      ],
    },
  }
  return { decisions, notices, approvals, closed, db, enrollment }
}

describe('materializeDeadlineRaises — تجسيد رفع المهلة', () => {
  test('طلب INTENT فترته انتهت يصير RAISED بمصدر DEADLINE وتاريخ نهاية الفترة', async () => {
    const { decisions, db } = sweepWorld(new Date('2026-01-01T00:00:00Z'))
    decisions.set('enr1:1', { enrollmentId: 'enr1', semester: 1, status: 'INTENT', intentAt: new Date(), scoreAtIntent: 61 })
    const count = await materializeDeadlineRaises(db, { now: new Date('2026-03-01T00:00:00Z') })
    expect(count).toBe(1)
    const row = decisions.get('enr1:1')
    expect(row.status).toBe('RAISED')
    expect(row.raiseSource).toBe('DEADLINE')
    // Deadline is not the student's earlier consent snapshot. Recompute
    // the official grade at approval; do not reuse a stale provisional mark.
    expect(row.scoreAtRaise).toBeNull()
    expect(new Date(row.raisedAt).getTime()).toBeLessThan(new Date('2026-03-01T00:00:00Z').getTime())
  })
  test('طلب INTENT فترته مفتوحة لا يُلمس، وسجل RAISED لا يُعاد كتابته', async () => {
    const { decisions, db } = sweepWorld(new Date(Date.now() - 5 * 86400000))
    decisions.set('enr1:1', { enrollmentId: 'enr1', semester: 1, status: 'INTENT', intentAt: new Date(), scoreAtIntent: 40 })
    const count = await materializeDeadlineRaises(db)
    expect(count).toBe(0)
    expect(decisions.get('enr1:1').status).toBe('INTENT')
  })

  test('طالب لم يختر شيئًا: يُرفع فصله المنتهي دون افتراض موافقة مبكرة', async () => {
    const { decisions, notices, db } = sweepWorld(new Date('2026-01-01T00:00:00Z'))
    const now = new Date('2026-03-01T00:00:00Z')
    expect(await materializeDeadlineRaises(db, { now })).toBe(1)
    expect(decisions.get('enr1:1')).toMatchObject({
      status: 'RAISED', intent: null, raiseSource: 'DEADLINE',
    })
    expect(notices.has('semester-deadline-raised:enr1:1')).toBe(true)
    // Retry/next cron tick MUST NOT reopen or resend a new notice.
    expect(await materializeDeadlineRaises(db, { now })).toBe(0)
    expect(notices.size).toBe(1)
  })

  test('استكمال الأعمال وسحب الطلب لا يمنعان الرفع التلقائي عند نهاية مدة الفصل', async () => {
    for (const previous of [
      { status: 'NONE', intent: 'CONTINUE' },
      { status: 'WITHDRAWN', intent: 'EARLY_FINISH' },
    ]) {
      const { decisions, db } = sweepWorld(new Date('2026-01-01T00:00:00Z'))
      decisions.set('enr1:1', { enrollmentId: 'enr1', semester: 1, ...previous })
      expect(await materializeDeadlineRaises(db, { now: new Date('2026-03-01T00:00:00Z') })).toBe(1)
      expect(decisions.get('enr1:1')).toMatchObject({
        ...{ intent: previous.intent }, status: 'RAISED', raiseSource: 'DEADLINE',
      })
    }
  })

  test('لا يلمس فصلًا مغلقًا أو نتيجة اعتمدتها الإدارة', async () => {
    const { decisions, approvals, closed, db } = sweepWorld(new Date('2026-01-01T00:00:00Z'))
    approvals.add('enr1:1')
    expect(await materializeDeadlineRaises(db, { now: new Date('2026-03-01T00:00:00Z') })).toBe(0)
    expect(decisions.size).toBe(0)
    approvals.clear()
    closed.add('enr1:1')
    expect(await materializeDeadlineRaises(db, { now: new Date('2026-03-01T00:00:00Z') })).toBe(0)
    expect(decisions.size).toBe(0)
  })

  test('التمديد يمنع الرفع التلقائي قبل نهاية المدة الممددة', async () => {
    const { decisions, enrollment, db } = sweepWorld(new Date('2026-01-01T00:00:00Z'))
    enrollment.extensionDays = 70
    expect(await materializeDeadlineRaises(db, { now: new Date('2026-03-01T00:00:00Z') })).toBe(0)
    expect(decisions.size).toBe(0)
  })
})

function hookWorld() {
  const decisions = new Map<string, any>()
  const db: any = {
    enrollment: {
      findUnique: async () => ({
        id: 'enr1',
        userId: 'u1',
        programId: 'p1',
        createdAt: new Date(),
        status: 'ACTIVE',
        extensionDays: 0,
        program: { category: 'DIPLOMA', maxStudyDays: 90, semestersCount: 2 },
      }),
    },
    semesterDecision: {
      findUnique: async ({ where }: any) =>
        decisions.get(`${where.enrollmentId_semester.enrollmentId}:${where.enrollmentId_semester.semester}`) ?? null,
    },
  }
  return { decisions, db }
}

describe('matureSemesterRaisesAfterGrading — ربط النضج بأحداث التصحيح', () => {
  test('يستدعي النضج للفصول ذات INTENT فقط', async () => {
    matureCalls.length = 0
    matureThrows = false
    const { decisions, db } = hookWorld()
    decisions.set('enr1:1', { enrollmentId: 'enr1', semester: 1, status: 'INTENT' })
    await matureSemesterRaisesAfterGrading(db, { enrollmentId: 'enr1' })
    expect(matureCalls.length).toBe(1)
    expect(matureCalls[0].semester).toBe(1)
  })
  test('بلا طلبات INTENT لا يستدعي شيئًا، وفشل النضج لا يرمي', async () => {
    matureCalls.length = 0
    const { db } = hookWorld()
    await matureSemesterRaisesAfterGrading(db, { enrollmentId: 'enr1' })
    expect(matureCalls.length).toBe(0)
    const world2 = hookWorld()
    world2.decisions.set('enr1:2', { enrollmentId: 'enr1', semester: 2, status: 'INTENT' })
    matureThrows = true
    await matureSemesterRaisesAfterGrading(world2.db, { enrollmentId: 'enr1' })
    expect(matureCalls.length).toBe(1)
    matureThrows = false
  })
})

describe('أسلاك الخطوة 5 (مصادر)', () => {
  const root = join(import.meta.dir, '..', '..')
  const read = (p: string) => readFileSync(join(root, p), 'utf8')
  test('الكرون يجسّد رفع المهلة، والأهلية تدمج أسباب النقص كاملة', () => {
    expect(read('src/app/api/cron/academic-lifecycle/route.ts')).toContain('materializeDeadlineRaises')
    expect(read('src/lib/certificate-eligibility.ts')).toContain('finalGrade.missing')
  })
  test('إشعار الطالب المستوفي مربوط ببوابة الرفع', () => {
    const completion = read('src/lib/enrollment-completion.ts')
    expect(completion).toContain('أصبحت مؤهلًا للتخرج')
    expect(completion).toContain('ارفع نتيجة فصلك الأخير للإدارة للاعتماد')
    expect(completion).toContain('summarizeSemesterDecision')
  })
  test('مواقع الاستدعاء بعد كل حدث تصحيح', () => {
    for (const f of [
      'src/app/api/admin/attempts-review/route.ts',
      'src/lib/supervisor-grade-review.ts',
      'src/app/api/admin/appeals/route.ts',
      'src/app/api/admin/assignments/route.ts',
      'src/lib/supervisor-assignment-grading.ts',
      'src/app/api/program-exam/appeal/route.ts',
      'src/app/api/program-exam/submit/route.ts',
      'src/app/api/exam/submit/route.ts',
      'src/app/api/progress/route.ts',
    ]) {
      expect(read(f)).toContain('matureSemesterRaisesAfterGrading')
    }
  })
  test('قائمة التخرج تحمل البوابة والأقسام مفصولة', () => {
    const graduation = read('src/app/api/admin/graduation-requests/route.ts')
    expect(graduation).toContain('raiseGateOf')
    // قرار المالك 2026-11-08: السجلات غير المرفوعة ظاهرة في قسم
    // «قيد الاستكمال» — ممنوع إخفاؤها من القائمة؛ الحسم عند القرار.
    expect(graduation).toContain('requests: requests.map((r) => ({')
    expect(graduation).not.toContain('actionableRequests')
    expect(read('src/components/aact/AdminExtras.tsx')).toContain('gateBlocked')
    expect(graduation).toContain('await lockSemesterDecision(tx, fresh.enrollmentId, initial.semester)')
    expect(graduation).toContain('isGraduationRaiseEligible(live.gate)')
    expect(graduation).toContain('GRADUATION_NOT_RAISED')
    // The API must also block REJECT for a premature PENDING request;
    // hiding a draft from the list is not sufficient against direct POST.
    expect(graduation).toContain("SEMESTER_DECISION_ACTIVE && request.status === 'PENDING'")
    expect(graduation).toContain('if (rejection.raiseNotAllowed)')
    expect(graduation).toContain('await tx.graduationRequest.updateMany(rejectionWrite)')
    const extras = read('src/components/aact/AdminExtras.tsx')
    expect(extras).toContain('جاهزة لقرار الإدارة')
    expect(extras).toContain('قيد الاستكمال')
    expect(extras).toContain('الطالب رفع ملفه')
    expect(extras).toContain('بانتظار رفع الطالب أو نهاية الفترة')
  })
})
