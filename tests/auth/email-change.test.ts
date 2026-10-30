import { describe, expect, mock, test } from 'bun:test'

process.env.NEXT_PUBLIC_APP_URL = 'https://example.test'

// ---------- in-memory db ----------
type Row = Record<string, any>
const users: Row[] = []
const audits: Row[] = []

function findBy(where: Row) {
  return users.find((u) => {
    if (where.id && u.id !== where.id) return false
    if (where.email && u.email !== where.email) return false
    if (where.emailVerificationTokenHash && u.emailVerificationTokenHash !== where.emailVerificationTokenHash) return false
    return true
  }) || null
}

const dbMock = {
  user: {
    findUnique: async ({ where }: any) => findBy(where),
    findFirst: async ({ where }: any) => {
      const u = findBy(where)
      if (!u) return null
      if (where.emailVerificationExpiresAt?.gt && !(u.emailVerificationExpiresAt > where.emailVerificationExpiresAt.gt)) return null
      if (where.status && u.status !== where.status) return null
      return u
    },
    update: async ({ where, data }: any) => {
      const u = findBy(where)
      if (!u) throw new Error('not found')
      Object.assign(u, data)
      return u
    },
  },
  auditLog: { create: async ({ data }: any) => { audits.push(data); return data } },
}
mock.module('@/lib/db', () => ({ db: dbMock }))

// ---------- mailer capture ----------
const confirmMails: any[] = []
mock.module('@/lib/mailer', () => ({
  emailEmailChangeConfirm: async (...args: any[]) => { confirmMails.push(args); return true },
  emailEmailChangeNotice: async () => true,
  emailWelcome: async () => true,
}))

// ---------- auth: session + password ----------
let sessionUser: Row | null = null
mock.module('@/lib/auth', () => ({
  getCurrentUser: async () => sessionUser,
  requireAdmin: async () => {
    if (!sessionUser || sessionUser.role !== 'ADMIN') throw new Error('forbidden')
    return sessionUser
  },
  verifyPassword: async (pw: string, hash: string) => hash === `hash:${pw}`,
}))

const { requestEmailChange, applyPendingEmailChange } = await import('@/lib/email-change')
const { hashEmailVerificationToken } = await import('@/lib/email-verification')
const { POST: studentPost } = await import('@/app/api/auth/email-change/route')
const { POST: adminPost } = await import('@/app/api/admin/students/email-change/route')
const { GET: verifyGet } = await import('@/app/api/auth/verify-email/route')
const { NextRequest } = await import('next/server')

function seed(partial: Row) {
  const u: Row = {
    id: partial.id || `u${users.length + 1}`,
    email: 'old@student.com',
    name: 'طالب تجريبي',
    password: 'hash:pw123456',
    role: 'STUDENT',
    status: 'ACTIVE',
    authProvider: 'EMAIL',
    emailVerifiedAt: new Date(),
    notificationEmail: null,
    pendingEmail: null,
    pendingEmailPurpose: null,
    emailVerificationTokenHash: null,
    emailVerificationExpiresAt: null,
    emailVerificationSentAt: null,
    ...partial,
  }
  users.push(u)
  return u
}
const req = () => new NextRequest('https://example.test/api/auth/email-change')

describe('requestEmailChange', () => {
  test('password account: LOGIN change with the correct password sets a pending change and mails the NEW box', async () => {
    users.length = 0; confirmMails.length = 0
    const u = seed({})
    const res = await requestEmailChange({ req: req(), user: u as any, newEmail: 'New@Student.com', purpose: 'LOGIN', password: 'pw123456' })
    expect(res.ok).toBe(true)
    expect(u.pendingEmail).toBe('new@student.com')
    expect(u.pendingEmailPurpose).toBe('LOGIN')
    expect(typeof u.emailVerificationTokenHash).toBe('string')
    expect(u.email).toBe('old@student.com') // untouched until confirmation
    expect(confirmMails.length).toBe(1)
    expect(confirmMails[0][0]).toBe('new@student.com')
    expect(confirmMails[0][3]).toBe('LOGIN')
  })

  test('LOGIN with a wrong password is refused and stores nothing', async () => {
    users.length = 0
    const u = seed({})
    const res = await requestEmailChange({ req: req(), user: u as any, newEmail: 'new@student.com', purpose: 'LOGIN', password: 'nope' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(401)
    expect(u.pendingEmail).toBeNull()
  })

  test('GOOGLE account: LOGIN swap refused, NOTIFICATION allowed without a password', async () => {
    users.length = 0; confirmMails.length = 0
    const u = seed({ authProvider: 'GOOGLE', password: 'hash:random-unknown' })
    const login = await requestEmailChange({ req: req(), user: u as any, newEmail: 'new@student.com', purpose: 'LOGIN', password: 'whatever' })
    expect(login.ok).toBe(false)
    if (!login.ok) expect(login.code).toBe('GOOGLE_USE_NOTIFICATION')
    const notif = await requestEmailChange({ req: req(), user: u as any, newEmail: 'new@student.com', purpose: 'NOTIFICATION' })
    expect(notif.ok).toBe(true)
    expect(u.pendingEmailPurpose).toBe('NOTIFICATION')
  })

  test('LOGIN to an email owned by another account is a 409', async () => {
    users.length = 0
    seed({ id: 'other', email: 'taken@student.com' })
    const u = seed({ id: 'me' })
    const res = await requestEmailChange({ req: req(), user: u as any, newEmail: 'taken@student.com', purpose: 'LOGIN', password: 'pw123456' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(409)
  })

  test('a second request inside the 10-minute window is throttled', async () => {
    users.length = 0
    const u = seed({ emailVerificationSentAt: new Date(), emailVerificationExpiresAt: new Date(Date.now() + 3600_000) })
    const res = await requestEmailChange({ req: req(), user: u as any, newEmail: 'new@student.com', purpose: 'NOTIFICATION' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(429)
  })

  test('an admin may start a LOGIN change without the student password (confirmation still gates it)', async () => {
    users.length = 0
    const u = seed({})
    const res = await requestEmailChange({ req: req(), user: u as any, newEmail: 'new@student.com', purpose: 'LOGIN', requestedBy: { id: 'admin1', name: 'المدير' } })
    expect(res.ok).toBe(true)
    expect(u.email).toBe('old@student.com')
    expect(audits.some((a) => a.action === 'EMAIL_CHANGE_REQUESTED')).toBe(true)
  })
})

describe('applyPendingEmailChange (verify-email confirmation)', () => {
  test('LOGIN: swaps the login email, marks verified, clears the pending state', async () => {
    users.length = 0
    const u = seed({ pendingEmail: 'new@student.com', pendingEmailPurpose: 'LOGIN', emailVerifiedAt: null })
    const out = await applyPendingEmailChange(u as any)
    expect(out.outcome).toBe('LOGIN_APPLIED')
    expect(u.email).toBe('new@student.com')
    expect(!!u.emailVerifiedAt).toBe(true)
    expect(u.pendingEmail).toBeNull()
  })

  test('LOGIN: an address taken in the meantime aborts the swap and clears the pending state', async () => {
    users.length = 0
    seed({ id: 'squatter', email: 'new@student.com' })
    const u = seed({ id: 'me', pendingEmail: 'new@student.com', pendingEmailPurpose: 'LOGIN' })
    const out = await applyPendingEmailChange(u as any)
    expect(out.outcome).toBe('EMAIL_TAKEN')
    expect(u.email).toBe('old@student.com')
    expect(u.pendingEmail).toBeNull()
  })

  test('NOTIFICATION: sets the delivery address and leaves the login email untouched', async () => {
    users.length = 0
    const u = seed({ pendingEmail: 'inbox@student.com', pendingEmailPurpose: 'NOTIFICATION' })
    const out = await applyPendingEmailChange(u as any)
    expect(out.outcome).toBe('NOTIFICATION_APPLIED')
    expect(u.notificationEmail).toBe('inbox@student.com')
    expect(u.email).toBe('old@student.com')
  })
})

describe('routes', () => {
  test('student route: 401 without a session; a signed-in GOOGLE student can request a notification email', async () => {
    users.length = 0
    sessionUser = null
    const anon = await studentPost(new NextRequest('https://example.test/api/auth/email-change', { method: 'POST', body: JSON.stringify({ newEmail: 'x@y.com', purpose: 'NOTIFICATION' }) }))
    expect(anon.status).toBe(401)

    const u = seed({ authProvider: 'GOOGLE' })
    sessionUser = u
    const ok = await studentPost(new NextRequest('https://example.test/api/auth/email-change', { method: 'POST', body: JSON.stringify({ newEmail: 'inbox@student.com', purpose: 'NOTIFICATION' }) }))
    expect(ok.status).toBe(200)
    expect(u.pendingEmail).toBe('inbox@student.com')
  })

  test('admin route: refuses to touch another admin account', async () => {
    users.length = 0
    const target = seed({ id: 'boss', role: 'ADMIN', email: 'boss@aact.com' })
    sessionUser = seed({ id: 'admin1', role: 'ADMIN', email: 'admin@aact.com' })
    const res = await adminPost(new NextRequest('https://example.test/api/admin/students/email-change', { method: 'POST', body: JSON.stringify({ userId: target.id, newEmail: 'new@aact.com', purpose: 'NOTIFICATION' }) }))
    expect(res.status).toBe(400)
  })

  test('verify-email route: a token carrying a LOGIN pending change redirects as verified with the NEW email', async () => {
    users.length = 0
    const token = 'a'.repeat(43)
    seed({ pendingEmail: 'new@student.com', pendingEmailPurpose: 'LOGIN', emailVerificationTokenHash: hashEmailVerificationToken(token), emailVerificationExpiresAt: new Date(Date.now() + 3600_000) })
    const res = await verifyGet(new NextRequest(`https://example.test/api/auth/verify-email?token=${token}`))
    expect(res.status).toBe(307)
    const loc = res.headers.get('location') || ''
    expect(loc).toContain('email_verified=1')
    expect(loc).toContain('email=new%40student.com')
    expect(users[0].email).toBe('new@student.com')
  })

  test('verify-email route: a NOTIFICATION confirmation redirects with notification_email=1 and keeps the session', async () => {
    users.length = 0
    const token = 'b'.repeat(43)
    seed({ pendingEmail: 'inbox@student.com', pendingEmailPurpose: 'NOTIFICATION', emailVerificationTokenHash: hashEmailVerificationToken(token), emailVerificationExpiresAt: new Date(Date.now() + 3600_000) })
    const res = await verifyGet(new NextRequest(`https://example.test/api/auth/verify-email?token=${token}`))
    const loc = res.headers.get('location') || ''
    expect(loc).toContain('notification_email=1')
    expect(users[0].notificationEmail).toBe('inbox@student.com')
    expect(users[0].email).toBe('old@student.com')
    expect(res.headers.get('set-cookie') || '').not.toContain('aact_session=;')
  })
})
