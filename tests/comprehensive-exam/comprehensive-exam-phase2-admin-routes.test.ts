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
let auditRows: any[] = []
let settings: Record<string, string> = {}
let serialSeq = 41
let seq = 0

const program = { id: 'prog-1', titleAr: 'برنامج أ', titleEn: 'Program A' }

const fakeDb: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(fakeDb),
  $queryRaw: async () => [{ value: ++serialSeq }],
  setting: {
    findUnique: async ({ where }: any) => (settings[where?.key] ? { key: where.key, value: settings[where.key] } : null),
  },
  program: {
    findUnique: async ({ where }: any) => (where?.id === program.id ? { ...program } : null),
  },
  comprehensiveExam: {
    findUnique: async ({ where }: any) => exams.find((e) => e.id === where?.id) || null,
    findFirst: async ({ where }: any = {}) =>
      exams.find((e) => (!where?.programId || e.programId === where.programId) && (!where?.status || e.status === where.status)) || null,
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
        return { ...row, exam: exam ? { id: exam.id, programId: exam.programId, title: exam.title, status: exam.status } : null }
      }
      return row
    },
    findMany: async ({ where }: any = {}) => {
      const rows = candidates.filter((c) => !where?.examId || c.examId === where.examId)
      return rows.map((c) => ({
        ...c,
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
      const row = candidates.find((c) => c.id === where?.id)
      if (!row) throw new Error('NOT_FOUND')
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
            (!where?.id || i.id === where.id) &&
            (!where?.candidateId || i.candidateId === where.candidateId) &&
            (!where?.status || i.status === where.status),
        ) || null
      if (!row) return null
      if (include?.candidate) {
        const cand = candidates.find((c) => c.id === row.candidateId)
        return { ...row, candidate: cand ? { id: cand.id, fullName: cand.fullName, email: cand.email, phone: cand.phone, examId: cand.examId } : null }
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
    findUnique: async ({ where }: any = {}) => users.find((u) => u.email === where?.email) || null,
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
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'مدير الاختبار', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => null }))
mock.module('@/lib/mailer', () => ({
  emailTemplate: (t: string, b: string) => `<h1>${t}</h1>${b}`,
  sendEmailDetailed: async () => 'SENT',
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
  exams = [{ id: 'exam-1', programId: 'prog-1', title: 'الامتحان الشامل — إدارة الأعمال', status: 'READY', durationMin: 120, passScore: 60 }]
  candidates = []
  invitations = []
  attempts = []
  certificates = []
  users = []
  enrollments = []
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
    certificates.push({ type: 'PROGRAM_COMPLETION', legacy: true, userEmail: 'a@b.com', enrollmentId: 'e1', programId: 'prog-1' })
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
  test('a second review of the same candidate is 409', async () => {
    const c = seedApprovedCandidate({ status: 'APPROVED' })
    const req = new NextRequest('http://localhost/x', { method: 'PATCH', body: JSON.stringify({ action: 'approve' }) })
    expect((await candidateRoute.PATCH(req, ctx('exam-1', c.id))).status).toBe(409)
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
})
