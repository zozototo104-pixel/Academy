/// <reference types="bun-types" />
import type { AcademyRepresentative } from '@prisma/client'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { hashRepresentativeOnboardingToken, verifyRepresentativeLast4 } from '../../src/lib/academy-representatives'

process.env.SMTP_HOST = ''
process.env.SMTP_USER = ''
process.env.SMTP_PASS = ''
process.env.RESEND_API_KEY = ''
process.env.MAIL_FROM = ''
process.env.RESEND_FROM = ''

const representatives = new Map<string, AcademyRepresentative>()
const files = new Map<string, any>()
const rateWindows = new Map<string, any>()
const auditLogs: any[] = []
const emailLogs: any[] = []
let fileSequence = 0
let storageSequence = 0

function clone(value: any) {
  return value == null ? value : { ...value }
}

function representativeFiles(representativeId: string) {
  return [...files.values()].filter((file) => file.representativeId === representativeId).map(clone)
}

function applySelect(row: any, select?: Record<string, boolean>) {
  if (!select) return clone(row)
  const picked: any = {}
  for (const [key, enabled] of Object.entries(select)) {
    if (enabled) picked[key] = row[key]
  }
  return picked
}

function representativeMatchesWhere(row: any, where: any) {
  if (where.id && row.id !== where.id) return false
  if ('deletedAt' in where && row.deletedAt !== where.deletedAt) return false
  if (where.onboardingTokenHash && row.onboardingTokenHash !== where.onboardingTokenHash) return false
  if (where.status?.notIn?.includes(row.status)) return false
  return true
}

const db: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(db),
  academyRepresentative: {
    findFirst: async ({ where, include, select }: any) => {
      const row = [...representatives.values()].find((item) => representativeMatchesWhere(item, where || {}))
      if (!row) return null
      const value = applySelect(row, select)
      if (include?.files) value.files = representativeFiles(row.id)
      return value
    },
    findUnique: async ({ where, select }: any) => {
      const row = where.id
        ? representatives.get(where.id)
        : [...representatives.values()].find((item) => item.slug === where.slug)
      return row ? applySelect(row, select) : null
    },
    update: async ({ where, data, select, include }: any) => {
      const row = representatives.get(where.id)
      if (!row) throw new Error('REPRESENTATIVE_NOT_FOUND')
      Object.assign(row, data, { updatedAt: new Date() })
      const value = applySelect(row, select)
      if (include?.files) value.files = representativeFiles(row.id)
      return value
    },
  },
  academyRepresentativeFile: {
    create: async ({ data }: any) => {
      const file = { id: `file-${++fileSequence}`, createdAt: new Date(), ...data }
      files.set(file.id, file)
      return clone(file)
    },
    findFirst: async ({ where }: any) => {
      const file = [...files.values()].find((item) => item.id === where.id && item.representativeId === where.representativeId)
      return file ? clone(file) : null
    },
    update: async ({ where, data }: any) => {
      const file = files.get(where.id)
      if (!file) throw new Error('FILE_NOT_FOUND')
      Object.assign(file, data)
      return clone(file)
    },
    delete: async ({ where }: any) => {
      const file = files.get(where.id)
      files.delete(where.id)
      return clone(file)
    },
  },
  keyRateWindow: {
    upsert: async ({ where, create, update, select }: any) => {
      const key = `${where.keyHash_window_windowStart.keyHash}:${where.keyHash_window_windowStart.window}:${where.keyHash_window_windowStart.windowStart.toISOString()}`
      const existing = rateWindows.get(key)
      if (existing) existing.count += update.count.increment
      else rateWindows.set(key, { ...create })
      const row = rateWindows.get(key)
      return select ? applySelect(row, select) : clone(row)
    },
  },
  auditLog: {
    create: async ({ data }: any) => { auditLogs.push(data); return data },
  },
  setting: {
    findMany: async () => [],
  },
  emailLog: {
    create: async ({ data }: any) => { emailLogs.push(data); return data },
  },
  user: {
    findMany: async () => [],
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'Admin', role: 'ADMIN' }) }))
mock.module('@/lib/storage', () => ({
  storeFileBuffer: async ({ mimeType, buffer }: any) => {
    const id = ++storageSequence
    return { provider: 'test-storage', key: `representatives/test-${id}`, url: `/private/test-${id}.png`, mimeType, size: buffer.byteLength }
  },
  readStoredFile: async () => null,
  storageErrorMessage: (error: unknown) => String((error as any)?.message || error || 'storage error'),
}))
mock.module('@/lib/document-extract', () => ({ extractDocumentText: async () => ({ readable: false, text: '', reader: 'mock', note: 'not needed' }) }))
mock.module('@/lib/text-ai', () => ({ textAiCompleteJson: async () => JSON.stringify({}) }))

const adminOnboardingRoute = await import('../../src/app/api/admin/representatives/[id]/onboarding/route')
const publicOnboardingRoute = await import('../../src/app/api/representatives/onboarding/[token]/route')
const adminFileRoute = await import('../../src/app/api/admin/representatives/[id]/files/[fileId]/route')
const { sendEmailDetailed } = await import('../../src/lib/mailer')

function seedRepresentative(overrides: Partial<AcademyRepresentative> = {}) {
  const rep: AcademyRepresentative = {
    id: 'rep-active',
    slug: 'rep-active',
    status: 'ACTIVE',
    cardNumber: 'REP-1',
    validFrom: new Date('2026-01-01T00:00:00.000Z'),
    validUntil: new Date('2027-01-01T00:00:00.000Z'),
    fullName: 'ممثل نشط',
    displayTitle: null,
    degreeTitle: null,
    academicRank: null,
    country: 'فلسطين',
    region: 'القدس',
    territory: 'فلسطين',
    city: 'القدس',
    specialization: null,
    representativeRole: 'COUNTRY_REPRESENTATIVE',
    shortBio: null,
    rawBio: null,
    professionalBio: null,
    worksSummary: null,
    achievements: null,
    publicContactNote: null,
    phone: '+970 59 000 1111',
    email: null,
    whatsapp: '+970 59 000 1111',
    website: null,
    profilePhotoUrl: '/public/old-photo.png',
    profilePhotoName: null,
    profilePhotoMime: null,
    profilePhotoSize: null,
    profilePhotoStorageProvider: null,
    profilePhotoStorageKey: null,
    officialCardUrl: '/public/old-card.png',
    officialCardName: null,
    officialCardMime: null,
    officialCardSize: null,
    officialCardStorageProvider: null,
    officialCardStorageKey: null,
    qrToken: 'qr-token',
    verifyPhoneLast4Hash: null,
    verifyEmailLast4Hash: null,
    aiRewriteStatus: 'NOT_RUN',
    aiRewriteNote: null,
    featured: false,
    sortOrder: 0,
    sourceAgentApplicationId: null,
    sourceUserId: null,
    onboardingStatus: 'ADMIN_CREATED',
    onboardingToken: null,
    onboardingTokenHash: null,
    onboardingExpiresAt: null,
    onboardingSubmittedAt: null,
    createdById: null,
    updatedById: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
  Object.assign(rep, overrides)
  representatives.set(rep.id, rep)
  return rep
}

async function json(response: Response) {
  return response.json() as Promise<any>
}

async function createOnboardingLink(id: string) {
  const res = await adminOnboardingRoute.POST(new Request(`https://academy.test/api/admin/representatives/${id}/onboarding`, { method: 'POST' }), { params: Promise.resolve({ id }) } as any)
  return { res, body: await json(res as any) }
}

function tokenFromUrl(url: string) {
  const parsed = new URL(url)
  return decodeURIComponent(parsed.pathname.split('/').pop() || '')
}

function publicGet(token: string, ip = '1.1.1.1') {
  return publicOnboardingRoute.GET(
    new NextRequest(`https://academy.test/api/representatives/onboarding/${encodeURIComponent(token)}`, { headers: { 'x-forwarded-for': ip } }),
    { params: Promise.resolve({ token }) } as any
  )
}

function tinyPng() {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0])
}

beforeEach(() => {
  representatives.clear()
  files.clear()
  rateWindows.clear()
  auditLogs.splice(0, auditLogs.length)
  emailLogs.splice(0, emailLogs.length)
  fileSequence = 0
  storageSequence = 0
})

describe('representative onboarding links', () => {
  test('ACTIVE representative receives a new hashed link and raw token is never stored', async () => {
    const rep = seedRepresentative({ email: 'rep@example.test' })
    const { res, body } = await createOnboardingLink(rep.id)
    expect(res.status).toBe(200)
    expect(body.emailStatus).toBe('SKIPPED')
    const token = tokenFromUrl(body.url)
    expect(token.startsWith('rep_onb_')).toBe(true)
    expect(rep.onboardingToken).toBeNull()
    expect(rep.onboardingTokenHash).toBe(hashRepresentativeOnboardingToken(token))
    expect(rep.onboardingTokenHash).not.toBe(token)
    expect(rep.onboardingExpiresAt instanceof Date).toBe(true)
  })

  test('SUSPENDED representative cannot receive onboarding links', async () => {
    const rep = seedRepresentative({ id: 'rep-suspended', status: 'SUSPENDED' })
    const { res, body } = await createOnboardingLink(rep.id)
    expect(res.status).toBe(409)
    expect(String(body.error)).toContain('موقوف')
  })

  test('expired onboarding link is rejected clearly', async () => {
    const token = 'rep_onb_expired'
    seedRepresentative({ onboardingTokenHash: hashRepresentativeOnboardingToken(token), onboardingExpiresAt: new Date('2020-01-01T00:00:00.000Z') })
    const res = await publicGet(token)
    const body = await json(res as any)
    expect(res.status).toBe(410)
    expect(body.message).toBe('انتهت صلاحية الرابط، اطلب رابط جديد من الإدارة')
  })

  test('creating a new link cancels the old hash', async () => {
    const rep = seedRepresentative()
    const first = await createOnboardingLink(rep.id)
    const firstToken = tokenFromUrl(first.body.url)
    const second = await createOnboardingLink(rep.id)
    const secondToken = tokenFromUrl(second.body.url)
    expect(firstToken).not.toBe(secondToken)
    expect(rep.onboardingTokenHash).toBe(hashRepresentativeOnboardingToken(secondToken))

    const oldRes = await publicGet(firstToken, '2.2.2.2')
    expect(oldRes.status).toBe(404)
    const newRes = await publicGet(secondToken, '2.2.2.3')
    expect(newRes.status).toBe(200)
  })

  test('sendEmailDetailed returns SKIPPED when email delivery is not configured', async () => {
    const status = await sendEmailDetailed({ to: 'rep@example.test', event: 'TEST_EVENT', subject: 'اختبار', html: '<p>اختبار</p>' })
    expect(status).toBe('SKIPPED')
    expect(emailLogs[emailLogs.length - 1]).toMatchObject({ status: 'SKIPPED' })
  })

  test('database rate limit returns 429 after 30 GET requests per token and IP', async () => {
    const token = 'rep_onb_rate_limited'
    seedRepresentative({ onboardingTokenHash: hashRepresentativeOnboardingToken(token), onboardingExpiresAt: new Date(Date.now() + 86_400_000) })
    for (let index = 0; index < 30; index++) {
      const res = await publicGet(token, '7.7.7.7')
      expect(res.status).toBe(200)
    }
    const limited = await publicGet(token, '7.7.7.7')
    const body = await json(limited as any)
    expect(limited.status).toBe(429)
    expect(body.message).toContain('تم تجاوز الحد المسموح')
  })
})

describe('representative active profile pending review', () => {
  test('ACTIVE representative official-card upload stays pending and does not change the public card before approval', async () => {
    const token = 'rep_onb_active_upload'
    const rep = seedRepresentative({ onboardingTokenHash: hashRepresentativeOnboardingToken(token), onboardingExpiresAt: new Date(Date.now() + 86_400_000) })
    const form = new FormData()
    form.set('assetType', 'officialCard')
    form.set('file', new File([tinyPng()], 'new-card.png', { type: 'image/png' }))

    const res = await publicOnboardingRoute.POST(
      new NextRequest(`https://academy.test/api/representatives/onboarding/${encodeURIComponent(token)}`, { method: 'POST', body: form, headers: { 'x-forwarded-for': '8.8.8.8' } }),
      { params: Promise.resolve({ token }) } as any
    )
    const body = await json(res as any)
    expect(res.status).toBe(200)
    expect(body.file.reviewStatus).toBe('PENDING_REVIEW')
    expect(body.file.kind).toBe('OFFICIAL_CARD')
    expect(rep.officialCardUrl).toBe('/public/old-card.png')
  })

  test('approving pending JSON and card changes applies them to AcademyRepresentative inside review flow', async () => {
    const rep = seedRepresentative()
    const profileFile = await db.academyRepresentativeFile.create({
      data: {
        representativeId: rep.id,
        kind: 'PROFILE_CHANGE',
        title: 'تعديل بيانات حساسة بانتظار مراجعة الإدارة',
        description: JSON.stringify({ 'الاسم الكامل بالعربي': 'ممثل معتمد جديد', 'الهاتف': '+970 59 123 4567', 'البريد الإلكتروني': 'new.rep.1234@example.test' }),
        reviewStatus: 'PENDING_REVIEW',
      },
    })
    const cardFile = await db.academyRepresentativeFile.create({
      data: {
        representativeId: rep.id,
        kind: 'OFFICIAL_CARD',
        title: 'بطاقة رسمية بانتظار اعتماد الإدارة',
        fileName: 'new-card.png',
        mimeType: 'image/png',
        size: 16,
        storageProvider: 'test-storage',
        storageKey: 'representatives/new-card.png',
        fileUrl: '/private/new-card.png',
        reviewStatus: 'PENDING_REVIEW',
      },
    })

    const profileRes = await adminFileRoute.PATCH(
      new Request(`https://academy.test/api/admin/representatives/${rep.id}/files/${profileFile.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'APPROVE' }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: rep.id, fileId: profileFile.id }) } as any
    )
    expect(profileRes.status).toBe(200)
    expect(rep.fullName).toBe('ممثل معتمد جديد')
    expect(rep.phone).toBe('+970 59 123 4567')
    expect(rep.email).toBe('new.rep.1234@example.test')
    expect(verifyRepresentativeLast4('4567', rep.verifyPhoneLast4Hash)).toBe(true)
    expect(verifyRepresentativeLast4('1234', rep.verifyEmailLast4Hash)).toBe(true)

    const cardRes = await adminFileRoute.PATCH(
      new Request(`https://academy.test/api/admin/representatives/${rep.id}/files/${cardFile.id}`, { method: 'PATCH', body: JSON.stringify({ action: 'APPROVE' }), headers: { 'content-type': 'application/json' } }),
      { params: Promise.resolve({ id: rep.id, fileId: cardFile.id }) } as any
    )
    expect(cardRes.status).toBe(200)
    expect(rep.officialCardUrl).toBe('/private/new-card.png')
    expect(files.get(cardFile.id)?.reviewStatus).toBe('APPROVED')
    expect(auditLogs.some((log) => log.action === 'APPROVE_REPRESENTATIVE_FILE')).toBe(true)
  })
})
