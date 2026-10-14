import { NextRequest } from 'next/server'
import QRCode from 'qrcode'
import {
  hashRepresentativeVerifier,
  representativeVerifyUrl,
  representativeQrDataUrl,
  serializeRepresentativePublicCard,
  verifyRepresentativeLast4,
} from '../src/lib/academy-representatives'
import {
  handleRepresentativeVerifyGet,
  handleRepresentativeVerifyPost,
} from '../src/lib/representative-verification'

process.env.NEXT_PUBLIC_APP_URL = 'https://academy.test'

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

function mockRepresentative(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rep-1',
    slug: 'rep-one',
    qrToken: 'token-ok',
    status: 'ACTIVE',
    cardNumber: 'REP-2026-0001',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: new Date('2027-01-01T00:00:00.000Z'),
    fullName: 'ممثل الاختبار',
    displayTitle: 'ممثل الأكاديمية',
    degreeTitle: 'دكتوراه مهنية',
    academicRank: 'مستشار',
    country: 'الأردن',
    region: 'بلاد الشام',
    territory: 'عمّان',
    city: 'عمّان',
    specialization: 'الإسعاف النفسي',
    representativeRole: 'COUNTRY_REPRESENTATIVE',
    shortBio: 'نبذة قصيرة',
    professionalBio: 'نبذة مهنية كاملة',
    worksSummary: 'أعمال معتمدة',
    achievements: 'إنجازات',
    publicContactNote: 'ملاحظة تواصل',
    phone: '+962 79 000 1234',
    email: 'rep@example.com',
    whatsapp: '+962 79 000 1234',
    website: 'https://rep.example.com',
    profilePhotoUrl: '/profile.png',
    officialCardUrl: '/official-card.png',
    verifyPhoneLast4Hash: hashRepresentativeVerifier('+962790001234'),
    deletedAt: null,
    featured: true,
    sortOrder: 1,
    files: [{ id: 'file-1', kind: 'PDF', title: 'ملف معتمد', description: 'وصف', fileUrl: '/approved.pdf', storageKey: null, reviewStatus: 'APPROVED' }],
    ...overrides,
  }
}

function makeDb(rep: any | null, initialAttempts = 0) {
  const logs: any[] = []
  for (let i = 0; i < initialAttempts; i += 1) logs.push({ action: 'REPRESENTATIVE_VERIFY_POST_ATTEMPT', details: '' })
  const db: any = {
    academyRepresentative: {
      findFirst: async ({ where }: any) => where.qrToken === 'token-ok' ? rep : null,
    },
    auditLog: {
      count: async ({ where }: any) => logs.filter((log) => log.action === where.action && (!where.details?.contains || String(log.details || '').includes(where.details.contains))).length,
      create: async ({ data }: any) => { logs.push(data); return data },
    },
    __logs: logs,
  }
  return db
}

async function json(response: Response) {
  return response.json() as Promise<any>
}

async function testGetPublicAllowlist() {
  const db = makeDb(mockRepresentative())
  const res = await handleRepresentativeVerifyGet(new NextRequest('https://academy.test/api/representatives/verify/token-ok', { headers: { 'x-forwarded-for': '1.1.1.1' } }), 'token-ok', db)
  assert(res.status === 200, 'GET with valid token must return 200')
  const body = await json(res as any)
  assert(body.representative.fullName === 'ممثل الاختبار', 'GET must return public representative name')
  assert(body.representative.cardNumber === 'REP-2026-0001', 'GET public payload must include card number')
  assert(String(body.representative.validFrom || '').startsWith('2026-01-01'), 'GET public payload must include validity start date')
  assert(String(body.representative.validUntil || '').startsWith('2027-01-01'), 'GET public payload must include validity end date')
  assert(!('phone' in body.representative), 'GET public payload must not include phone')
  assert(!('email' in body.representative), 'GET public payload must not include email')
  assert(!('whatsapp' in body.representative), 'GET public payload must not include whatsapp')
}

async function testSuspendedStatus() {
  const publicCard = serializeRepresentativePublicCard(mockRepresentative({ status: 'SUSPENDED' }), 'https://academy.test')
  assert(publicCard.statusLabel === 'موقوف / غير ساري ❌', 'non-active representative must be marked invalid')
  assert(publicCard.active === false, 'non-active representative must not be active')
}

async function testExpiredStatus() {
  const publicCard = serializeRepresentativePublicCard(mockRepresentative({ status: 'ACTIVE', validUntil: new Date('2020-01-01T00:00:00.000Z') }), 'https://academy.test')
  assert(publicCard.cardStatus === 'EXPIRED', 'past validUntil must make representative card expired')
  assert(publicCard.statusLabel === 'منتهي الصلاحية ❌', 'expired representative card must have a clear status label')
  assert(publicCard.active === false, 'expired representative card must not be active')
}

async function testWrongToken() {
  const db = makeDb(mockRepresentative())
  const res = await handleRepresentativeVerifyGet(new NextRequest('https://academy.test/api/representatives/verify/bad'), 'bad', db)
  const body = await json(res as any)
  assert(res.status === 404, 'wrong token must return 404')
  assert(body.message === 'هذا الرمز غير مسجل لدى الأكاديمية', 'wrong token must return the clear Arabic message')
}

async function testPostCorrectPhoneLast4() {
  const db = makeDb(mockRepresentative())
  const res = await handleRepresentativeVerifyPost(new NextRequest('https://academy.test/api/representatives/verify/token-ok', { method: 'POST', body: JSON.stringify({ last4: '1234' }), headers: { 'content-type': 'application/json' } }), 'token-ok', db)
  const body = await json(res as any)
  assert(res.status === 200, 'POST with correct phone last4 must return 200')
  assert(body.verified === true, 'POST with correct phone last4 must be verified')
  assert(body.representative.phone === '+962 79 000 1234', 'expanded payload must include phone after verification')
  assert(body.representative.email === 'rep@example.com', 'expanded payload must include email after verification')
}

async function testEmailLast4Rejected() {
  assert(!verifyRepresentativeLast4('.com', hashRepresentativeVerifier('+962790001234'), legacyEmailHash('.com')), 'email suffix .com must never verify representative details')
  const db = makeDb(mockRepresentative())
  const res = await handleRepresentativeVerifyPost(new NextRequest('https://academy.test/api/representatives/verify/token-ok', { method: 'POST', body: JSON.stringify({ last4: '.com' }), headers: { 'content-type': 'application/json' } }), 'token-ok', db)
  assert(res.status === 403, 'POST with .com must be rejected')
}

async function testNoPhoneCannotExpand() {
  const db = makeDb(mockRepresentative({ verifyPhoneLast4Hash: null, phone: null }))
  const res = await handleRepresentativeVerifyPost(new NextRequest('https://academy.test/api/representatives/verify/token-ok', { method: 'POST', body: JSON.stringify({ last4: '1234' }), headers: { 'content-type': 'application/json' } }), 'token-ok', db)
  assert(res.status === 403, 'representative without registered phone hash must not unlock expanded profile')
}

async function testRateLimitSixthAttempt() {
  const db = makeDb(mockRepresentative())
  const req = () => new NextRequest('https://academy.test/api/representatives/verify/token-ok', { method: 'POST', body: JSON.stringify({ last4: '0000' }), headers: { 'content-type': 'application/json', 'x-forwarded-for': '9.9.9.9' } })
  for (let i = 0; i < 5; i += 1) {
    const res = await handleRepresentativeVerifyPost(req(), 'token-ok', db)
    assert(res.status === 403, `attempt ${i + 1} must be invalid before limit`)
  }
  const sixth = await handleRepresentativeVerifyPost(req(), 'token-ok', db)
  assert(sixth.status === 429, 'sixth POST attempt within an hour must return 429')
}

async function testQrEncodesSameUrl() {
  const origin = 'https://academy.test'
  const token = 'rep-token-qr'
  const expectedUrl = representativeVerifyUrl(token, origin)
  const dataUrl = await representativeQrDataUrl(token, origin, 512)
  assert(dataUrl.startsWith('data:image/png;base64,'), 'representative QR must be a PNG data URL')
  const qr = QRCode.create(expectedUrl, { margin: 4, errorCorrectionLevel: 'M' } as any) as any
  const encoded = (qr.segments || []).map((segment: any) => {
    const data = segment?.data
    if (typeof data === 'string') return data
    if (data instanceof Uint8Array || Buffer.isBuffer(data)) return Buffer.from(data).toString('utf8')
    if (Array.isArray(data)) return Buffer.from(data).toString('utf8')
    return String(data || '')
  }).join('')
  assert(encoded === expectedUrl, 'QR library model must encode the exact representative verification URL')
}

async function main() {
  await testGetPublicAllowlist()
  await testSuspendedStatus()
  await testExpiredStatus()
  await testWrongToken()
  await testPostCorrectPhoneLast4()
  await testEmailLast4Rejected()
  await testNoPhoneCannotExpand()
  await testRateLimitSixthAttempt()
  await testQrEncodesSameUrl()
  console.log('✓ representative public card behavioral checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
