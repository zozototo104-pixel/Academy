import { describe, expect, test, mock } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'

// Guard for the 2026-10-26 application-submission reorganization:
// (1) agency pays like accreditation — application fee from settings,
//     approval blocked until PAID; (2) accreditation certificate issues
//     ONLY after the category fee is paid (auto-issue in settle-payment),
//     never at approval; (3) attachments come from admission rules, never
//     hardcoded — a custom doc enabled in rules is mandatory at submit;
// (4) login is required at submit for all four types (program, agency,
//     accreditation, service) — guests get 401 LOGIN_REQUIRED.

let currentUser: any = null
let agentApp: any = null
let paidPurposes: string[] = []
let createdPayments: any[] = []
let createdCertificates: any[] = []
let emailInvoices: any[] = []
let notifies: any[] = []

const AGENT_RULES = {
  requiredDocuments: ['LICENSE', 'ID', 'PHOTO', 'CV', 'CUSTOM_A1B2C3'],
  customDocuments: [{ type: 'CUSTOM_A1B2C3', label: 'رخصة مزاولة المهنة' }],
}

mock.module('@/lib/auth', () => ({
  getCurrentUser: async () => currentUser,
  requireAdmin: async () => ({ id: 'admin1', role: 'ADMIN', name: 'Admin', email: 'admin@aact.academy' }),
}))

mock.module('@/lib/settings', () => ({
  getSetting: async (key: string) => ({ FEE_AGENCY_APPLICATION: '100', FEE_ACC_APPLICATION: '100', FEE_ACC_QUALITY: '0', FEE_ACC_COMPANY: '1000', FEE_ACC_CONSULTANT: '350', FEE_ACC_TRAINER: '200' }[key] || ''),
  getSettingNum: async (key: string) => ({ FEE_AGENCY_APPLICATION: 100, FEE_ACC_APPLICATION: 100, FEE_ACC_QUALITY: 0, FEE_ACC_COMPANY: 1000, FEE_ACC_CONSULTANT: 350, FEE_ACC_TRAINER: 200 }[key] || 0),
  getSettingJson: async () => AGENT_RULES,
  getSettings: async () => ({ AGENT_COMMISSION_RATE: '25', COMMITTEE_MEMBER_FEE: '100', FEE_ACC_COMPANY: '1000', FEE_ACC_CONSULTANT: '350', FEE_ACC_TRAINER: '200', FEE_ACC_QUALITY: '0' }),
  nextInvoiceNo: async () => 'INV-1001',
  nextCertSerial: async () => 'CERT-1001',
  nextContractNo: async () => 'AACT-AG-2026-01',
  nextReceiptNo: async () => 'RC-1',
}))

mock.module('@/lib/db', () => ({
  db: {
    agentApplication: {
      create: async (args: any) => {
        const docs = Array.isArray(args.data?.documents?.create) ? args.data.documents.create.map((d: any, i: number) => ({ id: `doc-${i}`, ...d })) : []
        agentApp = { id: 'app1', ...args.data, documents: docs, certificates: [] }
        return agentApp
      },
      findUnique: async () => agentApp,
      update: async (args: any) => { agentApp = { ...agentApp, ...args.data }; return agentApp },
    },
    payment: {
      create: async (args: any) => { const p = { id: `pay-${createdPayments.length}`, ...args.data }; createdPayments.push(p); return p },
      findFirst: async (args: any) => (paidPurposes.includes(args.where.purpose) ? { id: 'pay-paid', status: 'PAID', purpose: args.where.purpose } : null),
      findMany: async () => [],
    },
    certificate: {
      create: async (args: any) => { const c = { id: `cert-${createdCertificates.length}`, ...args.data }; createdCertificates.push(c); return c },
    },
    user: {
      findUnique: async () => (currentUser ? { id: currentUser.id } : null),
      findMany: async () => [],
    },
    academyRepresentative: { create: async (args: any) => ({ id: 'rep1', ...args.data }) },
    setting: { upsert: async () => ({}), findUnique: async () => null },
  },
}))

mock.module('@/lib/notify', () => ({
  notify: async (...args: any[]) => { notifies.push(args); return {} },
  audit: async () => ({}),
}))

mock.module('@/lib/mailer', () => ({
  emailAgentInvoice: async (to: string, input: any) => { emailInvoices.push({ to, ...input }); return true },
  emailCertificateIssued: async () => true,
  emailPaymentReceipt: async () => true,
  emailFinalRegistration: async () => true,
  emailRepresentativeOnboardingInvitation: async () => true,
}))

mock.module('@/lib/storage', () => ({
  storageErrorMessage: () => 'storage error',
  storeFileBuffer: async () => ({ provider: 'LOCAL', key: 'k1', url: '/f1', mimeType: 'image/png', size: 100 }),
}))

mock.module('@/lib/academy-representatives', () => ({
  createRepresentativeQrToken: () => 'qr1',
  hashRepresentativeVerifier: () => 'hash1',
  normalizeRepresentativeSlug: (s: string) => s,
}))

mock.module('@/lib/tuition-installments', () => ({ getAdmissionTuitionPlan: async () => null }))
mock.module('@/lib/live-usage-guard', () => ({ grantGeminiLiveCredit: async () => ({}) }))
mock.module('@/lib/money', () => ({ paymentAmountDollars: (p: any) => Number(p?.amount || 0) }))

function agentForm(kind: string, docs: string[], extra: Record<string, string> = {}) {
  const fd = new FormData()
  fd.append('kind', kind)
  fd.append('orgName', 'Test Org')
  fd.append('repName', 'Test Rep')
  fd.append('email', 'rep@test.com')
  fd.append('phone', '+201234567890')
  fd.append('country', 'مصر')
  if (kind === 'AGENCY') fd.append('territory', 'مصر')
  else fd.append('accreditationType', extra.accreditationType || 'TRAINER')
  for (const d of docs) fd.append(`doc_${d}`, new File(['x'], `${d}.png`, { type: 'image/png' }))
  return new NextRequest('http://localhost/api/agent-apply', { method: 'POST', body: fd })
}

describe('application-submission reorganization', () => {
  test('settings carry the agency fee (100) and the quality fee (0)', () => {
    const settings = readFileSync('src/lib/settings.ts', 'utf8')
    expect(settings).toContain("FEE_AGENCY_APPLICATION', value: '100'")
    expect(settings).toContain("FEE_ACC_QUALITY', value: '0'")
  })

  test('agent-apply rejects guests with 401 LOGIN_REQUIRED', async () => {
    currentUser = null
    const { POST } = await import('@/app/api/agent-apply/route')
    const res = await POST(agentForm('AGENCY', ['LICENSE', 'ID', 'PHOTO', 'CV', 'CUSTOM_A1B2C3']))
    const body = await res.json()
    expect(res.status).toBe(401)
    expect(body.code).toBe('LOGIN_REQUIRED')
  })

  test('agency submit creates an AGENCY_FEE invoice from settings and emails it', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    createdPayments = []
    emailInvoices = []
    const { POST } = await import('@/app/api/agent-apply/route')
    const res = await POST(agentForm('AGENCY', ['LICENSE', 'ID', 'PHOTO', 'CV', 'CUSTOM_A1B2C3']))
    const body = await res.json()
    expect(res.status).toBe(200)
    const fee = createdPayments.find((p) => p.purpose === 'AGENCY_FEE')
    expect(fee).toBeTruthy()
    expect(fee.amount).toBe(100)
    expect(body.invoice.invoiceNo).toBe('INV-1001')
    expect(emailInvoices[0].to).toBe('rep@test.com')
    expect(emailInvoices[0].invoiceNo).toBe('INV-1001')
  })

  test('agency submit missing a rules-enabled custom doc is rejected with its label', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    const { POST } = await import('@/app/api/agent-apply/route')
    const res = await POST(agentForm('AGENCY', ['LICENSE', 'ID', 'PHOTO', 'CV']))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toContain('رخصة مزاولة المهنة')
  })

  test('accreditation COMPANY is no longer a valid type (individuals only)', async () => {
    currentUser = { id: 'u1', role: 'STUDENT' }
    const { POST } = await import('@/app/api/agent-apply/route')
    const res = await POST(agentForm('ACCREDITATION', ['LICENSE', 'ID', 'PHOTO', 'CV', 'CUSTOM_A1B2C3'], { accreditationType: 'COMPANY' }))
    expect(res.status).toBe(400)
  })

  test('agency approval blocked until the agency fee is PAID', async () => {
    paidPurposes = []
    agentApp = { id: 'app1', kind: 'AGENCY', orgName: 'Test Org', repName: 'Test Rep', email: 'rep@test.com', country: 'مصر', territory: 'مصر', contractNo: null, certificates: [] }
    const { PATCH } = await import('@/app/api/admin/applications/route')
    const res = await PATCH(new NextRequest('http://localhost/api/admin/applications', { method: 'PATCH', body: JSON.stringify({ id: 'app1', status: 'APPROVED' }) }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toContain('100$')
  })

  test('accreditation approval creates a category invoice and NO certificate until payment', async () => {
    paidPurposes = ['ACCREDITATION_FEE']
    createdPayments = []
    createdCertificates = []
    agentApp = { id: 'app1', kind: 'ACCREDITATION', accreditationType: 'TRAINER', orgName: 'Test Org', repName: 'Test Rep', email: 'rep@test.com', country: 'مصر', contractNo: null, certificates: [] }
    const { PATCH } = await import('@/app/api/admin/applications/route')
    const res = await PATCH(new NextRequest('http://localhost/api/admin/applications', { method: 'PATCH', body: JSON.stringify({ id: 'app1', status: 'APPROVED' }) }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.categoryInvoice.amount).toBe(200)
    expect(body.certSerial).toBeNull()
    expect(createdCertificates.length).toBe(0)
    expect(createdPayments.find((p) => p.purpose === 'ACCREDITATION')).toBeTruthy()
  })

  test('accreditation approval with a 0 category fee issues the certificate immediately', async () => {
    paidPurposes = ['ACCREDITATION_FEE']
    createdPayments = []
    createdCertificates = []
    agentApp = { id: 'app1', kind: 'ACCREDITATION', accreditationType: 'QUALITY', orgName: 'Test Org', repName: 'Test Rep', email: 'rep@test.com', country: 'مصر', contractNo: null, certificates: [] }
    const { PATCH } = await import('@/app/api/admin/applications/route')
    const res = await PATCH(new NextRequest('http://localhost/api/admin/applications', { method: 'PATCH', body: JSON.stringify({ id: 'app1', status: 'APPROVED' }) }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.certSerial).toBe('CERT-1001')
    expect(body.categoryInvoice).toBeNull()
    expect(createdCertificates.length).toBe(1)
  })

  test('settle-payment certificate guard: only category-fee payment on an approved accreditation with no certificate', async () => {
    const { accreditationCertificateDue } = await import('@/lib/settle-payment')
    const agent = { status: 'APPROVED', kind: 'ACCREDITATION', certificates: [] }
    expect(accreditationCertificateDue({ purpose: 'ACCREDITATION', agentId: 'app1' }, agent)).toBe(true)
    expect(accreditationCertificateDue({ purpose: 'ACCREDITATION_FEE', agentId: 'app1' }, agent)).toBe(false)
    expect(accreditationCertificateDue({ purpose: 'APPLICATION_FEE', agentId: 'app1' }, agent)).toBe(false)
    expect(accreditationCertificateDue({ purpose: 'ACCREDITATION', agentId: 'app1' }, { ...agent, status: 'PENDING' })).toBe(false)
    expect(accreditationCertificateDue({ purpose: 'ACCREDITATION', agentId: 'app1' }, { ...agent, kind: 'AGENCY' })).toBe(false)
    expect(accreditationCertificateDue({ purpose: 'ACCREDITATION', agentId: 'app1' }, { ...agent, certificates: [{ id: 'c1' }] })).toBe(false)
    expect(accreditationCertificateDue({ purpose: 'ACCREDITATION', agentId: null }, agent)).toBe(false)
  })

  test('custom docs from program rules surface with their labels in the resolver', async () => {
    const { resolveAdmissionRequiredDocuments } = await import('@/lib/admission-required-documents')
    const resolved = resolveAdmissionRequiredDocuments({
      category: 'DIPLOMA',
      admissionRules: {
        requiredDocuments: ['DEGREE', 'CUSTOM_X1Y2Z3'],
        customDocuments: [{ type: 'CUSTOM_X1Y2Z3', label: 'شهادة خبرة معتمدة' }],
      },
    })
    expect(resolved.requiredDocs.map((d: any) => d.label)).toContain('شهادة خبرة معتمدة')
  })

  test('client wiring: login prompt, agency rules scope, email confirmation', () => {
    const agentView = readFileSync('src/components/aact/AgentView.tsx', 'utf8')
    expect(agentView).toContain('نرجو تسجيل الدخول لاستكمال الطلب')
    expect(agentView).toContain("navigate('auth')")
    expect(agentView).toContain('تم إرسال رسالة إلى بريدك')
    const applyView = readFileSync('src/components/aact/ApplyView.tsx', 'utf8')
    expect(applyView).toContain('نرجو تسجيل الدخول لاستكمال الطلب')
    expect(applyView).toContain('تم إرسال رسالة إلى بريدك')
    const rulesTab = readFileSync('src/components/aact/AdminRulesTab.tsx', 'utf8')
    expect(rulesTab).toContain('إضافة مرفق')
    expect(rulesTab).toContain('/api/admin/agent-rules')
    expect(rulesTab).toContain('قواعد الوكالة والاعتماد')
    const adminView = readFileSync('src/components/aact/AdminView.tsx', 'utf8')
    expect(adminView).toContain('فاتورة رسوم الفئة')
  })
})
