// Comprehensive exam phase 2 — lib unit tests.
// Real lib code; only the DB/mail/WhatsApp/storage are faked.
import { describe, expect, mock, test } from 'bun:test'

let candidates: any[] = []
let certificates: any[] = []
let users: any[] = []
let enrollments: any[] = []
let auditRows: any[] = []
let settings: Record<string, string> = {}
let sentEmails: any[] = []
let sentWhatsApps: any[] = []
let serialSeq = 41

const fakeDb: any = {
  setting: {
    findUnique: async ({ where }: any) => (settings[where?.key] ? { key: where.key, value: settings[where.key] } : null),
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
        if (Array.isArray(where?.OR)) {
          const ok = where.OR.some(
            (cond: any) => (cond.legacy === true && c.legacy === true) || (cond.type && c.type === cond.type),
          )
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
      const row = { id: `cert-${certificates.length + 1}`, ...data }
      certificates.push(row)
      return row
    },
  },
  user: {
    findUnique: async ({ where }: any = {}) =>
      users.find((u) => (where?.id ? u.id === where.id : u.email === where?.email)) || null,
    create: async ({ data }: any) => {
      const row = { id: `user-${users.length + 1}`, country: null, ...data }
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
      const row = { id: `enr-${enrollments.length + 1}`, ...create, ...update }
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
      const row = { id: `audit-${auditRows.length + 1}`, ...data }
      auditRows.push(row)
      return row
    },
  },
  $queryRaw: async () => [{ value: ++serialSeq }],
  $transaction: async (work: (tx: any) => Promise<any>) => work(fakeDb),
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/mailer', () => ({
  emailTemplate: (title: string, body: string, cta?: any) => `<h1>${title}</h1>${body}${cta ? cta.label : ''}`,
  sendEmailDetailed: async (input: any) => {
    sentEmails.push(input)
    return 'SENT'
  },
}))
mock.module('@/lib/whatsapp-cloud', () => ({
  sendOfficialWhatsAppTemplate: async (to: string, template: string, params: string[]) => {
    sentWhatsApps.push({ to, template, params })
    return { ok: true }
  },
}))
mock.module('@/lib/storage', () => ({
  storeFileBuffer: async (input: any) => ({ key: `comprehensive-exam-candidates/test-${input.fileName}`, mimeType: input.mimeType, size: input.buffer.length }),
  getStorageDownloadPathForKey: (key: string) => `/api/files/${key}`,
}))

const lib = await import('../../src/lib/comprehensive-exam-phase2')

function reset() {
  candidates = []
  certificates = []
  users = []
  enrollments = []
  auditRows = []
  settings = {}
  sentEmails = []
  sentWhatsApps = []
  serialSeq = 41
}

const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

describe('candidate input validation', () => {
  test('accepts a complete valid candidate', () => {
    const r = lib.validateComprehensiveCandidateInput({ fullName: 'أحمد محمد', nationalId: '123456789', email: 'Ahmad@Example.com', phone: '0599123456' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.email).toBe('ahmad@example.com')
      expect(r.data.nationalId).toBe('123456789')
    }
  })
  test('rejects short name, bad email, bad national id, bad phone', () => {
    const r = lib.validateComprehensiveCandidateInput({ fullName: 'أح', nationalId: 'ab', email: 'not-an-email', phone: '123' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(4)
  })
  test('normalizes Arabic digits and strips separators in the national id', () => {
    expect(lib.normalizeComprehensiveNationalId('١٢٣-٤٥٦ ٧٨٩')).toBe('123456789')
    expect(lib.normalizeComprehensiveNationalId(' 123 456 ')).toBe('123456')
  })
})

describe('candidate file validation', () => {
  test('accepts a PNG by magic bytes', () => {
    const r = lib.validateComprehensiveCandidateFile({ name: 'cert.png', size: 1024, type: 'image/png', buffer: pngHeader })
    expect(r.ok).toBe(true)
  })
  test('rejects a file whose bytes do not match any allowed kind', () => {
    const r = lib.validateComprehensiveCandidateFile({ name: 'cert.png', size: 1024, type: 'image/png', buffer: Buffer.from('MZ fake exe') })
    expect(r.ok).toBe(false)
  })
  test('rejects an oversized file', () => {
    const r = lib.validateComprehensiveCandidateFile({ name: 'cert.pdf', size: 11 * 1024 * 1024, type: 'application/pdf', buffer: Buffer.from('%PDF-1.4') })
    expect(r.ok).toBe(false)
  })
})

describe('invite tokens', () => {
  test('tokens are 64 hex chars and unique', () => {
    const a = lib.createComprehensiveExamInviteToken()
    const b = lib.createComprehensiveExamInviteToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
  test('expiry is 7 days from now', () => {
    const before = Date.now()
    const exp = lib.comprehensiveExamInviteExpiresAt()
    expect(exp.getTime() - before).toBeGreaterThan(7 * 24 * 60 * 60 * 1000 - 5000)
    expect(exp.getTime() - before).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000)
  })
  test('constant-time comparison: equal, different, different length', () => {
    expect(lib.tokensEqual('abc123', 'abc123')).toBe(true)
    expect(lib.tokensEqual('abc123', 'abc124')).toBe(false)
    expect(lib.tokensEqual('abc123', 'abc1234')).toBe(false)
    expect(lib.tokensEqual('', '')).toBe(false)
  })
})

describe('seeded shuffle and grading', () => {
  // Snapshot input shape: options as a JSON string, correctAnswer as the
  // stored index string — exactly what the questions table holds.
  const questions = [
    { id: 'q1', order: 0, type: 'MCQ', text: 'س1', options: JSON.stringify(['أ', 'ب', 'ج', 'د']), correctAnswer: '1' },
    { id: 'q2', order: 1, type: 'TF', text: 'س2', options: JSON.stringify(['صح', 'خطأ']), correctAnswer: '0' },
    { id: 'q3', order: 2, type: 'MCQ', text: 'س3', options: JSON.stringify(['أ', 'ب', 'ج']), correctAnswer: '2' },
  ]
  const snapOf = () => lib.buildComprehensiveAttemptSnapshot(questions as any)
  const displayOf = (snap: any, attemptId: string) => lib.buildComprehensiveAttemptDisplay(attemptId, snap)
  const correctDisplayAnswers = (snap: any, display: any) =>
    snap.map((sq: any) => {
      const dq = display.find((d: any) => d.questionId === sq.questionId)!
      const correctText = sq.options[Number(sq.correctAnswer)]
      return { questionId: sq.questionId, selectedOption: dq.displayOptions.indexOf(correctText) }
    })

  test('same attempt id gives the same display order; a different id reshuffles', () => {
    const snap = snapOf()
    const d1 = displayOf(snap, 'attempt-1')
    const d2 = displayOf(snap, 'attempt-1')
    const d3 = displayOf(snap, 'attempt-2')
    expect(d1).toEqual(d2)
    expect(JSON.stringify(d3)).not.toBe(JSON.stringify(d1))
  })
  test('display never carries the correct answer', () => {
    const snap = snapOf()
    const display = displayOf(snap, 'attempt-1')
    expect(JSON.stringify(display)).not.toContain('correctAnswer')
    expect(display[0].displayToReal).toHaveLength(display[0].displayOptions.length)
  })
  test('snapshot round-trips through parse', () => {
    const snap = snapOf()
    expect(lib.parseComprehensiveAttemptSnapshot(JSON.stringify(snap))).toEqual(snap)
  })
  test('all correct through the display mapping grades 100 and passes', () => {
    const snap = snapOf()
    const display = displayOf(snap, 'attempt-1')
    const graded = lib.gradeComprehensiveAttempt({
      attemptId: 'attempt-1',
      snapshot: snap,
      display,
      answers: correctDisplayAnswers(snap, display),
      passScore: 60,
    })
    expect(graded.score).toBe(100)
    expect(graded.passed).toBe(true)
    expect(graded.earnedPoints).toBe(6)
  })
  test('one of three correct grades 33.33 and fails at pass 60', () => {
    const snap = snapOf()
    const display = displayOf(snap, 'attempt-1')
    const answers = correctDisplayAnswers(snap, display).map((a: any) => {
      if (a.questionId === 'q1') return a
      const dq = display.find((d: any) => d.questionId === a.questionId)!
      return { questionId: a.questionId, selectedOption: (a.selectedOption + 1) % dq.displayOptions.length }
    })
    const graded = lib.gradeComprehensiveAttempt({ attemptId: 'attempt-1', snapshot: snap, display, answers, passScore: 60 })
    expect(graded.earnedPoints).toBe(2)
    expect(graded.score).toBe(33.33)
    expect(graded.passed).toBe(false)
  })
  test('unanswered questions score zero, never throw', () => {
    const snap = snapOf()
    const display = displayOf(snap, 'attempt-1')
    const graded = lib.gradeComprehensiveAttempt({ attemptId: 'attempt-1', snapshot: snap, display, answers: [], passScore: 60 })
    expect(graded.score).toBe(0)
    expect(graded.passed).toBe(false)
  })
  test('a question with an out-of-range answer key throws instead of grading by guesswork', () => {
    const badSnap = [{ questionId: 'q9', order: 0, type: 'MCQ', text: 'س', options: ['أ', 'ب'], correctAnswer: '99' }]
    const display = displayOf(badSnap, 'attempt-1')
    expect(() =>
      lib.gradeComprehensiveAttempt({
        attemptId: 'attempt-1',
        snapshot: badSnap,
        display,
        answers: [{ questionId: 'q9', selectedOption: 0 }],
        passScore: 60,
      }),
    ).toThrow()
  })
})

describe('dedupe', () => {
  test('clean candidate passes', async () => {
    reset()
    const r = await lib.checkComprehensiveCandidateDuplicate(fakeDb, { examId: 'exam-1', programId: 'prog-1', nationalId: '111', email: 'a@b.com' })
    expect(r).toBeNull()
  })
  test('same national id on the same exam is a duplicate', async () => {
    reset()
    candidates.push({ examId: 'exam-1', nationalId: '111', email: 'other@b.com', status: 'PENDING_REVIEW' })
    const r = await lib.checkComprehensiveCandidateDuplicate(fakeDb, { examId: 'exam-1', programId: 'prog-1', nationalId: '111', email: 'a@b.com' })
    expect(r?.code).toBe('NATIONAL_ID_DUPLICATE')
    expect(lib.checkComprehensiveDuplicateError(r)?.status).toBe(409)
  })
  test('a REJECTED candidate does not block re-application', async () => {
    reset()
    candidates.push({ examId: 'exam-1', nationalId: '111', email: 'a@b.com', status: 'REJECTED' })
    const r = await lib.checkComprehensiveCandidateDuplicate(fakeDb, { examId: 'exam-1', programId: 'prog-1', nationalId: '111', email: 'a@b.com' })
    expect(r).toBeNull()
  })
  test('an existing graduate certificate for the email blocks the same specialization', async () => {
    reset()
    certificates.push({
      type: 'COMPREHENSIVE_EXAM', userEmail: 'a@b.com', enrollmentId: 'e1', programId: 'prog-1',
      specializationProgramId: 'spec-1', examProgramId: 'prog-1',
    })
    const r = await lib.checkComprehensiveCandidateDuplicate(fakeDb, { examId: 'exam-1', programId: 'prog-1', specializationProgramId: 'spec-1', nationalId: '222', email: 'a@b.com' })
    expect(r?.code).toBe('EMAIL_ALREADY_GRADUATE')
  })
  test('the same email is allowed for a different specialization', async () => {
    reset()
    certificates.push({
      type: 'COMPREHENSIVE_EXAM', userEmail: 'a@b.com', enrollmentId: 'e1', programId: 'prog-1',
      specializationProgramId: 'spec-1', examProgramId: 'prog-1',
    })
    const r = await lib.checkComprehensiveCandidateDuplicate(fakeDb, { examId: 'exam-2', programId: 'prog-1', specializationProgramId: 'spec-2', nationalId: '222', email: 'a@b.com' })
    expect(r).toBeNull()
  })
  test('a legacy graduate certificate for the email blocks the same specialization only', async () => {
    reset()
    certificates.push({ type: 'PROGRAM_COMPLETION', legacy: true, userEmail: 'a@b.com', enrollmentId: 'e1', programId: 'spec-1' })
    const same = await lib.checkComprehensiveCandidateDuplicate(fakeDb, { examId: 'exam-1', programId: 'prog-1', specializationProgramId: 'spec-1', nationalId: '222', email: 'a@b.com' })
    expect(same?.code).toBe('EMAIL_ALREADY_GRADUATE')
    const other = await lib.checkComprehensiveCandidateDuplicate(fakeDb, { examId: 'exam-2', programId: 'prog-1', specializationProgramId: 'spec-2', nationalId: '222', email: 'a@b.com' })
    expect(other).toBeNull()
  })
})

describe('qualification transaction', () => {
  test('qualifies an existing student user — never creates an account', async () => {
    reset()
    users.push({ id: 'user-9', email: 'a@b.com', name: 'أحمد محمد', role: 'STUDENT', status: 'ACTIVE', country: null, phone: null })
    const result = await lib.qualifyComprehensiveExamCandidate(fakeDb, {
      candidate: { id: 'cand-1', fullName: 'أحمد محمد', nationalId: '111', email: 'a@b.com', phone: '0599' },
      exam: { id: 'exam-1', programId: 'prog-1' },
      program: { id: 'prog-1', titleAr: 'برنامج المعادلة', titleEn: null },
      specialization: { id: 'spec-1', titleAr: 'دكتوراه في إدارة الأعمال', titleEn: null },
      attempt: { id: 'att-1', score: 85 },
      admin: { id: null, name: null },
    })
    expect(result.userCreated).toBe(false)
    expect(result.user.id).toBe('user-9')
    expect(users.length).toBe(1)
    expect(result.certificate.serial).toMatch(/^AACT-C-\d{4}-\d{5}$/)
    expect(enrollments[0].status).toBe('COMPLETED')
    expect(enrollments[0].programId).toBe('prog-1')
    expect(certificates[0].type).toBe('COMPREHENSIVE_EXAM')
    expect(certificates[0].legacy).toBe(false)
    expect(certificates[0].program).toBe('دكتوراه في إدارة الأعمال')
    expect(certificates[0].grade).toBe('85%')
    expect(certificates[0].comprehensiveExamId).toBe('exam-1')
    expect(auditRows[0].action).toBe('QUALIFY_COMPREHENSIVE_EXAM')
  })
  test('resolves the linked user by id first, even when the email differs', async () => {
    reset()
    users.push({ id: 'user-9', email: 'old@b.com', name: 'أحمد محمد', role: 'STUDENT', status: 'ACTIVE', country: null, phone: null })
    const result = await lib.qualifyComprehensiveExamCandidate(fakeDb, {
      candidate: { id: 'cand-1', userId: 'user-9', fullName: 'أحمد محمد', nationalId: '111', email: 'a@b.com', phone: '0599' },
      exam: { id: 'exam-1', programId: 'prog-1' },
      program: { id: 'prog-1', titleAr: 'برنامج المعادلة', titleEn: null },
      specialization: { id: 'spec-1', titleAr: 'دكتوراه في إدارة الأعمال', titleEn: null },
      attempt: { id: 'att-1', score: 70 },
      admin: { id: null, name: null },
    })
    expect(result.userCreated).toBe(false)
    expect(result.user.id).toBe('user-9')
    expect(users.length).toBe(1)
    expect(certificates.length).toBe(1)
  })
  test('a missing user is a visible 409 USER_NOT_FOUND and creates nothing', async () => {
    reset()
    await expect(
      lib.qualifyComprehensiveExamCandidate(fakeDb, {
        candidate: { id: 'cand-1', fullName: 'أحمد محمد', nationalId: '111', email: 'a@b.com', phone: '0599' },
        exam: { id: 'exam-1', programId: 'prog-1' },
        program: { id: 'prog-1', titleAr: 'برنامج المعادلة', titleEn: null },
        specialization: { id: 'spec-1', titleAr: 'دكتوراه في إدارة الأعمال', titleEn: null },
        attempt: { id: 'att-1', score: 70 },
        admin: { id: null, name: null },
      }),
    ).rejects.toMatchObject({ code: 'USER_NOT_FOUND', status: 409 })
    expect(users.length).toBe(0)
    expect(certificates.length).toBe(0)
    expect(enrollments.length).toBe(0)
  })
  test('a non-student account is 409 NON_STUDENT_ACCOUNT', async () => {
    reset()
    users.push({ id: 'user-9', email: 'a@b.com', name: 'مدير', role: 'ADMIN', status: 'ACTIVE', country: null, phone: null })
    await expect(
      lib.qualifyComprehensiveExamCandidate(fakeDb, {
        candidate: { id: 'cand-1', fullName: 'أحمد محمد', nationalId: '111', email: 'a@b.com', phone: '0599' },
        exam: { id: 'exam-1', programId: 'prog-1' },
        program: { id: 'prog-1', titleAr: 'برنامج المعادلة', titleEn: null },
        specialization: { id: 'spec-1', titleAr: 'دكتوراه في إدارة الأعمال', titleEn: null },
        attempt: { id: 'att-1', score: 70 },
        admin: { id: null, name: null },
      }),
    ).rejects.toMatchObject({ code: 'NON_STUDENT_ACCOUNT', status: 409 })
    expect(certificates.length).toBe(0)
  })
  test('a duplicate inside the transaction aborts qualification', async () => {
    reset()
    certificates.push({ type: 'PROGRAM_COMPLETION', legacy: true, userEmail: 'a@b.com', enrollmentId: 'e1', programId: 'spec-1' })
    await expect(
      lib.qualifyComprehensiveExamCandidate(fakeDb, {
        candidate: { id: 'cand-1', fullName: 'أحمد محمد', nationalId: '111', email: 'a@b.com', phone: '0599' },
        exam: { id: 'exam-1', programId: 'prog-1' },
        program: { id: 'prog-1', titleAr: 'برنامج المعادلة', titleEn: null },
        specialization: { id: 'spec-1', titleAr: 'دكتوراه في إدارة الأعمال', titleEn: null },
        attempt: { id: 'att-1', score: 70 },
        admin: { id: null, name: null },
      }),
    ).rejects.toThrow('موجود أصلاً كخريج')
    expect(users.length).toBe(0)
    expect(certificates.length).toBe(1)
  })
})
