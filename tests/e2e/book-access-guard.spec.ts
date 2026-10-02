import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type TestInfo } from '@playwright/test'

function requiredAnyEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw new Error(`Missing required environment variable. Expected one of: ${names.join(', ')}`)
}

function safeSnippet(value: unknown, maxLength = 900) {
  return JSON.stringify(value, (_key, item) => {
    if (_key.toLowerCase().includes('password')) return '[redacted]'
    if (_key.toLowerCase().includes('token')) return '[redacted]'
    return item
  }).slice(0, maxLength)
}

async function login(request: APIRequestContext, email: string, password: string) {
  const response = await request.post('/api/auth/login', { data: { email, password } })
  const body = await response.json().catch(() => ({}))
  expect(response.ok(), `Login failed for ${email}: ${response.status()} ${safeSnippet(body, 700)}`).toBeTruthy()
  expect(body.token, 'Login response must include token').toBeTruthy()
  return { token: String(body.token), user: body.user }
}

async function loginAsAdmin(request: APIRequestContext) {
  return login(request, requiredAnyEnv(['ADMIN_EMAIL', 'E2E_ADMIN_EMAIL']), requiredAnyEnv(['ADMIN_PASSWORD', 'E2E_ADMIN_PASSWORD']))
}

async function createJourneyFixture(request: APIRequestContext, adminToken: string) {
  const response = await request.post('/api/admin/full-journey', {
    headers: { Authorization: `Bearer ${adminToken}` },
    timeout: 90_000,
  })
  const body = await response.json().catch(() => ({}))
  expect(response.ok(), `Full journey fixture setup failed: ${response.status()} ${safeSnippet(body, 1200)}`).toBeTruthy()
  expect(body.ok, `Full journey fixture returned non-ok: ${safeSnippet(body.steps || body, 1200)}`).toBe(true)
  expect(body.student?.email, 'Fixture must include a student email').toBeTruthy()
  expect(body.student?.password, 'Fixture must include a student password').toBeTruthy()
  expect(body.program?.id, 'Fixture must include a program id').toBeTruthy()
  return body
}

async function createLinkedBook(request: APIRequestContext, adminToken: string, programId: string, suffix: string) {
  const response = await request.post('/api/admin/books', {
    headers: { Authorization: `Bearer ${adminToken}` },
    multipart: {
      programId,
      title: `QA كتاب رابط اختبار صلاحيات الكتب ${suffix}`,
      titleEn: `QA Book Access Guard ${suffix}`,
      author: 'AACT QA Guard',
      year: String(new Date().getFullYear()),
      semester: '1',
      link: `https://books.google.com/books?q=AACT+QA+Book+Access+Guard+${encodeURIComponent(suffix)}`,
      description: 'كتاب رابط اختباري لاختبار أن تحميل الكتب يمر عبر فحص تسجيل الطالب في البرنامج.',
    },
    timeout: 45_000,
  })
  const body = await response.json().catch(() => ({}))
  expect(response.ok(), `Linked book setup failed: ${response.status()} ${safeSnippet(body, 1000)}`).toBeTruthy()
  expect(body.book?.id, 'Linked book setup must return a book id').toBeTruthy()
  return body.book
}

type CleanupResult = Awaited<ReturnType<typeof cleanupFixture>> & { stamp: string }

async function cleanupFixture(request: APIRequestContext, adminToken: string, stamp: string) {
  const response = await request.delete('/api/admin/full-journey', {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { stamp },
    timeout: 45_000,
  })
  const body = await response.json().catch(() => ({}))
  return { status: response.status(), ok: response.ok() && body?.ok === true, body }
}

test.describe('Book access guard', () => {
  test.setTimeout(240_000)

  let adminToken = ''
  const cleanupStamps: string[] = []

  test.afterEach(async ({ request }, testInfo: TestInfo) => {
    if (!adminToken || cleanupStamps.length === 0) return
    const results: CleanupResult[] = []
    while (cleanupStamps.length) {
      const stamp = cleanupStamps.pop()!
      results.push({ stamp, ...(await cleanupFixture(request, adminToken, stamp)) })
    }
    await mkdir('test-results/book-access-guard', { recursive: true }).catch(() => {})
    const cleanupPath = 'test-results/book-access-guard/cleanup.json'
    await writeFile(cleanupPath, JSON.stringify(results, null, 2), 'utf8')
    await testInfo.attach('book-access-cleanup-json', { path: cleanupPath, contentType: 'application/json' })
    const failedCleanup = results.find((r) => !r.ok)
    if (failedCleanup && testInfo.status !== 'failed') {
      throw new Error(`Book access cleanup failed: ${safeSnippet(failedCleanup, 1000)}`)
    }
  })

  test('students can only open books for their enrolled program and legacy file route redirects to the safe download gate', async ({ request }, testInfo: TestInfo) => {
    const admin = await loginAsAdmin(request)
    adminToken = admin.token

    const allowedFixture = await createJourneyFixture(request, adminToken)
    cleanupStamps.push(String(allowedFixture.stamp))

    // The full journey fixture stamp has second precision; wait before creating a second fixture to avoid slug/email collisions.
    await new Promise((resolve) => setTimeout(resolve, 1100))

    const forbiddenFixture = await createJourneyFixture(request, adminToken)
    cleanupStamps.push(String(forbiddenFixture.stamp))

    const allowedBook = await createLinkedBook(request, adminToken, allowedFixture.program.id, `${allowedFixture.stamp}-allowed`)
    const forbiddenBook = await createLinkedBook(request, adminToken, forbiddenFixture.program.id, `${forbiddenFixture.stamp}-forbidden`)
    const student = await login(request, allowedFixture.student.email, allowedFixture.student.password)

    const adminAllowed = await request.get(`/api/books/${allowedBook.id}/download`, {
      headers: { Authorization: `Bearer ${adminToken}` },
      maxRedirects: 0,
    })
    expect([200, 302], `Admin should be able to open allowed-program book. Status=${adminAllowed.status()}`).toContain(adminAllowed.status())

    const studentAllowed = await request.get(`/api/books/${allowedBook.id}/download`, {
      headers: { Authorization: `Bearer ${student.token}` },
      maxRedirects: 0,
    })
    expect([200, 302], `Student should be able to open enrolled-program book. Status=${studentAllowed.status()}`).toContain(studentAllowed.status())

    const studentForbidden = await request.get(`/api/books/${forbiddenBook.id}/download`, {
      headers: { Authorization: `Bearer ${student.token}` },
      maxRedirects: 0,
    })
    const forbiddenBody = await studentForbidden.json().catch(() => ({}))
    expect(studentForbidden.status(), `Student must not open another program's book: ${safeSnippet(forbiddenBody, 700)}`).toBe(403)

    const legacyAllowed = await request.get(`/api/books/${allowedBook.id}/file`, {
      headers: { Authorization: `Bearer ${student.token}` },
      maxRedirects: 0,
    })
    const legacyLocation = legacyAllowed.headers()['location'] || ''
    expect(legacyAllowed.status(), `Legacy /file route should redirect, not serve the file directly. Location=${legacyLocation}`).toBe(307)
    expect(legacyLocation.includes(`/api/books/${allowedBook.id}/download`), `Legacy /file route must point to safe /download gate. Location=${legacyLocation}`).toBeTruthy()

    const report = {
      generatedAt: new Date().toISOString(),
      allowedProgram: allowedFixture.program,
      forbiddenProgram: forbiddenFixture.program,
      allowedBook: { id: allowedBook.id, title: allowedBook.title },
      forbiddenBook: { id: forbiddenBook.id, title: forbiddenBook.title },
      checks: {
        adminAllowedStatus: adminAllowed.status(),
        studentAllowedStatus: studentAllowed.status(),
        studentForbiddenStatus: studentForbidden.status(),
        legacyAllowedStatus: legacyAllowed.status(),
        legacyLocation,
      },
    }

    await mkdir('test-results/book-access-guard', { recursive: true }).catch(() => {})
    const reportPath = 'test-results/book-access-guard/report.json'
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8')
    await testInfo.attach('book-access-guard-report-json', { path: reportPath, contentType: 'application/json' })
  })
})
