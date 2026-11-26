// Comprehensive exam phase 2 — attempt routes (start/resume/submit).
// Real route code; only the DB is faked. The lib's shuffle/grade run
// for real, so the display mapping is exercised end to end.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

let exams: any[] = []
let programs: any[] = []
let questions: any[] = []
let candidates: any[] = []
let invitations: any[] = []
let attempts: any[] = []
let answers: any[] = []
let certificates: any[] = []
let users: any[] = []
let enrollments: any[] = []
let auditRows: any[] = []
let serialSeq = 41
let seq = 0

const fakeDb: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(fakeDb),
  $queryRaw: async () => [{ value: ++serialSeq }],
  program: {
    findUnique: async ({ where }: any) => programs.find((p) => p.id === where?.id) || null,
  },
  comprehensiveExam: {
    findUnique: async ({ where }: any) => exams.find((e) => e.id === where?.id) || null,
  },
  comprehensiveExamQuestion: {
    // Mirrors real Prisma: a `select` restricts the returned fields,
    // so code that needs a field must select it (regression guard:
    // the attempt start needs correctAnswer for its snapshot).
    findMany: async ({ where, select }: any = {}) => {
      const rows = questions
        .filter((q) => (!where?.examId || q.examId === where.examId) && (!where?.status || q.status === where.status))
        .sort((a, b) => a.order - b.order)
      if (!select) return rows
      return rows.map((q: any) => {
        const out: any = {}
        for (const key of Object.keys(select)) if (select[key]) out[key] = q[key]
        return out
      })
    },
  },
  comprehensiveExamInvitation: {
    findUnique: async ({ where, include }: any) => {
      const row = invitations.find((i) => i.token === where?.token) || null
      if (!row) return null
      if (include?.candidate) {
        const cand = candidates.find((c) => c.id === row.candidateId)
        return { ...row, candidate: cand ? { ...cand } : null }
      }
      return row
    },
    update: async ({ where, data }: any) => {
      const row = invitations.find((i) => i.id === where?.id)
      if (!row) throw new Error('NOT_FOUND')
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
  },
  comprehensiveExamAttempt: {
    findUnique: async ({ where }: any) => attempts.find((a) => a.invitationId === where?.invitationId) || null,
    findFirst: async ({ where }: any = {}) =>
      attempts.find(
        (a) =>
          (!where?.candidateId || a.candidateId === where.candidateId) &&
          (!where?.status || a.status === where.status) &&
          (where?.passed === undefined || a.passed === where.passed),
      ) || null,
    create: async ({ data }: any) => {
      const row = { id: data.id || `att-${++seq}`, score: null, passed: null, submittedAt: null, durationUsedMin: null, createdAt: new Date(), updatedAt: new Date(), ...data }
      attempts.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = attempts.find((a) => a.id === where?.id)
      if (!row) throw new Error('NOT_FOUND')
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
  },
  comprehensiveExamAnswer: {
    deleteMany: async ({ where }: any) => {
      const before = answers.length
      answers = answers.filter((a) => a.attemptId !== where?.attemptId)
      return { count: before - answers.length }
    },
    createMany: async ({ data }: any) => {
      for (const row of data) answers.push({ id: `ans-${++seq}`, ...row })
      return { count: data.length }
    },
  },
  comprehensiveExamCandidate: {
    findFirst: async ({ where }: any = {}) =>
      candidates.find(
        (c) =>
          (!where?.examId || c.examId === where.examId) &&
          (!where?.nationalId || c.nationalId === where.nationalId) &&
          (!where?.status?.not || c.status !== where.status.not) &&
          (!where?.id?.not || c.id !== where.id.not),
      ) || null,
  },
  certificate: {
    findFirst: async ({ where }: any = {}) => {
      const rows = certificates.filter((c) => {
        if (where?.enrollment?.programId && c.programId !== where.enrollment.programId) return false
        if (where?.user?.email && c.userEmail !== where.user.email) return false
        if (where?.type && c.type !== where.type) return false
        if (where?.enrollmentId && c.enrollmentId !== where.enrollmentId) return false
        if (where?.comprehensiveExamId && c.comprehensiveExamId !== where.comprehensiveExamId) return false
        if (Array.isArray(where?.OR)) {
          const ok = where.OR.some((cond: any) => (cond.legacy === true && c.legacy === true) || (cond.type && c.type === cond.type))
          if (!ok) return false
        }
        if (where?.comprehensiveExam) {
          const ce = where.comprehensiveExam
          if (ce.specializationProgramId !== undefined && c.specializationProgramId !== ce.specializationProgramId) return false
          if (ce.programId !== undefined && c.examProgramId !== ce.programId) return false
        }
        return true
      })
      return rows[0] || null
    },
    create: async ({ data }: any) => {
      const row = { id: `cert-${++seq}`, userEmail: users.find((u) => u.id === data.userId)?.email || data.userEmail || null, ...data }
      certificates.push(row)
      return row
    },
  },
  user: {
    findUnique: async ({ where }: any = {}) =>
      users.find((u) => (where?.id ? u.id === where.id : u.email === where?.email)) || null,
    create: async ({ data }: any) => {
      const row = { id: `user-${++seq}`, country: null, ...data }
      users.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = users.find((u) => u.id === where?.id)
      Object.assign(row, data)
      return row
    },
  },
  enrollment: {
    upsert: async ({ create, update }: any) => {
      const row = { id: `enr-${++seq}`, ...create, ...update }
      enrollments.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = enrollments.find((e) => e.id === where?.id)
      Object.assign(row, data)
      return row
    },
  },
  auditLog: {
    create: async ({ data }: any) => {
      const row = { id: `audit-${++seq}`, ...data }
      auditRows.push(row)
      return row
    },
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/mailer', () => ({ emailTemplate: () => '', sendEmailDetailed: async () => 'SENT' }))
mock.module('@/lib/whatsapp-cloud', () => ({ sendOfficialWhatsAppTemplate: async () => ({ ok: true }) }))
mock.module('@/lib/storage', () => ({ storeFileBuffer: async () => ({ key: 'k', mimeType: 'image/png', size: 1 }) }))

// Imported AFTER the mocks: the lib pulls the (mocked) db through its
// own imports, so the real Prisma client must never load here.
const lib = await import('../../src/lib/comprehensive-exam-phase2')

const attemptRoute = await import('../../src/app/api/comprehensive-exams/attempt/route')

function reset() {
  programs = [
    { id: 'prog-1', titleAr: 'برنامج المعادلة', titleEn: 'Equivalency Program', slug: 'training-certificates-equivalency', category: 'SERVICE' },
    { id: 'spec-1', titleAr: 'دكتوراه في إدارة الأعمال', titleEn: 'PhD in Business Administration', category: 'DOCTORATE' },
  ]
  exams = [{ id: 'exam-1', programId: 'prog-1', specializationProgramId: 'spec-1', title: 'الامتحان الشامل — دكتوراه في إدارة الأعمال', status: 'READY', durationMin: 120, passScore: 60 }]
  questions = [
    { id: 'q1', examId: 'exam-1', order: 0, type: 'MCQ', text: 'س1', options: JSON.stringify(['أ', 'ب', 'ج', 'د']), correctAnswer: '1', status: 'APPROVED' },
    { id: 'q2', examId: 'exam-1', order: 1, type: 'TF', text: 'س2', options: JSON.stringify(['صح', 'خطأ']), correctAnswer: '0', status: 'APPROVED' },
    { id: 'q3', examId: 'exam-1', order: 2, type: 'MCQ', text: 'س3', options: JSON.stringify(['أ', 'ب', 'ج']), correctAnswer: '2', status: 'APPROVED' },
  ]
  candidates = [
    { id: 'cand-1', examId: 'exam-1', userId: 'user-1', fullName: 'أحمد محمد', nationalId: '123456789', email: 'a@b.com', phone: '0599123456', status: 'APPROVED', reviewedById: 'admin-1' },
  ]
  invitations = [
    { id: 'inv-1', candidateId: 'cand-1', token: 'tok-valid-1', expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), status: 'PENDING', createdAt: new Date(), updatedAt: new Date() },
  ]
  attempts = []
  answers = []
  certificates = []
  users = [{ id: 'user-1', email: 'a@b.com', name: 'أحمد محمد', role: 'STUDENT', status: 'ACTIVE', country: null, phone: null }]
  enrollments = []
  auditRows = []
  serialSeq = 41
  seq = 0
}

function getReq(token: string) {
  return new NextRequest(`http://localhost/api/comprehensive-exams/attempt?token=${encodeURIComponent(token)}`)
}

function postReq(body: any) {
  return new NextRequest('http://localhost/api/comprehensive-exams/attempt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// Correct answers for the live attempt, computed through the real
// display mapping from the stored snapshot.
function correctAnswersForAttempt() {
  const att = attempts[0]
  const snapshot = lib.parseComprehensiveAttemptSnapshot(att.questionSnapshot)
  const display = lib.buildComprehensiveAttemptDisplay(att.id, snapshot)
  return snapshot.map((sq: any) => {
    const dq = display.find((d: any) => d.questionId === sq.questionId)!
    return { questionId: sq.questionId, selectedOption: dq.displayOptions.indexOf(sq.options[Number(sq.correctAnswer)]) }
  })
}

beforeEach(reset)

describe('attempt GET — start and resume', () => {
  test('unknown token is 404', async () => {
    const res = await attemptRoute.GET(getReq('no-such-token'))
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('INVALID_TOKEN')
  })
  test('starts a fresh attempt: shuffled display, no correct answer, invitation USED', async () => {
    const res = await attemptRoute.GET(getReq('tok-valid-1'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('STARTED')
    expect(data.questions.length).toBe(3)
    expect(data.remainingSeconds).toBe(120 * 60)
    expect(JSON.stringify(data.questions)).not.toContain('correctAnswer')
    expect(data.questions[0].displayOptions).toBeDefined()
    expect(invitations[0].status).toBe('USED')
    expect(attempts.length).toBe(1)
    expect(attempts[0].status).toBe('STARTED')
  })
  test('a second GET resumes the same attempt with the same display', async () => {
    const first = await (await attemptRoute.GET(getReq('tok-valid-1'))).json()
    const second = await attemptRoute.GET(getReq('tok-valid-1'))
    expect(second.status).toBe(200)
    const data = await second.json()
    expect(data.status).toBe('RESUMED')
    expect(data.attemptId).toBe(first.attemptId)
    expect(data.questions).toEqual(first.questions)
  })
  test('revoked invitation is 410', async () => {
    invitations[0].status = 'REVOKED'
    const res = await attemptRoute.GET(getReq('tok-valid-1'))
    expect(res.status).toBe(410)
    expect((await res.json()).code).toBe('INVITATION_REVOKED')
  })
  test('expired invitation is 410 and marked EXPIRED', async () => {
    invitations[0].expiresAt = new Date(Date.now() - 1000)
    const res = await attemptRoute.GET(getReq('tok-valid-1'))
    expect(res.status).toBe(410)
    expect((await res.json()).code).toBe('INVITATION_EXPIRED')
    expect(invitations[0].status).toBe('EXPIRED')
  })
})

describe('attempt POST — submit and grade', () => {
  test('all correct submits once, grades 100, qualifies with a COMPREHENSIVE_EXAM certificate', async () => {
    await attemptRoute.GET(getReq('tok-valid-1'))
    const res = await attemptRoute.POST(postReq({ token: 'tok-valid-1', answers: correctAnswersForAttempt() }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.score).toBe(100)
    expect(data.passed).toBe(true)
    expect(data.qualified).toBe(true)
    expect(data.certificateSerial).toMatch(/^AACT-C-/)
    expect(attempts[0].status).toBe('GRADED')
    expect(certificates.length).toBe(1)
    expect(certificates[0].type).toBe('COMPREHENSIVE_EXAM')
    expect(certificates[0].legacy).toBe(false)
    expect(certificates[0].program).toBe('دكتوراه في إدارة الأعمال')
    expect(certificates[0].comprehensiveExamId).toBe('exam-1')
    // The candidate links to the pre-registered student — no account
    // is created at qualification time.
    expect(users.length).toBe(1)
    expect(users[0].email).toBe('a@b.com')
    expect(certificates[0].userId).toBe('user-1')
    expect(enrollments[0].status).toBe('COMPLETED')
    expect(enrollments[0].programId).toBe('prog-1')
    expect(answers.length).toBe(3)
    expect(answers.every((a) => a.isCorrect)).toBe(true)
  })
  test('a second submit is 409 ALREADY_SUBMITTED', async () => {
    await attemptRoute.GET(getReq('tok-valid-1'))
    await attemptRoute.POST(postReq({ token: 'tok-valid-1', answers: correctAnswersForAttempt() }))
    const res = await attemptRoute.POST(postReq({ token: 'tok-valid-1', answers: correctAnswersForAttempt() }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('ALREADY_SUBMITTED')
    expect(certificates.length).toBe(1)
  })
  test('failing score grades below pass, no user and no certificate', async () => {
    await attemptRoute.GET(getReq('tok-valid-1'))
    const wrong = correctAnswersForAttempt().map((a: any) => {
      const att = attempts[0]
      const snapshot = lib.parseComprehensiveAttemptSnapshot(att.questionSnapshot)
      const display = lib.buildComprehensiveAttemptDisplay(att.id, snapshot)
      const dq = display.find((d: any) => d.questionId === a.questionId)!
      return { questionId: a.questionId, selectedOption: (a.selectedOption + 1) % dq.displayOptions.length }
    })
    const res = await attemptRoute.POST(postReq({ token: 'tok-valid-1', answers: wrong }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.passed).toBe(false)
    expect(data.score).toBe(0)
    expect(data.qualified).toBe(false)
    expect(certificates.length).toBe(0)
    // No account is created on a fail — the seeded student stays as-is.
    expect(users.length).toBe(1)
  })
  test('submitting after the time runs out is 410 and the attempt expires', async () => {
    await attemptRoute.GET(getReq('tok-valid-1'))
    attempts[0].startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
    const res = await attemptRoute.POST(postReq({ token: 'tok-valid-1', answers: correctAnswersForAttempt() }))
    expect(res.status).toBe(410)
    expect((await res.json()).code).toBe('ATTEMPT_EXPIRED')
    expect(attempts[0].status).toBe('EXPIRED')
    expect(certificates.length).toBe(0)
  })
  test('a duplicate that appears at qualification time keeps the graded pass but blocks the certificate', async () => {
    await attemptRoute.GET(getReq('tok-valid-1'))
    // A legacy graduate record for the same email appears between the
    // invite and the submit.
    certificates.push({ type: 'PROGRAM_COMPLETION', legacy: true, userEmail: 'a@b.com', enrollmentId: 'e-old', programId: 'spec-1' })
    const res = await attemptRoute.POST(postReq({ token: 'tok-valid-1', answers: correctAnswersForAttempt() }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.passed).toBe(true)
    expect(data.qualified).toBe(false)
    expect(data.qualificationError).toContain('موجود أصلاً كخريج')
    expect(attempts[0].status).toBe('GRADED')
    expect(attempts[0].score).toBe(100)
    expect(certificates.length).toBe(1)
  })
  test('GET after grading returns the result with the certificate serial', async () => {
    await attemptRoute.GET(getReq('tok-valid-1'))
    await attemptRoute.POST(postReq({ token: 'tok-valid-1', answers: correctAnswersForAttempt() }))
    const res = await attemptRoute.GET(getReq('tok-valid-1'))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.status).toBe('GRADED')
    expect(data.score).toBe(100)
    expect(data.certificateSerial).toMatch(/^AACT-C-/)
  })
})
