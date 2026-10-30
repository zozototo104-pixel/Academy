/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

const calls: string[] = []
let appealUpdateCount = 1
let storedReadResult: { buffer: Buffer; mimeType: string } | null = null
let certificate: any
let thesisRows: any[] = []
let currentUser: any

function matchWhere(row: any, where: any) {
  if (!where) return true
  for (const [key, value] of Object.entries(where)) {
    if (value && typeof value === 'object' && 'not' in value) {
      if (row[key] === (value as any).not) return false
    } else if (row[key] !== value) return false
  }
  return true
}

const db: any = {
  programExamAttempt: {
    findUnique: async () => ({
      id: 'attempt-1',
      userId: 'student-1',
      score: 62,
      finalScore: null,
      appealStatus: 'PENDING',
      exam: { title: 'الاختبار النهائي', passScore: 70, programId: 'program-1' },
    }),
    updateMany: async ({ where, data }: any) => {
      calls.push(`appeal.updateMany:${where.appealStatus}:${data.finalScore}:${data.passed}`)
      return { count: appealUpdateCount }
    },
  },
  thesisSubmission: {
    findUnique: async ({ where }: any) => {
      calls.push(`thesis.findUnique:${where.id}`)
      return thesisRows.find((row) => row.id === where.id) || null
    },
    findFirst: async ({ where }: any) => {
      calls.push(`thesis.findFirst:${where?.admissionId || 'none'}`)
      return thesisRows.find((row) => matchWhere(row, where)) || null
    },
    updateMany: async ({ where, data }: any) => {
      calls.push(`thesis.updateMany:${where.id}:${where.admissionId}:${data.status}`)
      const row = thesisRows.find((item) => matchWhere(item, where))
      if (!row) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    },
    create: async ({ data }: any) => {
      const row = { id: `thesis-${thesisRows.length + 1}`, ...data }
      thesisRows.push(row)
      return row
    },
  },
  admissionApplication: {
    // نطاق المشرف (supervisor-scope): في عالم هذا الاختبار الطالب student-1
    // معيّن على supervisor-1 — اختبار التسجيل يختبر مسار التخزين الخارجي
    // لمشرف مخوّل، وحالة «مشرف غير معيّن» يغطيها اختبار الأمن المخصص.
    findFirst: async ({ where }: any) => {
      if (where?.userId === 'student-1' && where?.supervisorId === 'supervisor-1') return { id: 'adm-new' }
      return null
    },
    findMany: async () => ([
      { id: 'adm-new', userId: 'student-1', email: 'student@example.test', status: 'THESIS', programId: 'program-new', program: 'برنامج جديد', reference: 'NEW', approvedAt: new Date(), thesisDeadline: null, createdAt: new Date('2026-02-01'), programRef: { id: 'program-new', slug: 'new', category: 'DIPLOMA' } },
      { id: 'adm-old', userId: 'student-1', email: 'student@example.test', status: 'THESIS', programId: 'program-old', program: 'برنامج قديم', reference: 'OLD', approvedAt: new Date(), thesisDeadline: null, createdAt: new Date('2026-01-01'), programRef: { id: 'program-old', slug: 'old', category: 'DIPLOMA' } },
    ]),
    update: async ({ where, data }: any) => { calls.push(`admission.update:${where.id}:${data.status}`); return { id: where.id, ...data } },
  },
  enrollment: {
    findUnique: async ({ where }: any) => ({ id: `enroll-${where.userId_programId.programId}`, status: 'ACTIVE' }),
  },
  programStudyGuide: { findFirst: async () => null },
  certificate: {
    findUnique: async ({ where }: any) => certificate && certificate.id === where.id ? certificate : null,
    update: async ({ where, data }: any) => {
      calls.push(`certificate.update:${where.id}:${data.valid}:${data.revokedReason}`)
      certificate = { ...certificate, ...data }
      return certificate
    },
    findFirst: async ({ where }: any) => {
      if (!certificate) return null
      if (where?.serial && certificate.serial !== where.serial) return null
      if (where?.qrToken && certificate.qrToken !== where.qrToken) return null
      return certificate
    },
  },
}

mock.module('@/lib/db', () => ({ db }))

const realAuth = await import('../../src/lib/auth')
mock.module('@/lib/auth', () => ({
  ...realAuth,
  requireAdmin: async () => ({ id: 'admin-1', name: 'مدير', role: 'ADMIN' }),
  getCurrentUser: async () => currentUser,
}))

const realEnrollmentCompletion = await import('../../src/lib/enrollment-completion')
mock.module('@/lib/enrollment-completion', () => ({
  ...realEnrollmentCompletion,
  completeEnrollmentIfEligible: async (input: any) => { calls.push(`complete:${input.userId}:${input.programId}`); return { ok: true, completed: true, certificateIssued: true } },
}))

const realNotify = await import('../../src/lib/notify')
mock.module('@/lib/notify', () => ({
  ...realNotify,
  notify: async (...args: any[]) => { calls.push(`notify:${args[0]}:${args[2]}`) },
  audit: async (...args: any[]) => { calls.push(`audit:${args[1]}:${args[3]}`) },
}))

const realStorage = await import('../../src/lib/storage')
mock.module('@/lib/storage', () => ({
  ...realStorage,
  getStorageDownloadPathForKey: (key: string) => `/api/files/${key}`,
  readStoredFile: async (input: any) => { calls.push(`readStoredFile:${input.provider}:${input.key || input.url}`); return storedReadResult },
}))

const realExamGate = await import('../../src/lib/exam-gate')
mock.module('@/lib/exam-gate', () => ({ ...realExamGate, getExamsGate: async () => ({ hasAnyExam: false, complete: true, missing: [] }) }))

const realServiceFlows = await import('../../src/lib/service-flows')
mock.module('@/lib/service-flows', () => ({ ...realServiceFlows, getServiceFlow: () => ({ isStudyProgram: true }) }))

const realRateLimit = await import('../../src/lib/rate-limit')
mock.module('@/lib/rate-limit', () => ({ ...realRateLimit, enforceApiRateLimit: () => null, enforceDatabaseApiRateLimit: async () => null, checkDatabaseRateLimit: async () => ({ ok: true, remaining: 99, resetAt: Date.now() + 60000, retryAfterSec: 0 }) }))

const realCertificateCredential = await import('../../src/lib/w3c/certificate-credential')
mock.module('@/lib/w3c/certificate-credential', () => ({ ...realCertificateCredential, certificateCredentialUrl: () => 'https://credential.test', certificateVerificationUrl: () => 'https://verify.test' }))

const realCertificateEligibility = await import('../../src/lib/certificate-eligibility')
mock.module('@/lib/certificate-eligibility', () => ({ ...realCertificateEligibility, evaluateCertificateRecordEligibility: async () => ({ ok: true, gradeLabel: 'امتياز' }) }))

const appealsRoute = await import('../../src/app/api/admin/appeals/route')
const defenseRecordingRoute = await import('../../src/app/api/admin/defense-recording/route')
const adminCertificatesRoute = await import('../../src/app/api/admin/certificates/route')
const verifyCertificateRoute = await import('../../src/app/api/certificates/verify/route')
const thesisRoute = await import('../../src/app/api/thesis/route')

async function json(res: Response) {
  return res.json() as Promise<any>
}

beforeEach(() => {
  calls.splice(0, calls.length)
  appealUpdateCount = 1
  storedReadResult = { buffer: Buffer.from('webm-data'), mimeType: 'video/webm' }
  currentUser = { id: 'student-1', name: 'طالب', email: 'student@example.test', role: 'STUDENT' }
  certificate = { id: 'cert-1', serial: 'AACT-C-2026-00001', qrToken: 'qr-1', type: 'PROGRAM_COMPLETION', holderName: 'طالب', program: 'برنامج جديد', grade: 'امتياز', country: 'فلسطين', issuedAt: new Date('2026-01-10'), valid: true, userId: 'student-1', admissionId: 'adm-new', enrollmentId: 'enroll-program-new', revokedAt: null, revokedReason: null }
  thesisRows = [
    { id: 'thesis-old', userId: 'student-1', admissionId: 'adm-old', title: 'رسالة قديمة', abstract: 'ملخص قديم طويل جداً للاختبار', status: 'PLAN_NEEDS_REVISION' },
    { id: 'thesis-new', userId: 'student-1', admissionId: 'adm-new', title: 'رسالة جديدة', abstract: 'ملخص جديد طويل جداً للاختبار', status: 'PLAN_NEEDS_REVISION' },
    { id: 'thesis-rec', userId: 'student-1', admissionId: 'adm-new', title: 'تسجيل', status: 'RESULT_APPROVED', recordingStorageProvider: 's3', recordingStorageKey: 'defense/rec.webm', recordingUrl: null, recordingMime: 'video/webm' },
  ]
})

describe('academic B2 safety', () => {
  test('admin appeal decision atomically writes finalScore and triggers certificate completion', async () => {
    const res = await appealsRoute.PATCH(new NextRequest('https://academy.test/api/admin/appeals', { method: 'PATCH', body: JSON.stringify({ attemptId: 'attempt-1', finalScore: 88, response: 'مراجعة مقبولة' }) }))
    expect(res.status).toBe(200)
    expect(calls).toContain('appeal.updateMany:PENDING:88:true')
    expect(calls).toContain('complete:student-1:program-1')

    appealUpdateCount = 0
    const conflict = await appealsRoute.PATCH(new NextRequest('https://academy.test/api/admin/appeals', { method: 'PATCH', body: JSON.stringify({ attemptId: 'attempt-1', finalScore: 90, response: 'قرار ثان' }) }))
    const payload = await json(conflict as any)
    expect(conflict.status).toBe(409)
    expect(payload.error).toContain('حُسم')
  })

  test('supervisor defense recording route reads external stored file through readStoredFile', async () => {
    currentUser = { id: 'supervisor-1', name: 'مشرف', email: 'supervisor@example.test', role: 'SUPERVISOR' }
    const res = await defenseRecordingRoute.GET(new NextRequest('https://academy.test/api/admin/defense-recording?thesisId=thesis-rec'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/webm')
    expect(calls).toContain('readStoredFile:s3:defense/rec.webm')
  })

  test('admin revokes certificate with mandatory reason and verification shows revoked date', async () => {
    const missingReason = await adminCertificatesRoute.PATCH(new NextRequest('https://academy.test/api/admin/certificates', { method: 'PATCH', body: JSON.stringify({ id: 'cert-1', reason: '' }) }))
    expect(missingReason.status).toBe(400)

    const revoked = await adminCertificatesRoute.PATCH(new NextRequest('https://academy.test/api/admin/certificates', { method: 'PATCH', body: JSON.stringify({ id: 'cert-1', reason: 'صدرت بناءً على بيانات غير مكتملة' }) }))
    expect(revoked.status).toBe(200)
    expect(certificate.valid).toBe(false)
    expect(certificate.revokedAt).toBeInstanceOf(Date)
    expect(calls.some((call) => call.startsWith('audit:REVOKE_CERTIFICATE:cert-1'))).toBe(true)

    const verified = await verifyCertificateRoute.GET(new NextRequest('https://academy.test/api/certificates/verify?serial=AACT-C-2026-00001'))
    const payload = await json(verified as any)
    expect(payload.valid).toBe(false)
    expect(payload.message).toContain('ملغاة')
    expect(payload.certificate.statusLabel).toContain('ملغاة')
    expect(payload.certificate.revokedAt).toBeTruthy()
  })

  test('legacy thesis without admissionId is adopted for the current admission instead of duplicated', async () => {
    thesisRows = [
      { id: 'thesis-legacy', userId: 'student-1', admissionId: null, title: 'رسالة قديمة بلا طلب', abstract: 'ملخص رسالة قديمة طويل جداً للاختبار', status: 'PLAN_NEEDS_REVISION' },
    ]
    const loaded = await thesisRoute.GET()
    const loadedPayload = await json(loaded as any)
    expect(loaded.status).toBe(200)
    expect(loadedPayload.thesis.id).toBe('thesis-legacy')
    expect(loadedPayload.thesis.admissionId).toBe('adm-new')
    expect(thesisRows).toHaveLength(1)
    expect(thesisRows[0].admissionId).toBe('adm-new')

    const submitted = await thesisRoute.POST(new NextRequest('https://academy.test/api/thesis', {
      method: 'POST',
      body: JSON.stringify({ stage: 'PLAN', title: 'عنوان محدث للرسالة القديمة', abstract: 'هذا ملخص طويل بما يكفي ويجب أن يحدث الرسالة القديمة بدل إنشاء نسخة ثانية.' }),
      headers: { 'content-type': 'application/json' },
    }))
    const submittedPayload = await json(submitted as any)
    expect(submitted.status).toBe(200)
    expect(submittedPayload.thesis.id).toBe('thesis-legacy')
    expect(thesisRows).toHaveLength(1)
  })

  test('thesis updates are scoped to the current admissionId so another program thesis is untouched', async () => {
    const res = await thesisRoute.POST(new NextRequest('https://academy.test/api/thesis', {
      method: 'POST',
      body: JSON.stringify({ stage: 'PLAN', title: 'عنوان خطة حديث', abstract: 'هذا ملخص طويل بما يكفي لاجتياز شرط الخمسين حرفاً ويخص القبول الجديد فقط.' }),
      headers: { 'content-type': 'application/json' },
    }))
    const payload = await json(res as any)
    expect(res.status).toBe(200)
    expect(payload.thesis.id).toBe('thesis-new')
    expect(calls).toContain('thesis.updateMany:thesis-new:adm-new:PLAN_SUBMITTED')
    expect(thesisRows.find((row) => row.id === 'thesis-old')?.title).toBe('رسالة قديمة')
    expect(thesisRows.find((row) => row.id === 'thesis-new')?.title).toBe('عنوان خطة حديث')
  })
})
