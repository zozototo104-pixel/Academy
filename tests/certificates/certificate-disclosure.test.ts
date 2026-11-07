/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'

// Guard: سياسة إفصاح الشهادات على الأسطح العامة (صفحة التحقق + مسار W3C).
// - البحث بالرقم التسلسلي أو الرقم القديم (قابل للتخمين/التعداد) يعرض الحد
//   الأدنى العام فقط: الاسم، البرنامج، الرقم المعروض، حالة الصلاحية.
//   لا تقدير، لا qrToken، لا رابط PDF، ولا رمز داخل اعتماد W3C.
// - تقديم رمز QR نفسه (مسح الرمز المطبوع) يعرض التفاصيل الكاملة كما اليوم.
// - صفحة التحقق تحدّ محاولات البحث بالأرقام التسلسلية قبل لمس قاعدة البيانات.

const CERT: any = {
  id: 'cert-disclosure-1',
  serial: 'AACT-C-2026-00042',
  legacySerial: 'LEG-0042',
  qrPosition: null,
  qrToken: '0123456789abcdef0123456789abcdef',
  type: 'DIPLOMA',
  holderName: 'طالب اختبار الإفصاح',
  program: 'دبلوم اختبار الإفصاح',
  grade: 'امتياز',
  country: 'فلسطين',
  issuedAt: new Date('2026-01-15T00:00:00Z'),
  valid: true,
  revokedAt: null,
  revokedReason: null,
  userId: 'user-disclosure-1',
  enrollmentId: null,
  admissionId: null,
  agentId: null,
}

const db: any = {
  certificate: {
    findFirst: async ({ where }: any) => {
      const ors = where?.OR || []
      const hit = ors.some(
        (cond: any) =>
          (cond.qrToken && cond.qrToken === CERT.qrToken) ||
          (cond.serial && cond.serial === CERT.serial) ||
          (cond.legacySerial && cond.legacySerial === CERT.legacySerial)
      )
      return hit ? { ...CERT } : null
    },
  },
}

mock.module('@/lib/db', () => ({ db }))
// displayedCertificateSerial بقيم qrPosition غير JSON يعيد الرقم التسلسلي —
// هذا هو سلوك الدالة الحقيقية للحالات المستخدمة هنا (لها مجموعتها الخاصة).
mock.module('@/lib/legacy-certificate-files', () => ({
  displayedCertificateSerial: (cert: any) => cert.serial || '',
}))
mock.module('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.23' }),
}))

const { GET: w3cGET } = await import('../../src/app/api/verify/certificates/[token]/route')
const CertificateVerifyPage = (await import('../../src/app/verify/certificates/[token]/page')).default
const { NextRequest } = await import('next/server')

async function w3cBody(segment: string) {
  const req = new NextRequest(`https://example.test/api/verify/certificates/${encodeURIComponent(segment)}`)
  const res = await w3cGET(req, { params: { token: segment } })
  const text = await res.text()
  return { status: res.status, text, json: JSON.parse(text) }
}

async function pageTree(segment: string) {
  const el = await CertificateVerifyPage({ params: { token: segment } })
  return JSON.stringify(el)
}

describe('W3C credential route disclosure', () => {
  test('serial lookup: no qrToken anywhere, no grade, no verificationToken, proof still verifies', async () => {
    const { status, text, json } = await w3cBody(CERT.serial)
    expect(status).toBe(200)
    expect(text.includes(CERT.qrToken)).toBe(false)
    expect(json.credential.evidence[0].verificationToken).toBeUndefined()
    expect(json.credential.credentialSubject.grade).toBeNull()
    expect(json.verificationUrl.includes(CERT.serial)).toBe(true)
    expect(json.proofVerified).toBe(true)
    expect(json.valid).toBe(true)
  })

  test('legacy serial lookup: same redaction', async () => {
    const { text, json } = await w3cBody(CERT.legacySerial)
    expect(text.includes(CERT.qrToken)).toBe(false)
    expect(json.credential.evidence[0].verificationToken).toBeUndefined()
    expect(json.credential.credentialSubject.grade).toBeNull()
  })

  test('token lookup: full credential with token, grade and a verifying proof', async () => {
    const { status, text, json } = await w3cBody(CERT.qrToken)
    expect(status).toBe(200)
    expect(text.includes(CERT.qrToken)).toBe(true)
    expect(json.credential.evidence[0].verificationToken).toBe(CERT.qrToken)
    expect(json.credential.credentialSubject.grade).toBe(CERT.grade)
    expect(json.proofVerified).toBe(true)
  })
})

describe('verify page disclosure', () => {
  test('serial lookup renders the public minimum only', async () => {
    const tree = await pageTree(CERT.serial)
    expect(tree.includes(CERT.holderName)).toBe(true)
    expect(tree.includes(CERT.serial)).toBe(true)
    expect(tree.includes(CERT.qrToken)).toBe(false)
    expect(tree.includes(CERT.grade)).toBe(false)
    expect(tree.includes('/api/pdf/')).toBe(false)
  })

  test('legacy serial lookup renders the public minimum only', async () => {
    const tree = await pageTree(CERT.legacySerial)
    expect(tree.includes(CERT.holderName)).toBe(true)
    expect(tree.includes(CERT.qrToken)).toBe(false)
    expect(tree.includes(CERT.grade)).toBe(false)
    expect(tree.includes('/api/pdf/')).toBe(false)
  })

  test('token lookup keeps the full rendering (grade, token, PDF link)', async () => {
    const tree = await pageTree(CERT.qrToken)
    expect(tree.includes(CERT.holderName)).toBe(true)
    expect(tree.includes(CERT.qrToken)).toBe(true)
    expect(tree.includes(CERT.grade)).toBe(true)
    expect(tree.includes(`/api/pdf/certificates/${CERT.qrToken}`)).toBe(true)
  })

  test('serial lookups are rate limited: the 21st lookup of one serial is refused', async () => {
    const probeSerial = 'AACT-C-2026-99999'
    let lastTree = ''
    for (let i = 1; i <= 20; i++) {
      lastTree = await pageTree(probeSerial)
      expect(lastTree.includes('محاولات تحقق كثيرة')).toBe(false)
    }
    const limitedTree = await pageTree(probeSerial)
    expect(limitedTree.includes('محاولات تحقق كثيرة')).toBe(true)
  })
})
