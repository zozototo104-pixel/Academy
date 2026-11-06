/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// ---------- in-memory state ----------
type Row = Record<string, any>
let apps: Row[] = []
let users: Row[] = []
let programs: Row[] = []
let payments: Row[] = []
let appUpdates: Row[] = []
let decisionEmails = 0
let submittedEmails = 0
let serviceSubmittedEmails = 0
let notifyCalls = 0
let demoEnsureCalls = 0
let docReqIsService = false

const ADMIN = { id: 'admin-1', role: 'ADMIN', name: 'Admin', email: 'admin@example.test' }

function findApp(where: Row) {
  return apps.find((a) => (where.id ? a.id === where.id : a.reference === where.reference)) || null
}
function paymentsOf(admissionId: string) {
  return payments.filter((p) => p.admissionId === admissionId)
}

const dbMock: Row = {
  admissionApplication: {
    findUnique: async ({ where }: any) => findApp(where),
    findFirst: async ({ where }: any) => findApp(where),
    update: async ({ where, data }: any) => {
      const app = findApp(where)
      if (!app) throw new Error('not found')
      appUpdates.push({ id: app.id, data })
      Object.assign(app, data)
      return app
    },
  },
  user: {
    findUnique: async ({ where }: any) => users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) || null,
  },
  program: {
    findUnique: async ({ where }: any) => programs.find((p) => p.id === where.id) || null,
    findFirst: async () => programs[0] || null,
  },
  payment: {
    findFirst: async ({ where }: any) => paymentsOf(where.admissionId).find((p) => !where.purpose || p.purpose === where.purpose) || null,
    findMany: async ({ where }: any) => paymentsOf(where.admissionId),
  },
  $transaction: async (fn: any) => fn({
    $queryRaw: async () => [],
    payment: {
      findFirst: async ({ where }: any) => paymentsOf(where.admissionId).find((p) => p.purpose === where.purpose) || null,
      create: async ({ data }: any) => { payments.push(data); return data },
    },
  }),
}
mock.module('@/lib/db', () => ({ db: dbMock }))
mock.module('@/lib/auth', () => ({
  getCurrentUser: async () => ADMIN,
  requireAdmin: async () => ADMIN,
}))
mock.module('@/lib/notify', () => ({
  audit: async () => {},
  notify: async () => { notifyCalls++ },
  AUDIT_ACTIONS: {},
}))
mock.module('@/lib/settings', () => ({
  getSettings: async () => ({}),
  getSettingNum: async () => 30,
  nextInvoiceNo: async () => 'AACT-INV-2026-9999',
}))
mock.module('@/lib/mailer', () => ({
  emailAdmissionDecision: async () => { decisionEmails++ },
  emailAdmissionDocumentsRequested: async () => {},
  emailCertificateIssued: async () => {},
  emailAdmissionSubmitted: async () => { submittedEmails++ },
  emailServiceRequestSubmitted: async () => { serviceSubmittedEmails++ },
}))
mock.module('@/lib/service-flows', () => ({ getServiceFlow: () => null }))
mock.module('@/lib/service-workflows', () => ({ deriveServiceWorkflowState: () => null }))
mock.module('@/lib/admin-query', () => ({
  adminPaginationMeta: () => ({}),
  cleanAdminQuery: (v: any) => v || '',
  parseAdminPagination: () => ({ page: 1, pageSize: 10, skip: 0, take: 10 }),
}))
mock.module('@/lib/certificate-eligibility', () => ({ evaluateProgramCertificateEligibility: async () => ({ ok: true }) }))
mock.module('@/lib/enrollment-completion', () => ({ completeEnrollmentIfEligible: async () => ({ ok: false, error: 'n/a' }) }))
mock.module('@/lib/payment-waivers', () => ({ applyScholarshipToNewInvoiceData: async (_tx: any, data: any) => data }))
mock.module('@/lib/admission-document-replacement', () => ({
  appendAdmissionDocumentReplacement: (notes: any) => notes,
  extractAdmissionDocumentReplacement: () => null,
  stripAdmissionDocumentReplacement: (notes: any) => notes,
}))
mock.module('@/lib/storage', () => ({ getStorageDownloadPathForKey: () => '' }))
mock.module('@/lib/admission-document-requirements', () => ({
  resolveProgramAdmissionDocumentRequirements: () => ({
    isServiceRequest: docReqIsService,
    requiredDocs: [{ type: 'ID_CARD', label: 'بطاقة الهوية' }],
    allKnownDocs: [],
    missingDocs: [],
  }),
  resolvePostReplacementAdmissionStatus: () => 'UNDER_REVIEW',
}))
mock.module('@/lib/admission-upload-token', () => ({ verifyAdmissionUploadToken: () => true }))
mock.module('@/lib/demo-accounts', () => ({
  DEMO_ACCOUNTS: {},
  ensurePlatformDemoAccounts: async () => { demoEnsureCalls++; return { created: 0 } },
}))

const { PATCH: adminPatch } = await import('../../src/app/api/admin/admissions/route')
const { POST: finalizePost } = await import('../../src/app/api/admissions/finalize/route')
const { POST: demoAccountsPost } = await import('../../src/app/api/admin/demo-accounts/route')

// ---------- fixtures ----------
function studyApp(status: string, extra: Row = {}): Row {
  return {
    id: 'app-1', userId: 'student-1', programId: 'prog-1', program: 'ماجستير مهني — إدارة',
    status, email: 'student@example.test', fullName: 'طالب اختبار', reference: 'AACT-2026-1001',
    notes: null, scholarshipFull: false, approvedAt: null, education: 'BACHELOR', country: 'PS',
    ...extra,
  }
}
function tuitionInvoice(status: string, amount = 700): Row {
  return {
    id: `pay-${status}`, admissionId: 'app-1', purpose: 'TUITION', status, amount,
    amountCents: amount * 100, waiverType: null, waiverStatus: null, waivedAmount: null,
    waivedAmountCents: null, originalAmount: null, originalAmountCents: null,
    invoiceNo: 'AACT-INV-2026-0007', description: 'الرسوم الدراسية',
  }
}
function feeInvoice(status: string): Row {
  return {
    id: `fee-${status}`, admissionId: 'app-1', purpose: 'APPLICATION_FEE', status, amount: 30,
    invoiceNo: 'AACT-INV-2026-0003', description: 'رسوم التقديم',
  }
}

async function patch(body: Row) {
  const res = await adminPatch(new NextRequest('https://academy.example.test/api/admin/admissions', {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json() }
}
async function finalize(body: Row) {
  const res = await finalizePost(new NextRequest('https://academy.example.test/api/admissions/finalize', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json() }
}

beforeEach(() => {
  apps = []
  users = [
    { id: 'student-1', role: 'STUDENT', name: 'طالب اختبار', email: 'student@example.test' },
    { id: 'sup-1', role: 'SUPERVISOR', name: 'مشرف اختبار', email: 'sup@example.test' },
    { id: 'admin-2', role: 'ADMIN', name: 'أدمن ثانٍ', email: 'admin2@example.test' },
    { id: 'visitor-1', role: 'VISITOR', name: 'زائر', email: 'visitor@example.test' },
  ]
  programs = [{ id: 'prog-1', slug: 'masters-mgmt', category: 'MASTERS', price: 700, admissionRules: null, titleAr: 'ماجستير مهني' }]
  payments = []
  appUpdates = []
  decisionEmails = 0
  submittedEmails = 0
  serviceSubmittedEmails = 0
  notifyCalls = 0
  demoEnsureCalls = 0
  docReqIsService = false
  delete process.env.VERCEL_ENV
  delete process.env.ENABLE_DEMO_ACCOUNTS
})

describe('admin admissions PATCH — fallback transition guard', () => {
  test('killer chain: UNDER_REVIEW study application cannot jump to THESIS before tuition settlement', async () => {
    apps = [studyApp('UNDER_REVIEW')]
    const res = await patch({ id: 'app-1', status: 'THESIS' })
    expect(res.status).toBe(409)
    expect(res.json.code).toBe('ADMISSION_TRANSITION_NOT_ALLOWED')
    expect(apps[0].status).toBe('UNDER_REVIEW')
    expect(appUpdates.length).toBe(0)
  })

  test('AWAITING_FEE study application cannot jump to SCHEDULED', async () => {
    apps = [studyApp('AWAITING_FEE')]
    const res = await patch({ id: 'app-1', status: 'SCHEDULED' })
    expect(res.status).toBe(409)
    expect(apps[0].status).toBe('AWAITING_FEE')
  })

  test('AWAITING_TUITION with UNPAID tuition invoice cannot jump to THESIS', async () => {
    apps = [studyApp('AWAITING_TUITION')]
    payments = [tuitionInvoice('UNPAID')]
    const res = await patch({ id: 'app-1', status: 'THESIS' })
    expect(res.status).toBe(409)
    expect(apps[0].status).toBe('AWAITING_TUITION')
  })

  test('AWAITING_TUITION with fully PAID tuition may advance to THESIS', async () => {
    apps = [studyApp('AWAITING_TUITION')]
    payments = [tuitionInvoice('PAID')]
    const res = await patch({ id: 'app-1', status: 'THESIS' })
    expect(res.status).toBe(200)
    expect(apps[0].status).toBe('THESIS')
  })

  test('full-scholarship application satisfies the settlement gate without payments', async () => {
    apps = [studyApp('AWAITING_TUITION', { scholarshipFull: true })]
    const res = await patch({ id: 'app-1', status: 'THESIS' })
    expect(res.status).toBe(200)
    expect(apps[0].status).toBe('THESIS')
  })

  test('post-gate to post-gate move (THESIS to SCHEDULED) is allowed', async () => {
    apps = [studyApp('THESIS')]
    const res = await patch({ id: 'app-1', status: 'SCHEDULED' })
    expect(res.status).toBe(200)
    expect(apps[0].status).toBe('SCHEDULED')
  })

  test('UI flow preserved: PENDING to UNDER_REVIEW', async () => {
    apps = [studyApp('PENDING')]
    const res = await patch({ id: 'app-1', status: 'UNDER_REVIEW' })
    expect(res.status).toBe(200)
    expect(apps[0].status).toBe('UNDER_REVIEW')
  })

  test('UI flow preserved: rejection from UNDER_REVIEW notifies once', async () => {
    apps = [studyApp('UNDER_REVIEW')]
    const res = await patch({ id: 'app-1', status: 'REJECTED' })
    expect(res.status).toBe(200)
    expect(apps[0].status).toBe('REJECTED')
    expect(decisionEmails).toBe(1)
  })

  test('same-status resend is a no-op (no duplicate rejection email)', async () => {
    apps = [studyApp('REJECTED')]
    const res = await patch({ id: 'app-1', status: 'REJECTED' })
    expect(res.status).toBe(200)
    expect(appUpdates.length).toBe(0)
    expect(decisionEmails).toBe(0)
  })

  test('CERTIFIED is terminal for the generic path (cannot be rejected)', async () => {
    apps = [studyApp('CERTIFIED')]
    const res = await patch({ id: 'app-1', status: 'REJECTED' })
    expect(res.status).toBe(409)
    expect(apps[0].status).toBe('CERTIFIED')
  })

  test('post-gate application cannot be dragged back to AWAITING_FEE', async () => {
    apps = [studyApp('THESIS')]
    const res = await patch({ id: 'app-1', status: 'AWAITING_FEE' })
    expect(res.status).toBe(409)
    expect(apps[0].status).toBe('THESIS')
  })
})

describe('admin admissions PATCH — supervisor assignment role check', () => {
  test('assigning a STUDENT account as supervisor is refused', async () => {
    apps = [studyApp('UNDER_REVIEW')]
    const res = await patch({ id: 'app-1', supervisorId: 'student-1' })
    expect(res.status).toBe(400)
    expect(apps[0].supervisorId).toBeUndefined()
  })

  test('assigning a VISITOR account as supervisor is refused', async () => {
    apps = [studyApp('UNDER_REVIEW')]
    const res = await patch({ id: 'app-1', supervisorId: 'visitor-1' })
    expect(res.status).toBe(400)
  })

  test('assigning a SUPERVISOR works', async () => {
    apps = [studyApp('UNDER_REVIEW')]
    const res = await patch({ id: 'app-1', supervisorId: 'sup-1' })
    expect(res.status).toBe(200)
    expect(apps[0].supervisorId).toBe('sup-1')
    expect(apps[0].supervisionMode).toBe('HYBRID')
  })

  test('assigning an ADMIN as human supervisor works (UI offers admins as supervisors)', async () => {
    apps = [studyApp('UNDER_REVIEW')]
    const res = await patch({ id: 'app-1', supervisorId: 'admin-2' })
    expect(res.status).toBe(200)
    expect(apps[0].supervisorId).toBe('admin-2')
    expect(apps[0].supervisionMode).toBe('HUMAN')
  })
})

describe('admissions finalize — UNDER_REVIEW idempotency', () => {
  function finalizeApp(status: string, pays: Row[]): Row {
    return {
      ...studyApp(status),
      programRef: { id: 'prog-1', titleAr: 'ماجستير مهني', category: 'MASTERS', slug: 'masters-mgmt', registrationStatus: 'OPEN', admissionRules: null },
      files: [{ id: 'file-1', docType: 'ID_CARD', fileName: 'id.pdf', size: 100, createdAt: new Date() }],
      payments: pays,
      user: { id: 'student-1', name: 'طالب اختبار', email: 'student@example.test', role: 'STUDENT' },
    }
  }

  test('repeat finalize on UNDER_REVIEW with settled fee: success, no rewrite, no duplicate email', async () => {
    apps = [finalizeApp('UNDER_REVIEW', [feeInvoice('PAID')])]
    const res = await finalize({ applicationId: 'app-1', uploadToken: 'tok' })
    expect(res.status).toBe(200)
    expect(res.json.reference).toBe('AACT-2026-1001')
    expect(res.json.invoice?.invoiceNo).toBe('AACT-INV-2026-0003')
    expect(apps[0].status).toBe('UNDER_REVIEW')
    expect(appUpdates.length).toBe(0)
    expect(submittedEmails).toBe(0)
  })

  test('repeat finalize on UNDER_REVIEW service request: idempotent success', async () => {
    docReqIsService = true
    apps = [finalizeApp('UNDER_REVIEW', [])]
    const res = await finalize({ applicationId: 'app-1', uploadToken: 'tok' })
    expect(res.status).toBe(200)
    expect(appUpdates.length).toBe(0)
    expect(serviceSubmittedEmails).toBe(0)
  })

  test('UNDER_REVIEW with UNPAID fee falls through to the repair path (back to AWAITING_FEE)', async () => {
    apps = [finalizeApp('UNDER_REVIEW', [feeInvoice('UNPAID')])]
    const res = await finalize({ applicationId: 'app-1', uploadToken: 'tok' })
    expect(res.status).toBe(200)
    expect(apps[0].status).toBe('AWAITING_FEE')
    expect(submittedEmails).toBe(1)
  })

  test('first finalize from AWAITING_FEE still runs the full flow', async () => {
    apps = [finalizeApp('AWAITING_FEE', [feeInvoice('UNPAID')])]
    const res = await finalize({ applicationId: 'app-1', uploadToken: 'tok' })
    expect(res.status).toBe(200)
    expect(appUpdates.length).toBe(1)
    expect(submittedEmails).toBe(1)
  })
})

describe('admin demo-accounts — production gate', () => {
  test('production without ENABLE_DEMO_ACCOUNTS: 403 and no accounts are created', async () => {
    process.env.VERCEL_ENV = 'production'
    const res = await demoAccountsPost()
    expect(res.status).toBe(403)
    expect(demoEnsureCalls).toBe(0)
  })

  test('production with ENABLE_DEMO_ACCOUNTS=1: allowed', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.ENABLE_DEMO_ACCOUNTS = '1'
    const res = await demoAccountsPost()
    expect(res.status).toBe(200)
    expect(demoEnsureCalls).toBe(1)
  })

  test('non-production: allowed without the flag', async () => {
    const res = await demoAccountsPost()
    expect(res.status).toBe(200)
    expect(demoEnsureCalls).toBe(1)
  })
})
