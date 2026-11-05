import { test, expect, mock, beforeEach } from 'bun:test'

// Phase 2 acceptance — concurrency guard for stored GRADE approvals.
// Pins: two approveGrade calls racing on the SAME grade must not produce
// a duplicate effect. approveGrade writes through a single upsert keyed
// by the (targetType, attemptId) unique pair, so a race converges on ONE
// stored record, both callers observe that same record, and a caller
// without rights is refused without disturbing the winner's record.
//
// The fake DB below mirrors the sibling suite (grade-approval.test.ts)
// but adds a 1ms yield at the start of $transaction and of the upsert so
// two calls started together genuinely interleave. The upsert's own
// check-and-set stays synchronous (atomic), matching Prisma's upsert
// against the unique constraint — the yield models call latency, not a
// race window inside the write.
//
// NOTE the db mock: the lib imports { db as prisma } from '@/lib/db' and
// the real module exports ONLY `db`, so this mock provides exactly
// `{ db: fakeDb }` — no `prisma` key. If the lib ever regresses to
// importing a `prisma` export, these tests fail at import time, pinning
// the real export contract.

type AnyRow = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const tick = () => new Promise((r) => setTimeout(r, 1))

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
  world.applications = [{ id: 'app-1', supervisorId: 'sup-1', userId: 'student-1' }]
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
  $transaction: async (fn: (tx: AnyRow) => unknown) => {
    await tick()
    return fn(fakeDb)
  },
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
        (a) => a.supervisorId === where.supervisorId && a.userId === where.userId,
      ) ?? null,
  },
  gradeApproval: {
    upsert: async ({ where, create, update }: AnyRow) => {
      await tick()
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

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/notify', () => ({
  audit: async (...args: unknown[]) => {
    world.audits.push(args)
  },
  notify: async () => {},
  notifyAdmins: async () => {},
}))

const { approveGrade, gradeApprovalState } = await import('@/lib/grade-approval')

beforeEach(resetWorld)

test('two concurrent approvals by the same admin return the same record and store exactly one', async () => {
  const [a, b] = await Promise.all([
    approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } }),
    approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } }),
  ])
  expect(a.ok).toBe(true)
  expect(b.ok).toBe(true)
  const idA = (a as AnyRow).approval.id
  const idB = (b as AnyRow).approval.id
  expect(idA).toBeTruthy()
  expect(idB).toBe(idA)
  expect(world.approvals.size).toBe(1)
  expect(world.approvals.get('UNIT_EXAM:unit-attempt-1')?.id).toBe(idA)
})

test('concurrent admin + assigned-supervisor approvals converge on one record', async () => {
  const [byAdmin, bySupervisor] = await Promise.all([
    approveGrade({ targetType: 'PROGRAM_EXAM', attemptId: 'program-attempt-1', actor: { id: 'admin-1' } }),
    approveGrade({ targetType: 'PROGRAM_EXAM', attemptId: 'program-attempt-1', actor: { id: 'sup-1' } }),
  ])
  expect(byAdmin.ok).toBe(true)
  expect(bySupervisor.ok).toBe(true)
  const idAdmin = (byAdmin as AnyRow).approval.id
  const idSupervisor = (bySupervisor as AnyRow).approval.id
  expect(idSupervisor).toBe(idAdmin)
  expect(world.approvals.size).toBe(1)
  const stored = world.approvals.get('PROGRAM_EXAM:program-attempt-1') as AnyRow
  expect(stored.id).toBe(idAdmin)
  expect(stored.score).toBe(73)
})

test("a concurrent non-assigned supervisor is refused while the admin's approval lands — one record, the admin's", async () => {
  const [byAdmin, byStranger] = await Promise.all([
    approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } }),
    approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'sup-2' } }),
  ])
  expect(byStranger).toEqual({ ok: false, code: 'GRADE_APPROVAL_FORBIDDEN' })
  expect(byAdmin.ok).toBe(true)
  expect(world.approvals.size).toBe(1)
  const stored = world.approvals.get('UNIT_EXAM:unit-attempt-1') as AnyRow
  expect(stored.approvedById).toBe('admin-1')
  expect(stored.id).toBe((byAdmin as AnyRow).approval.id)
})

test('after concurrent approvals the stored approval state is APPROVED for the stored score', async () => {
  await Promise.all([
    approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'admin-1' } }),
    approveGrade({ targetType: 'UNIT_EXAM', attemptId: 'unit-attempt-1', actor: { id: 'sup-1' } }),
  ])
  expect(world.approvals.size).toBe(1)
  expect(world.approvals.get('UNIT_EXAM:unit-attempt-1')?.score).toBe(88)
  expect(
    await gradeApprovalState(fakeDb, 'UNIT_EXAM', 'unit-attempt-1', 88),
  ).toBe('APPROVED')
})
