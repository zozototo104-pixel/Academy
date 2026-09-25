import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'

const ROUTE_REPORT_DIR = 'test-results/platform-routes'

const ROUTE_LIMIT = Number(process.env.ROUTE_SMOKE_LIMIT || 80)
const DISCOVERY_LIMIT = Number(process.env.ROUTE_SMOKE_DISCOVERY_LIMIT || 50)

function requiredAnyEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw new Error(`Missing required environment variable. Expected one of: ${names.join(', ')}`)
}

function unique<T>(items: T[]) {
  return [...new Set(items)]
}

function normalizePath(raw: string) {
  try {
    const url = new URL(raw, 'https://local.test')
    let path = url.pathname || '/'
    path = path.replace(/\/+/g, '/')
    if (path.length > 1) path = path.replace(/\/$/, '')
    return path + url.search
  } catch {
    return raw.startsWith('/') ? raw : `/${raw}`
  }
}

function isInternalUiPath(path: string) {
  if (!path.startsWith('/')) return false
  if (path.startsWith('/api/')) return false
  if (path.startsWith('/_next/')) return false
  if (path.startsWith('/static/')) return false
  if (path.startsWith('/favicon')) return false
  if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|map|pdf|zip|webm|mp4|woff2?)($|\?)/i.test(path)) return false
  return true
}

async function loginAsAdmin(page: Page) {
  const email = requiredAnyEnv(['ADMIN_EMAIL', 'E2E_ADMIN_EMAIL'])
  const password = requiredAnyEnv(['ADMIN_PASSWORD', 'E2E_ADMIN_PASSWORD'])
  const response = await page.request.post('/api/auth/login', { data: { email, password } })
  const rawBody = await response.text().catch(() => '')
  let body: any = {}
  try { body = rawBody ? JSON.parse(rawBody) : {} } catch { body = { raw: rawBody.slice(0, 2500) } }

  if (!response.ok()) {
    await mkdir(ROUTE_REPORT_DIR, { recursive: true }).catch(() => {})
    await writeFile(`${ROUTE_REPORT_DIR}/admin-login-failure.json`, JSON.stringify({
      status: response.status(),
      headers: response.headers(),
      body,
      rawBody: rawBody.slice(0, 5000),
    }, null, 2), 'utf8')
  }

  expect(response.ok(), `Admin API login failed with ${response.status()}: ${JSON.stringify(body).slice(0, 2000)}`).toBeTruthy()
  expect(body?.token, 'Login response must include token').toBeTruthy()
  expect(body?.user?.role, 'Route smoke account must be ADMIN').toBe('ADMIN')

  await page.addInitScript((token: string) => {
    window.localStorage.setItem('aact_token', token)
  }, body.token)
  return body.token as string
}

async function collectLinks(page: Page) {
  const hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).getAttribute('href') || ''))
  return unique(hrefs.map(normalizePath).filter(isInternalUiPath))
}

async function checkPage(page: Page, path: string, authenticated: boolean) {
  const errors: string[] = []
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  const consoleListener = (msg: any) => {
    if (msg.type?.() === 'error') {
      const text = String(msg.text?.() || '')
      if (!/favicon|ResizeObserver loop|Failed to load resource: the server responded with a status of 404/i.test(text)) {
        consoleErrors.push(text)
      }
    }
  }
  const pageErrorListener = (err: Error) => pageErrors.push(err.message)

  page.on('console', consoleListener)
  page.on('pageerror', pageErrorListener)

  let status = 0
  let finalUrl = ''
  let title = ''
  let bodyStart = ''
  try {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    status = response?.status() || 0
    finalUrl = page.url()
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
    title = await page.title().catch(() => '')
    bodyStart = (await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')).slice(0, 1200)

    const nextError = await page.locator('#__next_error__, text=/Internal Server Error|Application error|Unhandled Runtime Error|500:/i').count().catch(() => 0)
    if (status >= 500 || status === 0) errors.push(`HTTP status ${status}`)
    if (nextError > 0) errors.push('Visible Next/React error page detected')
    if (/500:\s*Internal Server Error|Application error|Unhandled Runtime Error/i.test(`${title}\n${bodyStart}`)) errors.push('Error text detected in rendered page')
    if (consoleErrors.length) errors.push(`Console errors: ${consoleErrors.slice(0, 5).join(' | ')}`)
    if (pageErrors.length) errors.push(`Page errors: ${pageErrors.slice(0, 5).join(' | ')}`)
  } catch (e: any) {
    errors.push(`Navigation failed: ${e?.message || e}`)
  } finally {
    page.off('console', consoleListener)
    page.off('pageerror', pageErrorListener)
  }

  return { path, authenticated, status, finalUrl, title, errors, bodyStart: errors.length ? bodyStart : undefined }
}

test.describe('Platform route smoke coverage', () => {
  test.setTimeout(180_000)

  test('public, protected, and discovered pages do not crash', async ({ page }, testInfo: TestInfo) => {
    const publicSeeds = [
      '/',
      '/admin',
      '/dashboard',
      '/apply',
      '/verify',
      '/verify/certificates',
      '/programs',
      '/services',
      '/contact',
      '/login',
      '/register',
      '/privacy',
      '/terms',
    ]

    const protectedSeeds = [
      '/admin',
      '/dashboard',
      '/dashboard?tab=payments',
      '/dashboard?tab=programs',
      '/dashboard?tab=notifications',
      '/dashboard?tab=transcript',
      '/dashboard?tab=certs',
      '/verify',
    ]

    const results: Awaited<ReturnType<typeof checkPage>>[] = []
    const discovered = new Set<string>()

    for (const path of publicSeeds) {
      const result = await checkPage(page, path, false)
      results.push(result)
      if (!result.errors.length) {
        for (const link of await collectLinks(page)) discovered.add(link)
      }
    }

    const publicDiscovered = [...discovered].filter((p) => !protectedSeeds.includes(p)).slice(0, DISCOVERY_LIMIT)
    for (const path of publicDiscovered) {
      if (results.length >= ROUTE_LIMIT) break
      results.push(await checkPage(page, path, false))
    }

    await loginAsAdmin(page)
    for (const path of protectedSeeds) {
      if (results.length >= ROUTE_LIMIT) break
      const result = await checkPage(page, path, true)
      results.push(result)
      if (!result.errors.length) {
        for (const link of await collectLinks(page)) discovered.add(link)
      }
    }

    const authenticatedDiscovered = [...discovered].filter((p) => !results.some((r) => r.path === p)).slice(0, Math.max(0, ROUTE_LIMIT - results.length))
    for (const path of authenticatedDiscovered) {
      if (results.length >= ROUTE_LIMIT) break
      results.push(await checkPage(page, path, true))
    }

    await mkdir('test-results/platform-routes', { recursive: true }).catch(() => {})
    const reportPath = 'test-results/platform-routes/routes.json'
    await writeFile(reportPath, JSON.stringify({ checkedAt: new Date().toISOString(), total: results.length, results }, null, 2), 'utf8')
    await testInfo.attach('platform-route-smoke-json', { path: reportPath, contentType: 'application/json' })

    const failures = results.filter((r) => r.errors.length)
    expect(failures, `Route smoke failures:\n${JSON.stringify(failures, null, 2).slice(0, 6000)}`).toHaveLength(0)
  })
})
