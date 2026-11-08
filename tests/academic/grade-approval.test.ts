import { test, expect, mock, beforeEach } from 'bun:test'

// Phase 2 (academic-lifecycle plan): stored GRADE approvals.
// Pins: ADMIN approves any student's grade (standing parallel power, with
// or without an assigned supervisor); SUPERVISOR approves only his own
// students' grades; a grade that is not final (not GRADED / no real score)
// cannot be approved; a stored approval counts only while the attempt's
// current score still equals the approved score — a later grade change
// invalidates it (STALE), and a re-approval stores the new score.

type AnyRow = Record<string, any>  

const world = {
  users: new Map<string, AnyRow>(),
  unitAttempts: new Map<string, AnyRow>(),
  programAttempts: new Map<string, AnyRow>(),
  applications: [] as AnyRow[],
  approvals: new Map<string, AnyRow>(),
  audits: [] as AnyRow[],
}

function resetWorld() {
  world.users.clear()
  world.unitAttempts.clear()
  world.programAttempts.clear()
  world.applications = []
  world.approvals.clear()
  world.audits = []
  world.users.set('admin-1', { id: 'admin-1', role: 'ADMIN' })
  world.users.set('sup-1', { id: 'sup-1', role: 'SUPERVISOR' })
  world.users.set('sup-2', { id: 'sup-2', role: 'SUPERVISOR' })
  world.users.set('student-1', { id: 'student-1', role: 'STUDENT' })
  // sup-1 is the assigned supervisor of student-1 (assignment source:
  // AdmissionApplication.supervisorId, as in supervisor-scope.ts).
  world.applications = [{ id: 'app-1', supervisorId: 'sup-1', userId: 'student-1', programId: 'program-1' }]
  world.unitAttempts.set('unit-attempt-1', {
    id: 'unit-attempt-1',
    userId: 'student-1',
    status: 'GRADED',
    score: 88,
    appealStatus: 'NONE',
    answers: [],
    exam: { unit: { programId: 'program-1', semester: 1 } },
  })
  world.programAttempts.set('program-attempt-1', {
    id: 'program-attempt-1',
    userId: 'student-1',
    status: 'GRADED',
    score: 73,
    appealStatus: 'NONE',
    answers: [],
    exam: { programId: 'program-1', semester: 1 },
  })
}

const fakeDb: AnyRow = {
  $transaction: async (fn: (tx: AnyRow) => unknown) => fn(fakeDb),
  user: {
    findUnique: async ({ where }: AnyRow) => world.users.get(where.id) ?? null,
  },
  examAttempt: {
    findUnique: async ({ where }: AnyRow) => {
      const attempt = world.unitAttempts.get(where.id)
      return attempt ? { appealStatus: 'NONE', answers: [], ...attempt } : null
    },
  },
  programExamAttempt: {
    findUnique: async ({ where }: AnyRow) => {
      const attempt = world.programAttempts.get(where.id)
      return attempt ? { appealStatus: 'NONE', answers: [], ...attempt } : null
    },
  },
  admissionApplication: {
    findFirst: async ({ where }: AnyRow) =>
      world.applications.find(
        (a) => a.supervisorId === where.supervisorId && a.userId === where.userId && a.programId === where.programId,
      ) ?? null,
  },
  gradeApproval: {
    upsert: async ({ where, create, update }: AnyRow) => {
      const key = `${where.targetType_attemptId.targetType}:${where.targetType_attemptId.attemptId}`
      const existing = world.approvals.get(key)
      const row = existing
        ? { ...existing, ...update }
        : { id: `ga-${world.approvals.size + 1}`, ...create }
      world.approvals.set(key, row)
      return row
    },
    findUnique: async ({ where }: AnyRow) =>
      world.approvals.get(
        `${where.targetType_attemptId.targetType}:${where.targetType_attemptId.attemptId}`,
      ) ?? null,
  },
}

mock.module('@/lib/db', () => ({ prisma: fakeDb, db: fakeDb }))
mock.module('@/lib/notify', () => ({
  audit: async (...args: unknown[]) => {
    world.audits.push(args)
  },
  notify: async () => {},
  notifyAdmins: async () => {},
}))

const { approveGrade, gradeApprovalState } = await import('@/lib/grade-approval')

beforeEach(resetWorld)

test('admin approves a graded unit-exam grade — stored with score and decider, audited', async () => {
  const res = await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: 'unit-attempt-1',
    actor: { id: 'admin-1' },
  })
  expect(res.ok).toBe(true)
  const stored = world.approvals.get('UNIT_EXAM:unit-attempt-1') as AnyRow
  expect(stored.score).toBe(88)
  expect(stored.approvedById).toBe('admin-1')
  expect(stored.userId).toBe('student-1')
  expect(stored.semester).toBe(1)
  expect(world.audits.length).toBe(1)
})

test('the assigned supervisor approves his own student program-exam grade', async () => {
  const res = await approveGrade({
    targetType: 'PROGRAM_EXAM',
    attemptId: 'program-attempt-1',
    actor: { id: 'sup-1' },
  })
  expect(res.ok).toBe(true)
  expect(world.approvals.get('PROGRAM_EXAM:program-attempt-1')?.approvedById).toBe('sup-1')
})

test('a supervisor cannot approve a grade of a student who is not his', async () => {
  const res = await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: 'unit-attempt-1',
    actor: { id: 'sup-2' },
  })
  expect(res).toEqual({ ok: false, code: 'GRADE_APPROVAL_FORBIDDEN' })
  expect(world.approvals.size).toBe(0)
})

test('supervisor of programme A cannot approve the same student’s exam in programme B', async () => {
  world.programAttempts.set('program-attempt-2', {
    id: 'program-attempt-2',
    userId: 'student-1',
    status: 'GRADED',
    score: 91,
    appealStatus: 'NONE',
    answers: [],
    exam: { programId: 'program-2', semester: 1 },
  })
  world.applications.push({ id: 'app-2', supervisorId: 'sup-2', userId: 'student-1', programId: 'program-2' })
  const wrongSupervisor = await approveGrade({
    targetType: 'PROGRAM_EXAM', attemptId: 'program-attempt-2', actor: { id: 'sup-1' },
  })
  expect(wrongSupervisor).toEqual({ ok: false, code: 'GRADE_APPROVAL_FORBIDDEN' })
  expect(world.approvals.size).toBe(0)
  const assignedSupervisor = await approveGrade({
    targetType: 'PROGRAM_EXAM', attemptId: 'program-attempt-2', actor: { id: 'sup-2' },
  })
  expect(assignedSupervisor.ok).toBe(true)
  const administrator = await approveGrade({
    targetType: 'PROGRAM_EXAM', attemptId: 'program-attempt-2', actor: { id: 'admin-1' },
  })
  expect(administrator.ok).toBe(true)
})

test('admin approval stands even though the student HAS a supervisor (parallel power)', async () => {
  const res = await approveGrade({
    targetType: 'PROGRAM_EXAM',
    attemptId: 'program-attempt-1',
    actor: { id: 'admin-1' },
  })
  expect(res.ok).toBe(true)
})

test('a student actor and an unknown actor are both refused', async () => {
  const byStudent = await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: 'unit-attempt-1',
    actor: { id: 'student-1' },
  })
  expect(byStudent).toEqual({ ok: false, code: 'GRADE_APPROVAL_FORBIDDEN' })
  const byGhost = await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: 'unit-attempt-1',
    actor: { id: 'nobody' },
  })
  expect(byGhost).toEqual({ ok: false, code: 'GRADE_APPROVAL_FORBIDDEN' })
})

test('a grade that is not final cannot be approved', async () => {
  world.unitAttempts.set('unit-attempt-2', {
    id: 'unit-attempt-2',
    userId: 'student-1',
    status: 'NEEDS_REVIEW',
    score: null,
    exam: { unit: { programId: 'program-1', semester: 1 } },
  })
  const inReview = await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: 'unit-attempt-2',
    actor: { id: 'admin-1' },
  })
  expect(inReview).toEqual({ ok: false, code: 'GRADE_NOT_FINAL' })
  world.unitAttempts.set('unit-attempt-3', {
    id: 'unit-attempt-3',
    userId: 'student-1',
    status: 'GRADED',
    score: null,
    exam: { unit: { programId: 'program-1', semester: 1 } },
  })
  const scoreless = await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: 'unit-attempt-3',
    actor: { id: 'admin-1' },
  })
  expect(scoreless).toEqual({ ok: false, code: 'GRADE_NOT_FINAL' })
})

test('pending appeals and unscored answers prevent official approval', async () => {
  world.unitAttempts.get('unit-attempt-1')!.appealStatus = 'PENDING'
  expect(await approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } }))
    .toEqual({ ok: false, code: 'GRADE_NOT_FINAL' })
  world.programAttempts.get('program-attempt-1')!.answers = [{ id: 'answer-1', points: null }]
  expect(await approveGrade({ targetType: 'PROGRAM_EXAM', attemptId: 'program-attempt-1', actor: { id: 'admin-1' } }))
    .toEqual({ ok: false, code: 'GRADE_NOT_FINAL' })
  expect(world.approvals.size).toBe(0)
})

test('unknown attempt and malformed input are refused', async () => {
  const missing = await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: 'nope',
    actor: { id: 'admin-1' },
  })
  expect(missing).toEqual({ ok: false, code: 'ATTEMPT_NOT_FOUND' })
  const malformed = await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: '',
    actor: { id: 'admin-1' },
  })
  expect(malformed).toEqual({ ok: false, code: 'INVALID_GRADE_APPROVAL_INPUT' })
})

test('a later grade change invalidates the approval (STALE); re-approval stores the new score', async () => {
  expect(
    await gradeApprovalState(fakeDb, 'UNIT_EXAM', 'unit-attempt-1', 88),
  ).toBe('NONE')
  await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: 'unit-attempt-1',
    actor: { id: 'admin-1' },
  })
  expect(
    await gradeApprovalState(fakeDb, 'UNIT_EXAM', 'unit-attempt-1', 88),
  ).toBe('APPROVED')
  // The grade moves afterwards (review outcome / appeal / correction).
  world.unitAttempts.get('unit-attempt-1')!.score = 91
  expect(
    await gradeApprovalState(fakeDb, 'UNIT_EXAM', 'unit-attempt-1', 91),
  ).toBe('STALE')
  const again = await approveGrade({
    targetType: 'UNIT_EXAM',
    attemptId: 'unit-attempt-1',
    actor: { id: 'sup-1' },
  })
  expect(again.ok).toBe(true)
  expect(world.approvals.get('UNIT_EXAM:unit-attempt-1')?.score).toBe(91)
  expect(
    await gradeApprovalState(fakeDb, 'UNIT_EXAM', 'unit-attempt-1', 91),
  ).toBe('APPROVED')
})

test('re-approving an unchanged grade is a no-op: no rewrite, no second audit (§9)', async () => {
  const first = await approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } })
  expect(first.ok).toBe(true)
  const storedAfterFirst = { ...(world.approvals.get('UNIT_EXAM:unit-attempt-1') as AnyRow) }
  expect(world.audits.length).toBe(1)
  const second = await approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } })
  expect(second.ok).toBe(true)
  if (second.ok) expect(second.alreadyApproved).toBe(true)
  expect(world.audits.length).toBe(1)
  const storedAfterSecond = world.approvals.get('UNIT_EXAM:unit-attempt-1') as AnyRow
  expect(storedAfterSecond.approvedAt).toBe(storedAfterFirst.approvedAt)
  expect(storedAfterSecond.approvedById).toBe(storedAfterFirst.approvedById)
})

test('failed approval record lookup does not trigger a second approval or audit', async () => {
  const original = fakeDb.gradeApproval.findUnique
  fakeDb.gradeApproval.findUnique = async () => { throw new Error('APPROVAL_LOOKUP_UNAVAILABLE') }
  try {
    await expect(approveGrade({
      targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' },
    })).rejects.toThrow('APPROVAL_LOOKUP_UNAVAILABLE')
    expect(world.approvals.size).toBe(0)
    expect(world.audits.length).toBe(0)
  } finally {
    fakeDb.gradeApproval.findUnique = original
  }
})

test('grade approval obtains a transaction-scoped attempt lock on capable clients', async () => {
  const original = fakeDb.$queryRaw
  const locks: unknown[][] = []
  fakeDb.$queryRaw = async (_parts: TemplateStringsArray, ...values: unknown[]) => {
    locks.push(values)
    return []
  }
  try {
    const approved = await approveGrade({
      targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' },
    })
    expect(approved.ok).toBe(true)
    expect(locks.length).toBe(1)
    expect(locks[0]).toContain('grade-approval:UNIT_EXAM:unit-attempt-1')
  } finally {
    if (original === undefined) delete fakeDb.$queryRaw
    else fakeDb.$queryRaw = original
  }
})

test('a changed grade re-approves on the new value only — a real audited decision (§9)', async () => {
  await approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } })
  const attempt = world.unitAttempts.get('unit-attempt-1') as AnyRow
  attempt.score = 91
  const res = await approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } })
  expect(res.ok).toBe(true)
  if (res.ok) expect(res.alreadyApproved).toBeFalsy()
  expect((world.approvals.get('UNIT_EXAM:unit-attempt-1') as AnyRow).score).toBe(91)
  expect(world.audits.length).toBe(2)
})

test('bulk approval: per-item report with scope and finality inherited (§10)', async () => {
  const { approveGradesBulk } = await import('@/lib/grade-approval')
  await approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } })
  const report = await approveGradesBulk({
    items: [
      { targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1' }, // already approved at 88
      { targetType: 'PROGRAM_EXAM', attemptId: 'program-attempt-1' }, // new approval
      { targetType: 'UNIT_EXAM', attemptId: 'missing-attempt' }, // rejected
      { targetType: 'PROGRAM_EXAM', attemptId: 'program-attempt-1' }, // duplicate in list — deduped
    ],
    actor: { id: 'sup-2' }, // not the assigned supervisor → his items are forbidden
  })
  // sup-2 is forbidden for everything: the already-approved item must NOT
  // be reported as skipped-by-him — scope is checked before idempotency.
  expect(report.approved).toBe(0)
  expect(report.rejected).toBe(3)
  const adminReport = await approveGradesBulk({
    items: [
      { targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1' },
      { targetType: 'PROGRAM_EXAM', attemptId: 'program-attempt-1' },
      { targetType: 'UNIT_EXAM', attemptId: 'missing-attempt' },
    ],
    actor: { id: 'admin-1' },
  })
  expect(adminReport.alreadyApproved).toBe(1)
  expect(adminReport.approved).toBe(1)
  expect(adminReport.rejected).toBe(1)
  expect(adminReport.results.find((r) => r.attemptId === 'missing-attempt')?.code).toBe('ATTEMPT_NOT_FOUND')
  // audits: 1 (the pre-approval) + 1 (program exam in admin bulk) — the
  // already-approved item wrote none.
  expect(world.audits.length).toBe(2)
})
