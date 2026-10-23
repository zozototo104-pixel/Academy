import { expect, test, type Page } from '@playwright/test'

// Read-only QA scenario. Requires at least two EXISTING representatives.
// Never create, save, upload, review or delete representative records in this spec.
// Destination isolation mirrors tests/e2e/agents-table.spec.ts: explicit QA origin,
// production rejection, QA allowlist, zero redirect following for login, and checked
// browser navigation hops before handing the response to the browser.
const PRODUCTION_HOSTS = ['academy-raqaba.vercel.app', 'www.aactacademy.com', 'aactacademy.com']
const normalizeHost = (host: string) => host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '')
let QA_ORIGIN = ''

function assertQaEnvironment(): string {
  const raw = process.env.E2E_BASE_URL?.trim()
  if (!raw) throw new Error('E2E_BASE_URL must be set explicitly to a QA environment. The default may be production.')
  const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
  const host = normalizeHost(url.hostname)
  if (PRODUCTION_HOSTS.map(normalizeHost).includes(host)) throw new Error(`Production domain prohibited for this spec: ${host}`)
  const allowlist = (process.env.E2E_QA_HOSTS || '').split(',').map(normalizeHost).filter(Boolean)
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (!isLocal && !allowlist.includes(host)) throw new Error(`QA host ${host} is not present in E2E_QA_HOSTS`)
  return url.origin
}

function requiredEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw new Error(`Required admin test credential missing: ${names.join(' / ')}`)
}

async function loginAsAdmin(page: Page) {
  const email = requiredEnv(['ADMIN_EMAIL', 'E2E_ADMIN_EMAIL'])
  const password = requiredEnv(['ADMIN_PASSWORD', 'E2E_ADMIN_PASSWORD'])
  const response = await page.request.post('/api/auth/login', {
    data: { email, password },
    maxRedirects: 0,
  })
  const body = await response.json().catch(() => ({}))
  expect(response.ok(), `Admin login failed: ${response.status()} ${JSON.stringify(body)}`).toBeTruthy()
  expect(body?.token, 'Login must return a session token').toBeTruthy()
  expect(body?.user?.role, 'The QA account must be ADMIN').toBe('ADMIN')
  await page.addInitScript((arg: { token: string; origin: string }) => {
    if (window.location.origin !== arg.origin) return
    localStorage.setItem('aact_token', arg.token)
    localStorage.setItem('aact_startup_seen_v2', '1')
    sessionStorage.setItem('aact_skip_startup', '1')
  }, { token: String(body.token), origin: QA_ORIGIN })
}

async function protectQaNavigation(page: Page, reportBlockedWrite: (attempt: string) => void) {
  await page.route('**/*', async (route) => {
    const req = route.request()
    if (!req.isNavigationRequest()) {
      const url = new URL(req.url())
      if (/^\/api\/admin\/representatives(?:\/|$)/.test(url.pathname) && !['GET', 'HEAD'].includes(req.method())) {
        reportBlockedWrite(`${req.method()} ${url.pathname}`)
        await route.abort()
        return
      }
      await route.continue()
      return
    }
    let url = req.url()
    let prevStatus = 0
    for (let hop = 0; hop < 10; hop++) {
      let origin = ''
      try { origin = new URL(url).origin } catch { origin = '' }
      if (!origin || origin !== QA_ORIGIN) { await route.abort(); return }
      // page.route does not intercept the subsequent redirect hops; fetch and check each one.
      const preserveMethod = hop > 0 && (prevStatus === 307 || prevStatus === 308) && req.method() !== 'GET'
      const response = hop === 0
        ? await route.fetch({ maxRedirects: 0 })
        : preserveMethod
          ? await route.fetch({ url, method: req.method(), postData: req.postData() ?? undefined, maxRedirects: 0 })
          : await route.fetch({ url, method: 'GET', maxRedirects: 0 })
      const status = response.status()
      const location = response.headers()['location']
      if (status >= 300 && status < 400 && location) {
        prevStatus = status
        url = new URL(location, url).toString()
        await response.dispose()
        continue
      }
      await route.fulfill({ response })
      return
    }
    await route.abort()
  })
}

async function openRepresentatives(page: Page, reportBlockedWrite: (attempt: string) => void) {
  await loginAsAdmin(page)
  await protectQaNavigation(page, reportBlockedWrite)
  await page.goto('/admin', { waitUntil: 'domcontentloaded' })
  expect(new URL(page.url()).origin, 'Navigation must remain within the explicitly permitted QA origin').toBe(QA_ORIGIN)
  await page.locator('.aact-startup-screen').waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {})
  await page.getByText('LOADING MODULE').waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {})
  await expect(page.getByRole('heading', { name: /لوحة إدارة الأكاديمية/ })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: 'ممثلو الدول' }).click()
  await expect(page.getByTestId('representatives-workspace')).toBeVisible({ timeout: 30_000 })
}

const workspace = (page: Page) => page.getByTestId('representatives-workspace')
const heading = (page: Page, key: string) => workspace(page).locator(`#representatives-heading-${key}`)
const panel = (page: Page, key: string) => workspace(page).getByTestId(`representatives-panel-${key}`)
const directory = (page: Page) => page.getByPlaceholder('ابحث بالاسم أو الدولة أو التخصص...').locator('xpath=../following-sibling::div[1]')
const rows = (page: Page) => directory(page).locator(':scope > button')
const nameField = (page: Page) => panel(page, 'basic').locator('input').first()
const bioField = (page: Page) => panel(page, 'bio').locator('textarea').first()

test.describe('representatives accordion — QA read-only', () => {
  test.beforeAll(() => { QA_ORIGIN = assertQaEnvironment() })
  let blockedWrites: string[] = []

  test.beforeEach(async ({ page }) => {
    blockedWrites = []
    await openRepresentatives(page, (attempt) => blockedWrites.push(attempt))
  })

  test.afterEach(() => {
    expect(blockedWrites, 'The read-only UI spec must never attempt a representative write').toEqual([])
  })

  test('only basic is open initially; opening uploads closes basic', async ({ page }) => {
    for (const key of ['basic', 'bio', 'uploads', 'onboarding']) {
      await expect(heading(page, key)).toHaveAttribute('aria-expanded', key === 'basic' ? 'true' : 'false')
      if (key === 'basic') await expect(panel(page, key)).toBeVisible()
      else await expect(panel(page, key)).toBeHidden()
    }
    await heading(page, 'uploads').click()
    await expect(panel(page, 'uploads')).toBeVisible()
    for (const key of ['basic', 'bio', 'onboarding']) await expect(panel(page, key)).toBeHidden()
    await heading(page, 'uploads').click()
    await expect(panel(page, 'uploads')).toBeVisible() // Always one section open.
  })

  test('unsaved bio survives folding; selecting a second person restores that person data', async ({ page }) => {
    await expect.poll(() => rows(page).count(), { message: 'QA fixture requires two distinct existing representatives' }).toBeGreaterThanOrEqual(2)
    const firstName = (await rows(page).nth(0).locator('p').first().innerText()).trim()
    const secondName = (await rows(page).nth(1).locator('p').first().innerText()).trim()
    expect(firstName).not.toBe(secondName)

    await rows(page).nth(1).click()
    await heading(page, 'bio').click()
    await expect(nameField(page)).toHaveValue(secondName)
    const storedBio = await bioField(page).inputValue()

    await rows(page).nth(0).click()
    await expect(heading(page, 'bio')).toHaveAttribute('aria-expanded', 'true')
    await expect(nameField(page)).toHaveValue(firstName)
    const draft = `unsaved QA bio ${Date.now()}`
    await bioField(page).fill(draft)
    await heading(page, 'uploads').click()
    await expect(panel(page, 'bio')).toBeHidden()
    await heading(page, 'bio').click()
    await expect(bioField(page)).toHaveValue(draft)

    await rows(page).nth(1).click()
    await expect(heading(page, 'bio')).toHaveAttribute('aria-expanded', 'true')
    await expect(nameField(page)).toHaveValue(secondName)
    await expect(bioField(page)).toHaveValue(storedBio)
    await page.getByRole('button', { name: 'جديد', exact: true }).click()
    await expect(heading(page, 'bio')).toHaveAttribute('aria-expanded', 'true')
    await expect(nameField(page)).toHaveValue('')
  })
})
