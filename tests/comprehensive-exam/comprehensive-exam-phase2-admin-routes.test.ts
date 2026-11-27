// Comprehensive exam phase 2 — admin routes (candidates + invitations).
// Real route code; only the DB/auth/audit/mail/WhatsApp/storage are faked.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

let exams: any[] = []
let candidates: any[] = []
let invitations: any[] = []
let attempts: any[] = []
let certificates: any[] = []
let users: any[] = []
let enrollments: any[] = []
let payments: any[] = []
let auditRows: any[] = []
let settings: Record<string, string> = {}
let serialSeq = 41
let seq = 0

const programs = [
  { id: 'prog-1', titleAr: 'برنامج المعادلة', titleEn: 'Equivalency Program', slug: 'training-certificates-equivalency', category: 'SERVICE' },
  { id: 'spec-1', titleAr: 'دكتوراه في إدارة الأعمال', titleEn: 'PhD in Business Administration', category: 'DOCTORATE' },
]

const fakeDb: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(fakeDb),
  $queryRaw: async () => [{ value: ++serialSeq }],
  setting: {
    findUnique: async ({ where }: any) => (settings[where?.key] ? { key: where.key, value: settings[where.key] } : null),
  },
  program: {
    findUnique: async ({ where }: any) => {
      const p = programs.find((x) => x.id === where?.id)
      return p ? { ...p } : null
    },
  },
  comprehensiveExam: {
    findUnique: async ({ where }: any) => {
      const row = exams.find((e) => e.id === where?.id) || null
      if (!row) return null
      const spec = row.specializationProgramId ? programs.find((p) => p.id === row.specializationProgramId) : null
      return { ...row, specializationProgram: spec ? { id: spec.id, titleAr: spec.titleAr, titleEn: spec.titleEn, category: spec.category } : null }
    },
    findFirst: async ({ where }: any = {}) =>
      exams.find((e) => (!where?.programId || e.programId === where.programId) && (!where?.status || e.status === where.status) && (!where?.specializationProgramId || e.specializationProgramId === where.specializationProgramId)) || null,
  },
  comprehensiveExamCandidate: {
    findFirst: async ({ where, include }: any = {}) => {
      const row =
        candidates.find(
          (c) =>
            (!where?.id || c.id === where.id) &&
            (!where?.examId || c.examId === where.examId) &&
            (!where?.nationalId || c.nationalId === where.nationalId) &&
            (!where?.status?.not || c.status !== where.status.not) &&
            (!where?.id?.not || c.id !== where.id.not),
        ) || null
      if (!row) return null
      if (include?.exam) {
        const exam = exams.find((e) => e.id === row.examId)
        return { ...row, exam: exam ? { id: exam.id, programId: exam.programId, specializationProgramId: exam.specializationProgramId, title: exam.title, status: exam.status } : null }
      }
      return row
    },
    findMany: async ({ where }: any = {}) => {
      const rows = candidates.filter((c) => !where?.examId || c.examId === where.examId)
      return rows.map((c) => ({
        ...c,
        manualPayment: payments.find((p) => p.comprehensiveExamCandidateId === c.id) || null,
        invitations: invitations.filter((i) => i.candidateId === c.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 1),
        attempts: attempts.filter((a) => a.candidateId === c.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 1),
      }))
    },
    create: async ({ data }: any) => {
      const row = { id: `cand-${++seq}`, status: 'PENDING_REVIEW', reviewedById: null, reviewedAt: null, rejectedReason: null, createdAt: new Date(), updatedAt: new Date(), ...data }
      candidates.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = candidates.find((c) => c.id === where?.id && (!where.status || c.status === where.status))
      if (!row) throw Object.assign(new Error('NOT_FOUND'), { code: 'P2025' })
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
  },
  comprehensiveExamInvitation: {
    findMany: async ({ where }: any = {}) => invitations.filter((i) => !where?.candidateId || i.candidateId === where.candidateId).sort((a, b) => b.createdAt - a.createdAt),
    findFirst: async ({ where, include }: any = {}) => {
      const row =
        invitations.find(
          (i) =>
            (!where?.id || (typeof where.id === 'object' ? i.id !== where.id.not : i.id === where.id)) &&
            (!where?.candidateId || i.candidateId === where.candidateId) &&
            (!where?.status || i.status === where.status),
        ) || null
      if (!row) return null
      if (include?.candidate) {
        const cand = candidates.find((c) => c.id === row.candidateId)
        return { ...row, candidate: cand ? { id: cand.id, fullName: cand.fullName, email: cand.email, phone: cand.phone, examId: cand.examId, admissionApplicationId: cand.admissionApplicationId ?? null } : null }
      }
      return row
    },
    create: async ({ data }: any) => {
      const row = { id: `inv-${++seq}`, emailStatus: null, emailError: null, whatsappStatus: null, whatsappError: null, lastSentAt: null, createdAt: new Date(), updatedAt: new Date(), ...data }
      invitations.push(row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = invitations.find((i) => i.id === where?.id)
      if (!row) throw new Error('NOT_FOUND')
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
    updateMany: async ({ where, data }: any) => {
      const row = invitations.find((i) => i.id === where?.id && (!where.status || i.status === where.status))
      if (!row) return { count: 0 }
      Object.assign(row, data, { updatedAt: new Date() })
      return { count: 1 }
    },
  },
  comprehensiveExamAttempt: {
    findFirst: async ({ where }: any = {}) =>
      attempts.find(
        (a) =>
          (!where?.candidateId || a.candidateId === where.candidateId) &&
          (!where?.status || a.status === where.status) &&
          (where?.passed === undefined || a.passed === where.passed),
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
    findMany: async ({ where }: any = {}) => {
      const rows = certificates.filter((c) => {
        if (where?.type && c.type !== where.type) return false
        if (where?.comprehensiveExamId && c.comprehensiveExamId !== where.comprehensiveExamId) return false
        if (where?.user?.email?.in && !where.user.email.in.includes(c.userEmail)) return false
        return true
      })
      return rows.map((c) => ({ ...c, user: { email: c.userEmail } }))
    },
    create: async ({ data }: any) => {
      const row = { id: `cert-${++seq}`, ...data }
      certificates.push(row)
      return row
    },
  },
  user: {
    findUnique: async ({ where }: any = {}) => users.find((u) => (where?.id ? u.id === where.id : u.email === where?.email)) || null,
    create: async ({ data }: any) => {
      const row = { id: `created-user-${++seq}`, country: null, ...data }
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
  payment: {
    findFirst: async ({ where }: any = {}) =>
      payments.find(
        (p) =>
          (!where?.admissionId || p.admissionId === where.admissionId) &&
          (!where?.comprehensiveExamCandidateId || p.comprehensiveExamCandidateId === where.comprehensiveExamCandidateId) &&
          (!where?.purpose || p.purpose === where.purpose) &&
          (!where?.status || (typeof where.status === 'string' ? p.status === where.status : (!where.status.in || where.status.in.includes(p.status)))),
      ) || null,
    findUnique: async ({ where }: any = {}) =>
      payments.find((p) => (where.id ? p.id === where.id : p.invoiceNo === where.invoiceNo)) || null,
    create: async ({ data }: any) => {
      const row = { id: `pay-${++seq}`, receiptNo: null, ...data }
      payments.push(row)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      const row = payments.find((p) => p.id === where.id && (!where.status || p.status === where.status))
      if (!row) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    },
    findMany: async ({ where }: any = {}) =>
      payments.filter(
        (p) =>
          (!where?.admissionId?.in || where.admissionId.in.includes(p.admissionId)) &&
          (!where?.admissionId || where.admissionId.in || p.admissionId === where.admissionId) &&
          (!where?.purpose || p.purpose === where.purpose) &&
          (!where?.status?.in || where.status.in.includes(p.status)),
      ),
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
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'مدير الاختبار', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => null, notify: async () => null }))
mock.module('@/lib/mailer', () => ({
  emailTemplate: (t: string, b: string) => `<h1>${t}</h1>${b}`,
  sendEmailDetailed: async () => 'SENT',
  emailPaymentReceipt: async () => true,
}))
mock.module('@/lib/settings', () => ({
  nextInvoiceNo: async () => `AACT-INV-2026-${String(payments.length + 1).padStart(4, '0')}`,
}))
mock.module('@/lib/settle-payment', () => ({
  markInvoicePaid: async (invoiceNo: string, method: string) => {
    const payment = payments.find((p) => p.invoiceNo === invoiceNo)
    if (!payment) return { ok: false, error: 'INVOICE_NOT_FOUND' }
    if (payment.status === 'UNPAID') {
      payment.status = 'PAID'
      payment.method = method
      payment.receiptNo = `AACT-REC-2026-${String(payments.length).padStart(4, '0')}`
    }
    return { ok: true, payment, receiptNo: payment.receiptNo }
  },
}))
mock.module('@/lib/whatsapp-cloud', () => ({
  sendOfficialWhatsAppTemplate: async () => ({ ok: true }),
}))
mock.module('@/lib/storage', () => ({
  storeFileBuffer: async (input: any) => ({ key: `comprehensive-exam-candidates/test-${input.fileName}`, mimeType: input.mimeType, size: input.buffer.length }),
  getStorageDownloadPathForKey: (key: string) => `/api/files/${key}`,
}))

const candidatesRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/candidates/route')
const candidateRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/candidates/[candidateId]/route')
const invitationsRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/candidates/[candidateId]/invitations/route')
const invitationRoute = await import('../../src/app/api/admin/comprehensive-exams/[id]/candidates/[candidateId]/invitations/[invitationId]/route')

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

function reset() {
  // Password setup must build a real absolute URL; CI intentionally has no public origin.
  process.env.NEXT_PUBLIC_APP_URL = 'https://academy.example.test'
  exams = [{ id: 'exam-1', programId: 'prog-1', specializationProgramId: 'spec-1', title: 'الامتحان الشامل — إدارة الأعمال', status: 'READY', durationMin: 120, passScore: 60 }]
  candidates = []
  invitations = []
  attempts = []
  certificates = []
  users = [
    { id: 'user-1', email: 'a@b.com', role: 'STUDENT' },
    { id: 'user-2', email: 'other@b.com', role: 'STUDENT' },
    { id: 'user-3', email: 'admin@b.com', role: 'ADMIN' },
  ]
  enrollments = []
  payments = []
  auditRows = []
  settings = { COMPREHENSIVE_EXAM_WHATSAPP_TEMPLATE: 'comprehensive_exam_invite_ar' }
  serialSeq = 41
  seq = 0
}

function candidateForm(over: Record<string, string> = {}) {
  const form = new FormData()
  form.append('fullName', over.fullName || 'أحمد محمد')
  form.append('nationalId', over.nationalId || '123456789')
  form.append('email', over.email || 'a@b.com')
  form.append('phone', over.phone || '0599123456')
  form.append('certificateFile', new File([png], 'cert.png', { type: 'image/png' }))
  form.append('idDocumentFile', new File([png], 'id.png', { type: 'image/png' }))
  return form
}

function ctx(examId = 'exam-1', candidateId = ''): { params: Promise<{ id: string; candidateId: string }> } {
  return { params: Promise.resolve({ id: examId, candidateId }) }
}

function seedApprovedCandidate(over: any = {}) {
  const c = {
    id: `cand-${++seq}`,
    examId: 'exam-1',
    fullName: 'أحمد محمد',
    nationalId: '123456789',
    email: 'a@b.com',
    phone: '0599123456',
    externalCertificateFileKey: 'k1',
    externalCertificateFileName: 'cert.png',
    idDocumentFileKey: 'k2',
    idDocumentFileName: 'id.png',
    status: 'APPROVED',
    rejectedReason: null,
    submittedBy: 'CANDIDATE',
    reviewedById: 'admin-1',
    reviewedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
  candidates.push(c)
  return c
}

beforeEach(reset)

describe('admin candidates — create (admin entry)', () => {
  test('creates a candidate as ADMIN with stored files', async () => {
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates', { method: 'POST', body: candidateForm() })
    const res = await candidatesRoute.POST(req, ctx())
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.candidate.submittedBy).toBe('ADMIN')
    expect(data.candidate.status).toBe('PENDING_REVIEW')
    expect(data.candidate.externalCertificateFileKey).toContain('comprehensive-exam-candidates/')
    expect(candidates.length).toBe(1)
  })
  test('duplicate national id on the same exam is 409', async () => {
    seedApprovedCandidate()
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates', {
      method: 'POST',
      body: candidateForm({ email: 'other@b.com' }),
    })
    const res = await candidatesRoute.POST(req, ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NATIONAL_ID_DUPLICATE')
  })
  test('duplicate graduate email is 409', async () => {
    certificates.push({ type: 'PROGRAM_COMPLETION', legacy: true, userEmail: 'a@b.com', enrollmentId: 'e1', programId: 'spec-1' })
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates', {
      method: 'POST',
      body: candidateForm({ nationalId: '987654321' }),
    })
    const res = await candidatesRoute.POST(req, ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('EMAIL_ALREADY_GRADUATE')
  })
  test('non-READY exam refuses new candidates', async () => {
    exams[0].status = 'DRAFT'
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates', { method: 'POST', body: candidateForm() })
    const res = await candidatesRoute.POST(req, ctx())
    expect(res.status).toBe(409)
  })
  test('existing student account is linked without creating a duplicate', async () => {
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates', { method: 'POST', body: candidateForm() })
    const res = await candidatesRoute.POST(req, ctx())
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.candidate.userId).toBe('user-1')
    expect(data.userCreated).toBe(false)
    expect(data.emailStatus).toBe('SKIPPED_EXISTING_USER')
    expect(users.length).toBe(3)
  })
  test('unknown email creates a student account and sends secure login setup instructions', async () => {
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates', {
      method: 'POST',
      body: candidateForm({ email: 'ghost@b.com' }),
    })
    const res = await candidatesRoute.POST(req, ctx())
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.userCreated).toBe(true)
    expect(data.emailStatus).toBe('SENT')
    const student = users.find((u) => u.email === 'ghost@b.com')
    expect(student.role).toBe('STUDENT')
    expect(student.status).toBe('ACTIVE')
    expect(student.password).not.toBe('123456')
    expect(student.passwordResetTokenHash).toBeTruthy()
    expect(student.passwordResetExpiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000)
    expect(data.candidate.userId).toBe(student.id)
    expect(users).toHaveLength(4)
  })
  test('non-student account is 409 NON_STUDENT_ACCOUNT', async () => {
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates', {
      method: 'POST',
      body: candidateForm({ email: 'admin@b.com' }),
    })
    const res = await candidatesRoute.POST(req, ctx())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NON_STUDENT_ACCOUNT')
  })
})

describe('admin candidates — list shows the invite gate', () => {
  test('unpaid application and admin-entered candidates both require payment before an invite', async () => {
    seedApprovedCandidate({ admissionApplicationId: 'adm-1' })
    seedApprovedCandidate({ id: 'cand-manual', nationalId: '987654321', email: 'other@b.com', submittedBy: 'ADMIN', admissionApplicationId: null })
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates')
    const res = await candidatesRoute.GET(req, { params: Promise.resolve({ id: 'exam-1' }) })
    expect(res.status).toBe(200)
    const data = await res.json()
    const fromApplication = data.candidates.find((c: any) => c.admissionApplicationId === 'adm-1')
    const manual = data.candidates.find((c: any) => c.id === 'cand-manual')
    expect(fromApplication.serviceFeePaid).toBe(false)
    expect(fromApplication.inviteBlockedReason).toBe('PAYMENT_REQUIRED')
    expect(manual.serviceFeePaid).toBe(false)
    expect(manual.inviteBlockedReason).toBe('PAYMENT_REQUIRED')
    payments.push({ id: 'pay-direct', comprehensiveExamCandidateId: manual.id, purpose: 'SERVICE_FEE', status: 'PAID', amount: 88, invoiceNo: 'AACT-INV-2026-0065', receiptNo: 'AACT-REC-2026-0065' })
    const afterPaid = await (await candidatesRoute.GET(req, { params: Promise.resolve({ id: 'exam-1' }) })).json()
    const paidCandidate = afterPaid.candidates.find((c: any) => c.id === manual.id)
    expect(paidCandidate.serviceFeePaid).toBe(true)
    expect(paidCandidate.inviteBlockedReason).toBe(null)
    expect(paidCandidate.manualPayment.receiptNo).toBe('AACT-REC-2026-0065')
  })
  test('a PAID fee clears the gate; a DRAFT exam blocks everyone with EXAM_NOT_READY', async () => {
    payments.push({ id: 'pay-1', admissionId: 'adm-1', purpose: 'SERVICE_FEE', status: 'PAID' })
    seedApprovedCandidate({ admissionApplicationId: 'adm-1' })
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates')
    const paid = await (await candidatesRoute.GET(req, { params: Promise.resolve({ id: 'exam-1' }) })).json()
    expect(paid.candidates[0].serviceFeePaid).toBe(true)
    expect(paid.candidates[0].inviteBlockedReason).toBe(null)
    exams[0].status = 'DRAFT'
    const draft = await (await candidatesRoute.GET(req, { params: Promise.resolve({ id: 'exam-1' }) })).json()
    expect(draft.candidates[0].inviteBlockedReason).toBe('EXAM_NOT_READY')
  })
  test('the candidates list returns the saved stamp layout for a passed candidate', async () => {
    const c = seedApprovedCandidate()
    attempts.push({ id: 'att-1', candidateId: c.id, status: 'GRADED', passed: true, score: 80, startedAt: new Date(), submittedAt: new Date(), createdAt: new Date() })
    const dragged = JSON.stringify({ qr: { x: 72, y: 30, size: 22, visible: true }, serial: { x: 72, y: 44, width: 34, fontSize: 1.6, visible: true } })
    certificates.push({ id: 'cert-1', type: 'COMPREHENSIVE_EXAM', comprehensiveExamId: 'exam-1', userEmail: 'a@b.com', serial: 'AACT-C-2026-00042', uploadedFileKey: 'k', stampedFileKey: 's', qrPosition: dragged, qrSize: 'CUSTOM' })
    const req = new NextRequest('http://localhost/api/admin/comprehensive-exams/exam-1/candidates')
    const res = await candidatesRoute.GET(req, { params: Promise.resolve({ id: 'exam-1' }) })
    expect(res.status).toBe(200)
    const data = await res.json()
    const row = data.candidates.find((x: any) => x.id === c.id)
    expect(row.attempt.certificateSerial).toBe('AACT-C-2026-00042')
    expect(row.attempt.certificateQrPosition).toBe(dragged)
    expect(row.attempt.certificateQrSize).toBe('CUSTOM')
  })
})

describe('admin candidates — review', () => {
  test('approve moves PENDING_REVIEW to APPROVED', async () => {
    const c = seedApprovedCandidate({ status: 'PENDING_REVIEW', reviewedById: null, reviewedAt: null })
    const req = new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) })
    const res = await candidateRoute.PATCH(req, ctx('exam-1', c.id))
    expect(res.status).toBe(200)
    expect(candidates[0].status).toBe('APPROVED')
  })
  test('reject without a reason is 400; with a reason it is REJECTED', async () => {
    const c = seedApprovedCandidate({ status: 'PENDING_REVIEW', reviewedById: null, reviewedAt: null })
    const bad = new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ action: 'reject' }) })
    expect((await candidateRoute.PATCH(bad, ctx('exam-1', c.id))).status).toBe(400)
    const ok = new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ action: 'reject', rejectedReason: 'الشهادة غير واضحة' }) })
    const res = await candidateRoute.PATCH(ok, ctx('exam-1', c.id))
    expect(res.status).toBe(200)
    expect(candidates[0].status).toBe('REJECTED')
    expect(candidates[0].rejectedReason).toBe('الشهادة غير واضحة')
  })
  test('simultaneous approve/reject clicks cannot both change a candidate', async () => {
    const c = seedApprovedCandidate({ status: 'PENDING_REVIEW', reviewedById: null, reviewedAt: null })
    const responses = await Promise.all([
      candidateRoute.PATCH(new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) }), ctx('exam-1', c.id)),
      candidateRoute.PATCH(new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ action: 'reject', rejectedReason: 'ملف مرفوض' }) }), ctx('exam-1', c.id)),
    ])
    expect(responses.map((res) => res.status).sort()).toEqual([200, 409])
    expect(['APPROVED', 'REJECTED']).toContain(candidates[0].status)
  })
  test('a second review of the same candidate is 409', async () => {
    const c = seedApprovedCandidate({ status: 'APPROVED' })
    const req = new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) })
    expect((await candidateRoute.PATCH(req, ctx('exam-1', c.id))).status).toBe(409)
  })
})

describe('admin direct payment — official invoice and receipt', () => {
  test('records the actual amount once, issues a receipt and unblocks the exam invitation', async () => {
    const c = seedApprovedCandidate({ submittedBy: 'ADMIN', userId: 'user-1' })
    const blocked = await invitationsRoute.POST(new NextRequest('http://localhost/x', { method: 'POST' }), ctx('exam-1', c.id))
    expect(blocked.status).toBe(409)
    expect((await blocked.json()).code).toBe('PAYMENT_REQUIRED')

    const payload = { action: 'record_paid', amount: '88.50', note: 'استلمت الإدارة المبلغ نقداً' }
    const first = await candidateRoute.POST(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify(payload) }), ctx('exam-1', c.id))
    expect(first.status).toBe(200)
    const result = await first.json()
    expect(result.created).toBe(true)
    expect(result.payment.amount).toBe(88.5)
    expect(result.payment.status).toBe('PAID')
    expect(result.payment.invoiceNo).toMatch(/^AACT-INV-/)
    expect(result.payment.receiptNo).toMatch(/^AACT-REC-/)
    expect(payments).toHaveLength(1)
    expect(payments[0].purpose).toBe('SERVICE_FEE')
    expect(payments[0].userId).toBe('user-1')
    expect(payments[0].comprehensiveExamCandidateId).toBe(c.id)
    expect(payments[0].amountCents).toBe(8850)

    const duplicate = await candidateRoute.POST(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify(payload) }), ctx('exam-1', c.id))
    expect(duplicate.status).toBe(200)
    expect((await duplicate.json()).created).toBe(false)
    expect(payments).toHaveLength(1)

    const differentAmount = await candidateRoute.POST(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ ...payload, amount: '90' }) }), ctx('exam-1', c.id))
    expect(differentAmount.status).toBe(409)
    expect((await differentAmount.json()).code).toBe('PAYMENT_ALREADY_RECORDED')

    const allowed = await invitationsRoute.POST(new NextRequest('http://localhost/x', { method: 'POST' }), ctx('exam-1', c.id))
    expect(allowed.status).toBe(201)
  })

  test('does not accept invalid money or a pending-review candidate', async () => {
    const c = seedApprovedCandidate({ submittedBy: 'ADMIN', userId: 'user-1' })
    const invalid = await candidateRoute.POST(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'record_paid', amount: '88.999', note: 'استلام نقدي' }) }), ctx('exam-1', c.id))
    expect(invalid.status).toBe(400)
    const zero = await candidateRoute.POST(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'record_paid', amount: '0', note: 'استلام نقدي' }) }), ctx('exam-1', c.id))
    expect(zero.status).toBe(400)
    c.status = 'PENDING_REVIEW'
    const pending = await candidateRoute.POST(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'record_paid', amount: '88', note: 'استلام نقدي' }) }), ctx('exam-1', c.id))
    expect(pending.status).toBe(409)
    expect(payments).toHaveLength(0)
  })

  test('admin can resend the one-time login setup link', async () => {
    const c = seedApprovedCandidate({ submittedBy: 'ADMIN', userId: 'user-1' })
    const res = await candidateRoute.POST(new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'resend_account_setup' }) }), ctx('exam-1', c.id))
    expect(res.status).toBe(200)
    expect((await res.json()).emailStatus).toBe('SENT')
    expect(users[0].passwordResetTokenHash).toBeTruthy()
  })
})

describe('admin candidates — qualify retry', () => {
  test('retries qualification for a passed attempt without a certificate', async () => {
    const c = seedApprovedCandidate()
    attempts.push({ id: 'att-1', invitationId: 'inv-0', candidateId: c.id, examId: 'exam-1', status: 'GRADED', score: 80, passed: true, startedAt: new Date(), submittedAt: new Date(), createdAt: new Date() })
    const req = new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'qualify' }) })
    const res = await candidateRoute.POST(req, ctx('exam-1', c.id))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.certificate.serial).toMatch(/^AACT-C-/)
    expect(certificates[0].type).toBe('COMPREHENSIVE_EXAM')
    expect(certificates[0].program).toBe('دكتوراه في إدارة الأعمال')
    expect(enrollments[0].programId).toBe('prog-1')
  })
  test('no passed attempt is 409', async () => {
    const c = seedApprovedCandidate()
    const req = new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'qualify' }) })
    expect((await candidateRoute.POST(req, ctx('exam-1', c.id))).status).toBe(409)
  })
})

describe('admin invitations — issue', () => {
  test('issues an invitation and records both channels SENT', async () => {
    const c = seedApprovedCandidate()
    const req = new NextRequest('http://localhost/x', { method: 'POST' })
    const res = await invitationsRoute.POST(req, ctx('exam-1', c.id))
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.invitation.status).toBe('PENDING')
    expect(data.delivery.email.status).toBe('SENT')
    expect(data.delivery.whatsapp.status).toBe('SENT')
    expect(data.invitation.inviteUrl).toContain('/comprehensive-exam/')
    expect(invitations[0].emailStatus).toBe('SENT')
    expect(invitations[0].whatsappStatus).toBe('SENT')
  })
  test('a second live invitation is 409', async () => {
    const c = seedApprovedCandidate()
    const req = new NextRequest('http://localhost/x', { method: 'POST' })
    await invitationsRoute.POST(req, ctx('exam-1', c.id))
    const req2 = new NextRequest('http://localhost/x', { method: 'POST' })
    const res = await invitationsRoute.POST(req2, ctx('exam-1', c.id))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('LIVE_INVITATION_EXISTS')
  })
  test('unapproved candidate cannot be invited', async () => {
    const c = seedApprovedCandidate({ status: 'PENDING_REVIEW' })
    const req = new NextRequest('http://localhost/x', { method: 'POST' })
    expect((await invitationsRoute.POST(req, ctx('exam-1', c.id))).status).toBe(409)
  })
  test('a passed candidate cannot be invited again', async () => {
    const c = seedApprovedCandidate()
    attempts.push({ id: 'att-1', invitationId: 'inv-0', candidateId: c.id, examId: 'exam-1', status: 'GRADED', score: 80, passed: true, startedAt: new Date(), submittedAt: new Date(), createdAt: new Date() })
    const req = new NextRequest('http://localhost/x', { method: 'POST' })
    expect((await invitationsRoute.POST(req, ctx('exam-1', c.id))).status).toBe(409)
  })
  test('application candidate without a paid fee is 409 PAYMENT_REQUIRED', async () => {
    const c = seedApprovedCandidate({ admissionApplicationId: 'adm-1' })
    const req = new NextRequest('http://localhost/x', { method: 'POST' })
    const res = await invitationsRoute.POST(req, ctx('exam-1', c.id))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PAYMENT_REQUIRED')
    expect(invitations.length).toBe(0)
  })
  test('a PENDING fee does not pass the gate; PAID and WAIVED do', async () => {
    const c = seedApprovedCandidate({ admissionApplicationId: 'adm-1' })
    payments.push({ id: 'pay-1', admissionId: 'adm-1', purpose: 'SERVICE_FEE', status: 'PENDING' })
    const pendingReq = new NextRequest('http://localhost/x', { method: 'POST' })
    expect((await invitationsRoute.POST(pendingReq, ctx('exam-1', c.id))).status).toBe(409)
    payments[0].status = 'PAID'
    const paidReq = new NextRequest('http://localhost/x', { method: 'POST' })
    expect((await invitationsRoute.POST(paidReq, ctx('exam-1', c.id))).status).toBe(201)
    const c2 = seedApprovedCandidate({ id: 'cand-waived', nationalId: '222222222', email: 'other@b.com', admissionApplicationId: 'adm-2' })
    payments.push({ id: 'pay-2', admissionId: 'adm-2', purpose: 'SERVICE_FEE', status: 'WAIVED' })
    const waivedReq = new NextRequest('http://localhost/x', { method: 'POST' })
    expect((await invitationsRoute.POST(waivedReq, ctx('exam-1', c2.id))).status).toBe(201)
  })
  test('a DRAFT exam blocks the invitation with EXAM_NOT_READY', async () => {
    exams[0].status = 'DRAFT'
    const c = seedApprovedCandidate()
    const req = new NextRequest('http://localhost/x', { method: 'POST' })
    const res = await invitationsRoute.POST(req, ctx('exam-1', c.id))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('EXAM_NOT_READY')
  })
})

describe('admin invitations — renew and revoke', () => {
  test('renewal kills the old token and issues a fresh 7-day one', async () => {
    const c = seedApprovedCandidate()
    const issueReq = new NextRequest('http://localhost/x', { method: 'POST' })
    const issued = await (await invitationsRoute.POST(issueReq, ctx('exam-1', c.id))).json()
    const oldId = issued.invitation.id
    const oldToken = invitations[0].token
    const renewReq = new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'renew' }) })
    const res = await invitationRoute.POST(renewReq, { params: Promise.resolve({ id: 'exam-1', candidateId: c.id, invitationId: oldId }) })
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.invitation.id).not.toBe(oldId)
    expect(invitations.find((i) => i.id === oldId)?.status).toBe('REVOKED')
    expect(invitations.find((i) => i.id === data.invitation.id)?.token).not.toBe(oldToken)
    expect(new Date(data.invitation.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000)
    expect(data.delivery.email.status).toBe('SENT')
  })
  test('revoke turns PENDING into REVOKED; a second revoke is 409', async () => {
    const c = seedApprovedCandidate()
    const issueReq = new NextRequest('http://localhost/x', { method: 'POST' })
    const issued = await (await invitationsRoute.POST(issueReq, ctx('exam-1', c.id))).json()
    const invId = issued.invitation.id
    const revokeReq = new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'revoke' }) })
    const res = await invitationRoute.POST(revokeReq, { params: Promise.resolve({ id: 'exam-1', candidateId: c.id, invitationId: invId }) })
    expect(res.status).toBe(200)
    expect(invitations[0].status).toBe('REVOKED')
    const again = new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'revoke' }) })
    expect((await invitationRoute.POST(again, { params: Promise.resolve({ id: 'exam-1', candidateId: c.id, invitationId: invId }) })).status).toBe(409)
  })
  test('renewing a REVOKED invitation is 409', async () => {
    const c = seedApprovedCandidate()
    const issueReq = new NextRequest('http://localhost/x', { method: 'POST' })
    const issued = await (await invitationsRoute.POST(issueReq, ctx('exam-1', c.id))).json()
    const invId = issued.invitation.id
    invitations[0].status = 'REVOKED'
    const renewReq = new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'renew' }) })
    expect((await invitationRoute.POST(renewReq, { params: Promise.resolve({ id: 'exam-1', candidateId: c.id, invitationId: invId }) })).status).toBe(409)
  })
  test('renewal for an unpaid application candidate is 409 PAYMENT_REQUIRED', async () => {
    const c = seedApprovedCandidate({ admissionApplicationId: 'adm-1' })
    invitations.push({ id: 'inv-1', candidateId: c.id, token: 'tok-1', status: 'PENDING', expiresAt: new Date(Date.now() + 1000), createdAt: new Date(), updatedAt: new Date() })
    const renewReq = new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ action: 'renew' }) })
    const res = await invitationRoute.POST(renewReq, { params: Promise.resolve({ id: 'exam-1', candidateId: c.id, invitationId: 'inv-1' }) })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('PAYMENT_REQUIRED')
    expect(invitations[0].status).toBe('PENDING')
  })
})
