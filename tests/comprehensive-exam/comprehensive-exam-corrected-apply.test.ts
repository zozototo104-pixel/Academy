// Comprehensive exam — CORRECTED apply flow (Haris 2026-11-26 10:11):
// no application without login; the equivalency service application
// carries a specialization; approval creates the candidate; the invite
// needs a READY exam + a paid SERVICE_FEE. Real lib + real routes;
// only the DB/auth/mail/storage/rate-limit are faked.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

let exams: any[] = []
let candidates: any[] = []
let certificates: any[] = []
let payments: any[] = []
let applications: any[] = []
let documents: any[] = []
let auditRows: any[] = []
let users: any[] = []
let seq = 0

const programs = [
  { id: 'prog-1', titleAr: 'برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية', titleEn: 'Professional Certificates and Professional Experience Equivalency Program', slug: 'training-certificates-equivalency', category: 'SERVICE', price: 50, active: true, registrationStatus: 'OPEN', admissionRules: null },
  { id: 'spec-1', titleAr: 'دكتوراه في إدارة الأعمال', titleEn: 'PhD in Business Administration', category: 'DOCTORATE', active: true, registrationStatus: 'CLOSED', admissionRules: null },
  { id: 'service-2', titleAr: 'خدمة مهنية أخرى', titleEn: 'Another Service', slug: 'other-service', category: 'SERVICE', price: 30, active: true, registrationStatus: 'OPEN', admissionRules: null },
  { id: 'service-3', titleAr: 'نظام الاعتماد الدولي والعضوية الأمريكية', titleEn: 'International Accreditation and American Membership', slug: 'accreditation-membership-license', category: 'SERVICE', price: 30, active: true, registrationStatus: 'OPEN', admissionRules: null },
]

const fakeDb: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(fakeDb),
  $queryRaw: async () => [{ value: 1 }],
  program: {
    findUnique: async ({ where }: any) => programs.find((p) => p.id === where?.id) || null,
    findFirst: async ({ where }: any = {}) =>
      programs.find(
        (p) =>
          (where?.id === undefined || p.id === where.id) &&
          (where?.active === undefined || p.active === where.active) &&
          (!where?.titleAr || p.titleAr === where.titleAr) &&
          (!where?.titleAr?.contains || p.titleAr.includes(where.titleAr.contains)),
      ) || null,
  },
  comprehensiveExam: {
    findFirst: async ({ where }: any = {}) =>
      exams.find(
        (e) =>
          (!where?.programId || e.programId === where.programId) &&
          (!where?.specializationProgramId || e.specializationProgramId === where.specializationProgramId) &&
          (!where?.status || e.status === where.status),
      ) || null,
  },
  comprehensiveExamCandidate: {
    findFirst: async ({ where }: any = {}) =>
      candidates.find(
        (c) =>
          (!where?.admissionApplicationId || c.admissionApplicationId === where.admissionApplicationId) &&
          (!where?.examId || c.examId === where.examId) &&
          (!where?.nationalId || c.nationalId === where.nationalId) &&
          (!where?.status?.not || c.status !== where.status.not),
      ) || null,
    create: async ({ data }: any) => {
      const row = { id: `cand-${++seq}`, status: 'PENDING_REVIEW', createdAt: new Date(), updatedAt: new Date(), ...data }
      candidates.push(row)
      return row
    },
  },
  certificate: {
    findFirst: async ({ where }: any = {}) => {
      const rows = certificates.filter((c) => {
        if (where?.user?.email && c.userEmail !== where.user.email) return false
        if (where?.type && c.type !== where.type) return false
        if (where?.comprehensiveExam) {
          if (where.comprehensiveExam.programId !== undefined && c.examProgramId !== where.comprehensiveExam.programId) return false
          if (where.comprehensiveExam.specializationProgramId !== undefined && c.specializationProgramId !== where.comprehensiveExam.specializationProgramId) return false
        }
        if (Array.isArray(where?.OR)) {
          const ok = where.OR.some((cond: any) => (cond.legacy === true && c.legacy === true) || (cond.type && c.type === cond.type))
          if (!ok) return false
        }
        return true
      })
      return rows[0] || null
    },
  },
  payment: {
    findFirst: async ({ where }: any = {}) =>
      payments.find(
        (p) =>
          (!where?.admissionId || p.admissionId === where.admissionId) &&
          (!where?.purpose || p.purpose === where.purpose) &&
          (!where?.status?.in || where.status.in.includes(p.status)),
      ) || null,
    create: async ({ data }: any) => {
      const row = { id: `pay-${++seq}`, status: 'PENDING', createdAt: new Date(), ...data }
      payments.push(row)
      return row
    },
  },
  admissionApplication: {
    findUnique: async ({ where }: any) => applications.find((a) => a.id === where?.id) || null,
    update: async ({ where, data }: any) => {
      const row = applications.find((a) => a.id === where?.id)
      if (!row) throw new Error('NOT_FOUND')
      Object.assign(row, data, { updatedAt: new Date() })
      return row
    },
  },
  admissionDocument: {
    findMany: async ({ where }: any = {}) => documents.filter((d) => !where?.admissionId || d.admissionId === where.admissionId),
  },
  user: {
    findUnique: async ({ where }: any = {}) =>
      users.find((u) => (where?.id ? u.id === where.id : u.email === where?.email)) || null,
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
mock.module('@/lib/auth', () => ({
  getCurrentUser: async () => ({ id: 'admin-1', name: 'مدير الاختبار', role: 'ADMIN', email: 'admin@b.com' }),
  requireAdmin: async () => ({ id: 'admin-1', name: 'مدير الاختبار', role: 'ADMIN' }),
}))
mock.module('@/lib/notify', () => ({ audit: async () => null, notify: async () => null, notifyAdmins: async () => null, AUDIT_ACTIONS: {} }))
mock.module('@/lib/settings', () => ({
  getSettings: async () => ({ FEE_SERVICE_DEFAULT: '50', THESIS_MAX_MONTHS: '6' }),
  getSetting: async () => '',
  getSettingNum: async () => 30,
  getSettingJson: async (_key: string, fallback: unknown) => fallback,
  nextInvoiceNo: async () => `INV-2026-${String(seq + 1).padStart(4, '0')}`,
  nextCertSerial: async () => 'AACT-C-2026-00001',
  nextReceiptNo: async () => 'R-1',
  getOfficialContact: async () => ({}),
  createPaymentWithInvoiceNo: async () => null,
  DEFAULT_SETTINGS: {},
}))
mock.module('@/lib/mailer', () => ({
  emailTemplate: () => '',
  sendEmail: async () => null,
  sendEmailDetailed: async () => 'SENT',
  emailAdmissionDecision: async () => null,
  emailAdmissionDocumentsRequested: async () => null,
  emailCertificateIssued: async () => null,
  emailAdminNewAdmissionRequest: async () => null,
  emailAdmissionSubmitted: async () => null,
  emailServiceRequestSubmitted: async () => null,
  emailAssignmentGraded: async () => null,
  emailPaymentReceipt: async () => null,
  emailFinalRegistration: async () => null,
  emailEmailChangeConfirm: async () => null,
  emailLegacyGraduateWelcome: async () => null,
  emailPaymentWaiverCode: async () => null,
  isEmailDeliveryConfigured: () => false,
}))
mock.module('@/lib/storage', () => ({
  storeFileBuffer: async (input: any) => ({ key: `admissions/test-${input.fileName}`, mimeType: input.mimeType, size: input.buffer.length, provider: 'local', url: null }),
  storeFileBufferAtKey: async (input: any) => ({ key: input.key, mimeType: input.mimeType, size: input.buffer.length, provider: 'local', url: null }),
  getStorageDownloadPathForKey: (key: string) => `/api/files/${key}`,
  storageErrorMessage: () => 'تعذر حفظ الملف',
  deleteStoredFile: async () => null,
  readStoredFile: async () => null,
  getFileBufferFromStorageOrBase64: async () => null,
  getPublicStorageUrlForKey: () => null,
  createSignedStorageUrlForKey: async () => null,
  configuredAllowedStorageHosts: [],
}))
mock.module('@/lib/rate-limit', () => ({ enforceApiRateLimit: () => null, clientIpFromHeaders: () => '127.0.0.1' }))
mock.module('@/lib/admission-ai', () => ({ resolveRules: () => ({ minAge: null }) }))
mock.module('@/lib/certificate-eligibility', () => ({ evaluateProgramCertificateEligibility: async () => null }))
mock.module('@/lib/enrollment-completion', () => ({ completeEnrollmentIfEligible: async () => null }))
mock.module('@/lib/student-record-ownership', () => ({
  repairVerifiedStudentRecordOwnership: async () => null,
  studentAdmissionOwnershipWhere: () => ({}),
  studentOwnsAdmission: () => true,
}))

const lib = await import('../../src/lib/comprehensive-exam-phase2')
const adminAdmissionsRoute = await import('../../src/app/api/admin/admissions/route')
const admissionsRoute = await import('../../src/app/api/admissions/route')

const ADMIN = { id: 'admin-1', name: 'مدير الاختبار' }

function reset() {
  exams = [{ id: 'exam-1', programId: 'prog-1', specializationProgramId: 'spec-1', title: 'الامتحان الشامل — دكتوراه في إدارة الأعمال', status: 'READY', durationMin: 120, passScore: 60 }]
  candidates = []
  certificates = []
  payments = []
  auditRows = []
  users = [{ id: 'user-1', email: 'a@b.com', name: 'أحمد محمد', role: 'STUDENT' }]
  applications = [
    {
      id: 'adm-1', reference: 'AACT-APP-1', fullName: 'أحمد محمد', nationalId: '123456789', email: 'a@b.com', phone: '0599123456',
      country: 'فلسطين', userId: 'user-1', programId: 'prog-1', program: 'برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية',
      specializationProgramId: 'spec-1', status: 'UNDER_REVIEW', approvedAt: null, notes: null,
    },
  ]
  documents = [
    { id: 'doc-1', admissionId: 'adm-1', docType: 'FLOW_DOC_1', fileName: 'cert.png', mimeType: 'image/png', size: 10, storageKey: 'admissions/cert.png' },
    { id: 'doc-2', admissionId: 'adm-1', docType: 'FLOW_DOC_4', fileName: 'id.png', mimeType: 'image/png', size: 10, storageKey: 'admissions/id.png' },
  ]
  seq = 0
}

beforeEach(reset)

const applicationInput = (over: any = {}) => ({
  application: {
    id: 'adm-1', fullName: 'أحمد محمد', nationalId: '123456789', email: 'a@b.com', phone: '0599123456',
    userId: 'user-1', programId: 'prog-1', specializationProgramId: 'spec-1',
  },
  files: [
    { docType: 'FLOW_DOC_1', fileName: 'cert.png', mimeType: 'image/png', size: 10, storageKey: 'admissions/cert.png' },
    { docType: 'FLOW_DOC_4', fileName: 'id.png', mimeType: 'image/png', size: 10, storageKey: 'admissions/id.png' },
  ],
  admin: ADMIN,
  ...over,
})

describe('invite gates', () => {
  test('a DRAFT exam blocks with EXAM_NOT_READY', async () => {
    const gate = await lib.checkComprehensiveInviteGates(fakeDb, { candidate: { admissionApplicationId: null }, exam: { status: 'DRAFT' } })
    expect(gate?.code).toBe('EXAM_NOT_READY')
  })
  test('an application candidate without a paid fee is PAYMENT_REQUIRED', async () => {
    const gate = await lib.checkComprehensiveInviteGates(fakeDb, { candidate: { admissionApplicationId: 'adm-1' }, exam: { status: 'READY' } })
    expect(gate?.code).toBe('PAYMENT_REQUIRED')
  })
  test('a PENDING fee does not pass; PAID and WAIVED do', async () => {
    payments.push({ id: 'pay-1', admissionId: 'adm-1', purpose: 'SERVICE_FEE', status: 'PENDING' })
    expect(await lib.checkComprehensiveInviteGates(fakeDb, { candidate: { admissionApplicationId: 'adm-1' }, exam: { status: 'READY' } })).not.toBeNull()
    payments[0].status = 'PAID'
    expect(await lib.checkComprehensiveInviteGates(fakeDb, { candidate: { admissionApplicationId: 'adm-1' }, exam: { status: 'READY' } })).toBeNull()
    payments[0].status = 'WAIVED'
    expect(await lib.checkComprehensiveInviteGates(fakeDb, { candidate: { admissionApplicationId: 'adm-1' }, exam: { status: 'READY' } })).toBeNull()
  })
  test('a manual candidate (no admission) has no payment gate', async () => {
    const gate = await lib.checkComprehensiveInviteGates(fakeDb, { candidate: { admissionApplicationId: null }, exam: { status: 'READY' } })
    expect(gate).toBeNull()
  })
  test('a fee on another admission does not count', async () => {
    payments.push({ id: 'pay-1', admissionId: 'adm-other', purpose: 'SERVICE_FEE', status: 'PAID' })
    const gate = await lib.checkComprehensiveInviteGates(fakeDb, { candidate: { admissionApplicationId: 'adm-1' }, exam: { status: 'READY' } })
    expect(gate?.code).toBe('PAYMENT_REQUIRED')
  })
})

describe('candidate from application', () => {
  test('creates an APPROVED candidate linked to the user and the application', async () => {
    const result = await lib.createComprehensiveCandidateFromApplication(fakeDb, applicationInput())
    expect(result.created).toBe(true)
    expect(result.examId).toBe('exam-1')
    expect(candidates.length).toBe(1)
    const c = candidates[0]
    expect(c.status).toBe('APPROVED')
    expect(c.submittedBy).toBe('CANDIDATE')
    expect(c.userId).toBe('user-1')
    expect(c.admissionApplicationId).toBe('adm-1')
    expect(c.externalCertificateFileKey).toBe('admissions/cert.png')
    expect(c.idDocumentFileKey).toBe('admissions/id.png')
    expect(c.nationalId).toBe('123456789')
    expect(auditRows[0].action).toBe('CREATE_COMPREHENSIVE_EXAM_CANDIDATE_FROM_APPLICATION')
  })
  test('a second approval of the same application creates nothing (idempotent)', async () => {
    const first = await lib.createComprehensiveCandidateFromApplication(fakeDb, applicationInput())
    const second = await lib.createComprehensiveCandidateFromApplication(fakeDb, applicationInput())
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.candidateId).toBe(first.candidateId)
    expect(candidates.length).toBe(1)
  })
  test('no live exam for the specialization is 409 EXAM_NOT_PREPARED', async () => {
    exams = []
    await expect(lib.createComprehensiveCandidateFromApplication(fakeDb, applicationInput())).rejects.toMatchObject({ code: 'EXAM_NOT_PREPARED', status: 409 })
    expect(candidates.length).toBe(0)
  })
  test('a DRAFT exam is used when no READY exam exists', async () => {
    exams[0].status = 'DRAFT'
    const result = await lib.createComprehensiveCandidateFromApplication(fakeDb, applicationInput())
    expect(result.created).toBe(true)
    expect(result.examId).toBe('exam-1')
  })
  test('an application without a specialization is skipped, not blocked', async () => {
    const result = await lib.createComprehensiveCandidateFromApplication(
      fakeDb,
      applicationInput({ application: { ...applicationInput().application, specializationProgramId: null } }),
    )
    expect(result).toEqual({ created: false, candidateId: null, examId: null })
    expect(candidates.length).toBe(0)
  })
  test('no files on the application is 409 APPLICATION_FILES_REQUIRED', async () => {
    await expect(lib.createComprehensiveCandidateFromApplication(fakeDb, applicationInput({ files: [] }))).rejects.toMatchObject({ code: 'APPLICATION_FILES_REQUIRED', status: 409 })
  })
  test('files map by doc type, falling back to first/last file', async () => {
    const result = await lib.createComprehensiveCandidateFromApplication(
      fakeDb,
      applicationInput({
        files: [
          { docType: 'FLOW_DOC_2', fileName: 'cv.pdf', mimeType: 'application/pdf', size: 10, storageKey: 'admissions/cv.pdf' },
          { docType: 'FLOW_DOC_3', fileName: 'exp.pdf', mimeType: 'application/pdf', size: 10, storageKey: 'admissions/exp.pdf' },
        ],
      }),
    )
    expect(result.created).toBe(true)
    expect(candidates[0].externalCertificateFileKey).toBe('admissions/cv.pdf')
    expect(candidates[0].idDocumentFileKey).toBe('admissions/exp.pdf')
  })
  test('a duplicate national id on the live exam blocks creation', async () => {
    candidates.push({ id: 'cand-old', examId: 'exam-1', nationalId: '123456789', email: 'other@b.com', status: 'APPROVED' })
    await expect(lib.createComprehensiveCandidateFromApplication(fakeDb, applicationInput())).rejects.toMatchObject({ code: 'NATIONAL_ID_DUPLICATE', status: 409 })
  })
})

describe('approval creates the candidate (admin PATCH)', () => {
  function patchReq(body: any) {
    return new NextRequest('http://localhost/api/admin/admissions', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  test('approving an equivalency application creates the candidate + the SERVICE_FEE invoice', async () => {
    const res = await adminAdmissionsRoute.PATCH(patchReq({ id: 'adm-1', status: 'RESULT_APPROVED' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.comprehensiveExamCandidateId).toBeTruthy()
    expect(candidates.length).toBe(1)
    expect(candidates[0].status).toBe('APPROVED')
    expect(candidates[0].userId).toBe('user-1')
    expect(candidates[0].admissionApplicationId).toBe('adm-1')
    expect(payments.length).toBe(1)
    expect(payments[0].purpose).toBe('SERVICE_FEE')
    expect(applications[0].status).toBe('RESULT_APPROVED')
  })
  test('re-approving creates neither a second candidate nor a second invoice', async () => {
    const first = await (await adminAdmissionsRoute.PATCH(patchReq({ id: 'adm-1', status: 'RESULT_APPROVED' }))).json()
    const second = await adminAdmissionsRoute.PATCH(patchReq({ id: 'adm-1', status: 'RESULT_APPROVED' }))
    expect(second.status).toBe(200)
    const data = await second.json()
    expect(data.comprehensiveExamCandidateId).toBe(first.comprehensiveExamCandidateId)
    expect(candidates.length).toBe(1)
    expect(payments.length).toBe(1)
  })
  test('approval with no live exam is 409 EXAM_NOT_PREPARED and creates no invoice', async () => {
    exams = []
    const res = await adminAdmissionsRoute.PATCH(patchReq({ id: 'adm-1', status: 'RESULT_APPROVED' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('EXAM_NOT_PREPARED')
    expect(candidates.length).toBe(0)
    expect(payments.length).toBe(0)
  })
  test('approval with no files on the application is 409 APPLICATION_FILES_REQUIRED', async () => {
    documents = []
    const res = await adminAdmissionsRoute.PATCH(patchReq({ id: 'adm-1', status: 'RESULT_APPROVED' }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('APPLICATION_FILES_REQUIRED')
    expect(payments.length).toBe(0)
  })
  test('approving a non-equivalency service creates the invoice but no candidate', async () => {
    applications[0].programId = 'service-2'
    applications[0].program = 'خدمة مهنية أخرى'
    const res = await adminAdmissionsRoute.PATCH(patchReq({ id: 'adm-1', status: 'RESULT_APPROVED' }))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.comprehensiveExamCandidateId).toBe(null)
    expect(candidates.length).toBe(0)
    expect(payments.length).toBe(1)
    expect(payments[0].purpose).toBe('SERVICE_FEE')
  })
})

describe('POST /api/admissions — equivalency specialization + national id', () => {
  function applyForm(over: Record<string, string> = {}) {
    const form = new FormData()
    form.append('fullName', over.fullName || 'أحمد محمد علي')
    form.append('email', over.email || 'a@b.com')
    form.append('phone', over.phone || '0599123456')
    form.append('country', over.country || 'فلسطين')
    form.append('program', over.program || 'برنامج الشهادات المهنية ونظام معادلة الخبرات المهنية')
    form.append('programId', over.programId || 'prog-1')
    form.append('education', over.education || 'BACHELOR')
    form.append('acknowledged', over.acknowledged || 'true')
    if (over.specializationProgramId) form.append('specializationProgramId', over.specializationProgramId)
    if (over.nationalId) form.append('nationalId', over.nationalId)
    return form
  }

  function postForm(form: FormData) {
    return new NextRequest('http://localhost/api/admissions', { method: 'POST', body: form })
  }

  test('equivalency without a specialization is 400', async () => {
    const res = await admissionsRoute.POST(postForm(applyForm({ nationalId: '123456789' })))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toMatchObject({ error: expect.stringContaining('التخصص المطلوب للمعادلة مطلوب') })
  })
  test('equivalency with a SERVICE-category specialization is 400', async () => {
    const res = await admissionsRoute.POST(postForm(applyForm({ specializationProgramId: 'service-2', nationalId: '123456789' })))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('التخصص المحدد غير موجود أو غير متاح') })
  })
  test('equivalency with a valid specialization but no national id is 400', async () => {
    const res = await admissionsRoute.POST(postForm(applyForm({ specializationProgramId: 'spec-1' })))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('الهوية') })
  })
  test('equivalency with specialization + national id passes the new checks (reaches the documents step)', async () => {
    const res = await admissionsRoute.POST(postForm(applyForm({ specializationProgramId: 'spec-1', nationalId: '123456789' })))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.missing).toBeDefined()
    expect(body.error).not.toContain('التخصص')
    expect(body.error).not.toContain('الهوية')
  })
  test('a non-equivalency service does not require a national id', async () => {
    const form = applyForm({ program: 'نظام الاعتماد الدولي والعضوية الأمريكية', programId: 'service-3' })
    const res = await admissionsRoute.POST(postForm(form))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.missing).toBeDefined()
    expect(body.error).not.toContain('الهوية')
  })
  test('the specialization program registration need not be OPEN', async () => {
    // spec-1 is CLOSED in the fixture — the application still passes
    // the specialization checks and reaches the documents step.
    const res = await admissionsRoute.POST(postForm(applyForm({ specializationProgramId: 'spec-1', nationalId: '123456789' })))
    expect(res.status).toBe(400)
    expect((await res.json()).missing).toBeDefined()
  })
})
