/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { createHash, createHmac } from 'node:crypto'

type FakeUser = {
  id: string
  email: string
  name: string
  role: string
  status: string
  emailVerifiedAt?: Date | null
  emailVerificationTokenHash?: string | null
  emailVerificationExpiresAt?: Date | null
  emailVerificationSentAt?: Date | null
}
type FakeSession = { id: string; token: string; userId: string; expiresAt: Date }

const users = new Map<string, FakeUser>()
const sessions = new Map<string, FakeSession>()
const cookieValues = new Map<string, string>()
const cookieOptions = new Map<string, Record<string, unknown>>()
let bearerToken: string | null = null
let nextSessionId = 0
let createdSessions = 0
let deletedSessions = 0
let updatedUsers = 0
let googleRequests = 0

function hashSessionToken(token: string) {
  return createHash('sha256').update(String(token || '')).digest('hex')
}

function sessionMatchesWhere(token: string, session: FakeSession, where: any): boolean {
  if (!where) return true
  if (Array.isArray(where.OR)) return where.OR.some((branch: any) => sessionMatchesWhere(token, session, branch))
  if (where.token && token !== where.token) return false
  if (where.id && session.id !== where.id) return false
  if (where.userId && session.userId !== where.userId) return false
  return true
}

const cookieJar = {
  get: (name: string) => cookieValues.has(name) ? { name, value: cookieValues.get(name)! } : undefined,
  set: (name: string, value: string, options?: Record<string, unknown>) => {
    cookieValues.set(name, value)
    cookieOptions.set(name, options || {})
  },
  delete: (name: string) => { cookieValues.delete(name) },
}

const db = {
  user: {
    findUnique: async ({ where }: { where: { id?: string; email?: string } }) =>
      [...users.values()].find((u) => (where.id ? u.id === where.id : u.email === where.email)) || null,
    findFirst: async ({ where }: { where: any }) =>
      [...users.values()].find((u) => {
        if (where.status && u.status !== where.status) return false
        if (where.emailVerificationTokenHash && u.emailVerificationTokenHash !== where.emailVerificationTokenHash) return false
        const gt = where.emailVerificationExpiresAt?.gt
        if (gt && (!u.emailVerificationExpiresAt || u.emailVerificationExpiresAt <= gt)) return false
        return true
      }) || null,
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const user = users.get(where.id)
      if (!user) throw new Error('USER_NOT_FOUND')
      updatedUsers++
      Object.assign(user, data)
      return user
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const user: FakeUser = {
        id: `google-${users.size + 1}`,
        email: String(data.email),
        name: String(data.name),
        role: String(data.role),
        status: 'ACTIVE',
        emailVerifiedAt: data.emailVerifiedAt as Date,
      }
      users.set(user.id, user)
      return user
    },
  },
  session: {
    create: async ({ data }: { data: { token: string; userId: string; expiresAt: Date } }) => {
      const session = { ...data, id: `session-${++nextSessionId}` }
      createdSessions++
      sessions.set(session.token, session)
      return session
    },
    findUnique: async ({ where }: { where: { token: string } }) => {
      const session = sessions.get(where.token)
      return session ? { ...session, user: users.get(session.userId) } : null
    },
    findFirst: async ({ where }: { where: any }) => {
      for (const [token, session] of sessions) {
        if (sessionMatchesWhere(token, session, where)) return { ...session, user: users.get(session.userId) }
      }
      return null
    },
    deleteMany: async ({ where }: { where: any }) => {
      let count = 0
      for (const [token, session] of sessions) {
        if (sessionMatchesWhere(token, session, where)) {
          sessions.delete(token)
          count++
        }
      }
      deletedSessions += count
      return { count }
    },
  },
  $transaction: async <T>(work: (transaction: { user: { update: typeof db.user.update }; session: { deleteMany: typeof db.session.deleteMany } }) => Promise<T>): Promise<T> => work(db),
}

// Import production routes only after replacing their database and request-context dependencies.
// No real database, Google account, or network connection is needed by these tests.
mock.module('@/lib/db', () => ({ db }))
mock.module('next/headers', () => ({
  cookies: async () => cookieJar,
  headers: async () => new Headers(bearerToken ? { authorization: `Bearer ${bearerToken}` } : {}),
}))
mock.module('@/lib/notify', () => ({ audit: async () => {} }))
mock.module('@/lib/mailer', () => ({ emailWelcome: async () => {} }))
const realRateLimit = await import('../../src/lib/rate-limit')
mock.module('@/lib/rate-limit', () => ({ ...realRateLimit, enforceApiRateLimit: () => null, enforceDatabaseApiRateLimit: async () => null, checkDatabaseRateLimit: async () => ({ ok: true, remaining: 99, resetAt: Date.now() + 60000, retryAfterSec: 0 }) }))
mock.module('@/lib/admin-query', () => ({
  adminPaginationMeta: () => ({}),
  parseAdminPagination: () => ({ page: 1, pageSize: 25, skip: 0, take: 25 }),
}))

const { createSession, getCurrentUser, requireAdmin } = await import('../../src/lib/auth')
const { PATCH: updateStudent } = await import('../../src/app/api/admin/students/route')
const { GET: startGoogle } = await import('../../src/app/api/auth/google/route')
const { GET: completeGoogle } = await import('../../src/app/api/auth/google/callback/route')
const { GET: verifyEmail } = await import('../../src/app/api/auth/verify-email/route')
const { hashEmailVerificationToken } = await import('../../src/lib/email-verification')
const originalFetch = globalThis.fetch
const previousAuthSecret = process.env.AUTH_SECRET
const previousGoogleClientId = process.env.GOOGLE_CLIENT_ID
const previousGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET
const previousNextPublicAppUrl = process.env.NEXT_PUBLIC_APP_URL

function seedUser(id: string, status = 'ACTIVE', role = 'STUDENT', email = `${id}@example.test`): FakeUser {
  const user = { id, email, name: id, role, status }
  users.set(id, user)
  return user
}

function seedSession(token: string, userId: string, expiresAt = new Date(Date.now() + 60_000)) {
  const session = { id: `seed-${token}`, token, userId, expiresAt }
  sessions.set(token, session)
  return session
}

function mockGoogleFetch(email = 'google@example.test') {
  const redirectUris: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    googleRequests++
    const url = String(input)
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body || ''))
      redirectUris.push(body.get('redirect_uri') || '')
      return Response.json({ access_token: 'fake-access-token' })
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
      return Response.json({ email, name: 'Google user', email_verified: true })
    }
    throw new Error(`Unexpected external request: ${url}`)
  }) as typeof fetch
  return redirectUris
}

async function beginGoogle(host: string) {
  const response = await startGoogle(new NextRequest(`https://${host}/api/auth/google`, {
    headers: { host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https' },
  }))
  expect(response.status).toBe(307)
  const url = new URL(response.headers.get('location')!)
  const state = url.searchParams.get('state')!
  expect(state).toBeTruthy()
  expect(cookieValues.get('aact_google_oauth_state')).toBe(state)
  expect(cookieOptions.get('aact_google_oauth_state')?.httpOnly).toBe(true)
  expect(cookieOptions.get('aact_google_oauth_state')?.sameSite).toBe('lax')
  return { state, redirectUri: url.searchParams.get('redirect_uri') }
}

function callbackRequest(host: string, state: string) {
  return new NextRequest(`https://${host}/api/auth/google/callback?code=fake-auth-code&state=${encodeURIComponent(state)}`, {
    headers: { host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https' },
  })
}

beforeEach(() => {
  users.clear()
  sessions.clear()
  cookieValues.clear()
  cookieOptions.clear()
  bearerToken = null
  nextSessionId = 0
  createdSessions = 0
  deletedSessions = 0
  updatedUsers = 0
  googleRequests = 0
  process.env.AUTH_SECRET = 'stage-b-test-only-secret'
  process.env.GOOGLE_CLIENT_ID = 'stage-b-test-only-client'
  process.env.GOOGLE_CLIENT_SECRET = 'stage-b-test-only-client-secret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://aactacademy.com'
})

afterEach(() => { globalThis.fetch = originalFetch })

describe('server-side session security', () => {
  test('active user gets an HttpOnly session and remains authenticated', async () => {
    seedUser('active')
    const token = await createSession('active')
    expect(sessions.has(token)).toBe(false)
    expect(sessions.has(hashSessionToken(token))).toBe(true)
    expect(cookieValues.get('aact_session')).toBe(token)
    expect(cookieOptions.get('aact_session')?.httpOnly).toBe(true)
    expect((await getCurrentUser())?.id).toBe('active')
  })

  for (const status of ['DISABLED', 'ARCHIVED']) {
    test(`${status} account cannot create a new session`, async () => {
      seedUser('inactive', status)
      await expect(createSession('inactive')).rejects.toThrow('ACCOUNT_DISABLED')
      expect(createdSessions).toBe(0)
    })
    test(`${status} account loses an existing session on the next request`, async () => {
      seedUser('inactive', status)
      seedSession('stale-token', 'inactive')
      bearerToken = 'stale-token'
      expect(await getCurrentUser()).toBeNull()
      expect(sessions.has('stale-token')).toBe(false)
      expect(deletedSessions).toBe(1)
    })
  }

  test('expired sessions are rejected and deleted, but active sessions are retained', async () => {
    seedUser('active')
    seedSession('expired', 'active', new Date(Date.now() - 60_000))
    bearerToken = 'expired'
    expect(await getCurrentUser()).toBeNull()
    expect(sessions.has('expired')).toBe(false)
    seedSession('valid', 'active')
    bearerToken = 'valid'
    expect((await getCurrentUser())?.id).toBe('active')
    expect(sessions.has('valid')).toBe(true)
  })

  for (const status of ['DISABLED', 'ARCHIVED']) {
    test(`admin ${status} operation revokes sessions on multiple devices atomically`, async () => {
      seedUser('admin', 'ACTIVE', 'ADMIN')
      seedUser('student')
      seedSession('admin-token', 'admin')
      seedSession('laptop', 'student')
      seedSession('mobile', 'student')
      bearerToken = 'admin-token'
      expect((await requireAdmin()).id).toBe('admin')
      const response = await updateStudent(new NextRequest('https://academy.example.test/api/admin/students', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'student', action: 'setStatus', status }),
      }))
      expect(response.status).toBe(200)
      expect(users.get('student')?.status).toBe(status)
      expect(sessions.has('laptop')).toBe(false)
      expect(sessions.has('mobile')).toBe(false)
      expect(sessions.has('admin-token')).toBe(true)
      expect(deletedSessions).toBe(2)
      bearerToken = 'laptop'
      expect(await getCurrentUser()).toBeNull()
    })
  }

  test('reactivating an account does not resurrect revoked sessions', async () => {
    seedUser('admin', 'ACTIVE', 'ADMIN')
    seedUser('student', 'DISABLED')
    seedSession('admin-token', 'admin')
    bearerToken = 'admin-token'
    const response = await updateStudent(new NextRequest('https://academy.example.test/api/admin/students', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'student', action: 'setStatus', status: 'ACTIVE' }),
    }))
    expect(response.status).toBe(200)
    expect(users.get('student')?.status).toBe('ACTIVE')
    expect(sessions.has('laptop')).toBe(false)
    expect(deletedSessions).toBe(0)
  })
})

describe('email verification redirects', () => {
  test('uses NEXT_PUBLIC_APP_URL even when request host is untrusted', async () => {
    const token = 'verify-token-abcdefghijklmnopqrstuvwxyz'
    const user = seedUser('verify-user', 'ACTIVE', 'STUDENT', 'verify@example.test')
    user.emailVerificationTokenHash = hashEmailVerificationToken(token)
    user.emailVerificationExpiresAt = new Date(Date.now() + 60_000)
    user.emailVerificationSentAt = new Date()

    const response = await verifyEmail(new NextRequest(`https://evil.example/api/auth/verify-email?token=${encodeURIComponent(token)}`, {
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' },
    }))

    expect(response.status).toBe(307)
    const location = response.headers.get('location')!
    expect(location).not.toContain('evil.example')
    const url = new URL(location)
    expect(url.origin).toBe('https://aactacademy.com')
    expect(url.searchParams.get('email_verified')).toBe('1')
    expect(url.searchParams.get('email')).toBe('verify@example.test')
    expect(users.get('verify-user')?.emailVerificationTokenHash).toBeNull()
  })
})

describe('Google OAuth callback', () => {
  test('a missing state cookie rejects callback before Google or database calls', async () => {
    const { state } = await beginGoogle('aactacademy.com')
    cookieJar.delete('aact_google_oauth_state')
    const response = await completeGoogle(callbackRequest('aactacademy.com', state))
    expect(new URL(response.headers.get('location')!).searchParams.get('oauth_error')).toBe('invalid_state')
    expect(googleRequests).toBe(0)
    expect(createdSessions).toBe(0)
  })

  test('a mismatched but signed state is rejected before fetching user information', async () => {
    await beginGoogle('aactacademy.com')
    const ts = Date.now()
    const nonce = 'different-browser'
    const signature = createHmac('sha256', process.env.AUTH_SECRET!).update(`${nonce}.${ts}`).digest('base64url')
    const response = await completeGoogle(callbackRequest('aactacademy.com', `${nonce}.${ts}.${signature}`))
    expect(new URL(response.headers.get('location')!).searchParams.get('oauth_error')).toBe('invalid_state')
    expect(googleRequests).toBe(0)
    expect(createdSessions).toBe(0)
  })

  test('expired state is rejected even with a matching cookie and valid signature', async () => {
    const ts = Date.now() - 11 * 60 * 1000
    const nonce = 'expired-nonce'
    const signature = createHmac('sha256', process.env.AUTH_SECRET!).update(`${nonce}.${ts}`).digest('base64url')
    const state = `${nonce}.${ts}.${signature}`
    cookieJar.set('aact_google_oauth_state', state)
    const response = await completeGoogle(callbackRequest('aactacademy.com', state))
    expect(new URL(response.headers.get('location')!).searchParams.get('oauth_error')).toBe('invalid_state')
    expect(googleRequests).toBe(0)
  })

  for (const host of ['aactacademy.com', 'www.aactacademy.com', 'evil.example']) {
    test(`Google callback on ${host} uses configured redirect URI and HttpOnly cookie`, async () => {
      seedUser('google-user', 'ACTIVE', 'STUDENT', 'google@example.test')
      const redirectUris = mockGoogleFetch()
      const { state, redirectUri } = await beginGoogle(host)
      expect(redirectUri).toBe('https://aactacademy.com/api/auth/google/callback')
      const response = await completeGoogle(callbackRequest(host, state))
      expect(response.status).toBe(200)
      expect(redirectUris).toEqual(['https://aactacademy.com/api/auth/google/callback'])
      const sessionToken = cookieValues.get('aact_session')!
      expect(sessionToken).toBeTruthy()
      expect(cookieOptions.get('aact_session')?.httpOnly).toBe(true)
      const html = await response.text()
      expect(html).not.toContain(sessionToken)
      expect((await getCurrentUser())?.id).toBe('google-user')
    })
  }

  test('disabled Google account is rejected without updating user or creating session', async () => {
    seedUser('disabled-google', 'DISABLED', 'STUDENT', 'google@example.test')
    mockGoogleFetch()
    const { state } = await beginGoogle('aactacademy.com')
    const response = await completeGoogle(callbackRequest('aactacademy.com', state))
    expect(new URL(response.headers.get('location')!).searchParams.get('oauth_error')).toBe('account_disabled')
    expect(updatedUsers).toBe(0)
    expect(createdSessions).toBe(0)
  })
})

// Restore environment variables after the test suite; no external credentials are ever used.
afterAll(() => {
  for (const [key, previous] of [
    ['AUTH_SECRET', previousAuthSecret],
    ['GOOGLE_CLIENT_ID', previousGoogleClientId],
    ['GOOGLE_CLIENT_SECRET', previousGoogleClientSecret],
    ['NEXT_PUBLIC_APP_URL', previousNextPublicAppUrl],
  ] as const) {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})
