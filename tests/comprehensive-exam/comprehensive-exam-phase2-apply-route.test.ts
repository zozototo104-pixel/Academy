// Comprehensive exam phase 2 — public apply route.
// Real route code; only the DB/rate-limit/storage are faked.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

let exams: any[] = []
let candidates: any[] = []
let certificates: any[] = []
let rateAllowed = true
let seq = 0

const fakeDb: any = {
  comprehensiveExam: {
    findFirst: async ({ where }: any = {}) =>
      exams.find((e) => (!where?.programId || e.programId === where.programId) && (!where?.status || e.status === where.status)) || null,
  },
  comprehensiveExamCandidate: {
    findFirst: async ({ where }: any = {}) =>
      candidates.find(
        (c) =>
          (!where?.examId || c.examId === where.examId) &&
          (!where?.nationalId || c.nationalId === where.nationalId) &&
          (!where?.status?.not || c.status !== where.status.not),
      ) || null,
    create: async ({ data }: any) => {
      const row = { id: `cand-${++seq}`, status: 'PENDING_REVIEW', submittedBy: 'CANDIDATE', createdAt: new Date(), ...data }
      candidates.push(row)
      return row
    },
  },
  certificate: {
    findFirst: async ({ where }: any = {}) => {
      const rows = certificates.filter((c) => {
        if (where?.enrollment?.programId && c.programId !== where.enrollment.programId) return false
        if (where?.user?.email && c.userEmail !== where.user.email) return false
        if (Array.isArray(where?.OR)) {
          const ok = where.OR.some((cond: any) => (cond.legacy === true && c.legacy === true) || (cond.type && c.type === cond.type))
          if (!ok) return false
        }
        return true
      })
      return rows[0] || null
    },
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/rate-limit', () => ({
  // Real RateLimitResult shape: { ok, remaining, resetAt, retryAfterSec } — no `allowed`.
  checkRateLimit: async () => ({ ok: rateAllowed, remaining: rateAllowed ? 4 : 0, resetAt: Date.now() + 600_000, retryAfterSec: rateAllowed ? 0 : 600 }),
  clientIpFromHeaders: () => '1.2.3.4',
}))
mock.module('@/lib/storage', () => ({
  storeFileBuffer: async (input: any) => ({ key: `comprehensive-exam-candidates/test-${input.fileName}`, mimeType: input.mimeType, size: input.buffer.length }),
}))
mock.module('@/lib/mailer', () => ({ emailTemplate: () => '', sendEmailDetailed: async () => 'SENT' }))
mock.module('@/lib/whatsapp-cloud', () => ({ sendOfficialWhatsAppTemplate: async () => ({ ok: true }) }))

const applyRoute = await import('../../src/app/api/comprehensive-exams/apply/route')

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

function reset() {
  exams = [{ id: 'exam-1', programId: 'prog-1', title: 'الامتحان الشامل', status: 'READY', durationMin: 120, passScore: 60 }]
  candidates = []
  certificates = []
  rateAllowed = true
  seq = 0
}

function applyForm(over: Record<string, string> = {}, certBytes: Buffer = png, certName = 'cert.png') {
  const form = new FormData()
  form.append('programId', over.programId || 'prog-1')
  form.append('fullName', over.fullName || 'أحمد محمد')
  form.append('nationalId', over.nationalId || '123456789')
  form.append('email', over.email || 'a@b.com')
  form.append('phone', over.phone || '0599123456')
  form.append('certificateFile', new File([new Uint8Array(certBytes)], certName, { type: 'image/png' }))
  form.append('idDocumentFile', new File([new Uint8Array(png)], 'id.png', { type: 'image/png' }))
  return form
}

beforeEach(reset)

describe('public apply', () => {
  test('submits a candidate as CANDIDATE with stored files', async () => {
    const req = new NextRequest('http://localhost/api/comprehensive-exams/apply', { method: 'POST', body: applyForm() })
    const res = await applyRoute.POST(req)
    expect(res.status).toBe(201)
    const data = await res.json()
    expect(data.candidateId).toBeTruthy()
    expect(candidates[0].submittedBy).toBe('CANDIDATE')
    expect(candidates[0].status).toBe('PENDING_REVIEW')
    expect(candidates[0].externalCertificateFileKey).toContain('comprehensive-exam-candidates/')
  })
  test('no READY exam for the program is 404', async () => {
    exams[0].status = 'DRAFT'
    const req = new NextRequest('http://localhost/api/comprehensive-exams/apply', { method: 'POST', body: applyForm() })
    expect((await applyRoute.POST(req)).status).toBe(404)
  })
  test('duplicate national id is 409', async () => {
    candidates.push({ examId: 'exam-1', nationalId: '123456789', email: 'other@b.com', status: 'PENDING_REVIEW' })
    const req = new NextRequest('http://localhost/api/comprehensive-exams/apply', { method: 'POST', body: applyForm({ email: 'other@b.com' }) })
    const res = await applyRoute.POST(req)
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NATIONAL_ID_DUPLICATE')
  })
  test('already-graduate email is 409', async () => {
    certificates.push({ type: 'COMPREHENSIVE_EXAM', userEmail: 'a@b.com', enrollmentId: 'e1', programId: 'prog-1' })
    const req = new NextRequest('http://localhost/api/comprehensive-exams/apply', { method: 'POST', body: applyForm({ nationalId: '987654321' }) })
    expect((await applyRoute.POST(req)).status).toBe(409)
  })
  test('a rejected candidate may apply again', async () => {
    candidates.push({ examId: 'exam-1', nationalId: '123456789', email: 'a@b.com', status: 'REJECTED' })
    const req = new NextRequest('http://localhost/api/comprehensive-exams/apply', { method: 'POST', body: applyForm() })
    expect((await applyRoute.POST(req)).status).toBe(201)
  })
  test('a forged file (wrong magic bytes) is 400', async () => {
    const req = new NextRequest('http://localhost/api/comprehensive-exams/apply', {
      method: 'POST',
      body: applyForm({}, Buffer.from('MZ fake executable'), 'cert.png'),
    })
    expect((await applyRoute.POST(req)).status).toBe(400)
  })
  test('rate limit is 429', async () => {
    rateAllowed = false
    const req = new NextRequest('http://localhost/api/comprehensive-exams/apply', { method: 'POST', body: applyForm() })
    expect((await applyRoute.POST(req)).status).toBe(429)
  })
})
