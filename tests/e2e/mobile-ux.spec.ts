import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function login(page: Page, email: string, password: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } })
  const body = await response.json().catch(() => ({}))
  expect(response.ok(), `Login failed for ${email}: ${response.status()} ${JSON.stringify(body).slice(0, 900)}`).toBeTruthy()
  expect(body.token, 'Login response must include token').toBeTruthy()
  return { token: String(body.token), user: body.user }
}

async function setBrowserToken(page: Page, token: string) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.evaluate((t) => {
    localStorage.setItem('aact_token', t)
    localStorage.setItem('aact_startup_seen_v2', '1')
    sessionStorage.setItem('aact_skip_startup', '1')
  }, token)
}

async function createFullJourneyStudent(page: Page, adminToken: string) {
  const setupRes = await page.request.post('/api/admin/full-journey', {
    headers: { Authorization: `Bearer ${adminToken}` },
    timeout: 90_000,
  })
  const setup = await setupRes.json().catch(() => ({}))
  expect(setupRes.ok(), `Full journey setup failed: ${setupRes.status()} ${JSON.stringify(setup).slice(0, 1200)}`).toBeTruthy()
  expect(setup.ok, `Full journey setup returned non-ok: ${JSON.stringify(setup.steps || setup).slice(0, 1200)}`).toBe(true)
  return setup
}

async function assertNoPageHorizontalOverflow(page: Page, label: string) {
  const width = await page.evaluate(() => ({
    inner: window.innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(Math.max(width.doc, width.body), `${label} has horizontal page overflow: ${JSON.stringify(width)}`).toBeLessThanOrEqual(width.inner + 4)
}

async function collectMobileMetric(page: Page, path: string) {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
  await assertNoPageHorizontalOverflow(page, path)
  return page.evaluate(() => {
    const header = document.querySelector('header')?.getBoundingClientRect()
    const floating = document.querySelector('[aria-label="افتح وكيل واتساب الذكي للأكاديمية"]')?.getBoundingClientRect()
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      headerHeight: Math.round(header?.height || 0),
      floatingBottom: Math.round(window.innerHeight - (floating?.bottom || 0)),
    }
  })
}

function md(report: any) {
  const rows = report.checks.map((c: any) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${String(c.detail || '').replace(/\|/g, '/')} |`).join('\n')
  return `# AACT Mobile UX Guardrails Report\n\nGenerated: ${new Date().toISOString()}\n\nViewport: 390x844\n\n| Check | Result | Detail |\n|---|---|---|\n${rows}\n`
}

test.describe('AACT mobile UX guardrails suite', () => {
  test.setTimeout(180_000)

  test('mobile layout avoids overflow, cramped tabs, unsafe floating buttons, and tall menus', async ({ page }, testInfo: TestInfo) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = []

    for (const path of ['/', '/programs', '/apply', '/verify']) {
      const metric = await collectMobileMetric(page, path)
      expect(metric.headerHeight, `${path} mobile header is too tall`).toBeLessThanOrEqual(72)
      expect(metric.floatingBottom, `${path} floating WhatsApp button ignores safe area`).toBeGreaterThanOrEqual(8)
      checks.push({ name: `لا يوجد تمدد أفقي في ${path}`, ok: true, detail: `header=${metric.headerHeight}px floatingBottom=${metric.floatingBottom}px` })
    }

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.getByLabel('القائمة').click()
    const menu = page.locator('header').getByText('القائمة الرئيسية').locator('..').locator('..')
    await expect(page.getByText('القائمة الرئيسية')).toBeVisible()
    const menuBox = await menu.boundingBox()
    expect(menuBox?.height || 0, `Mobile menu should fit within viewport: ${JSON.stringify(menuBox)}`).toBeLessThanOrEqual(780)
    await assertNoPageHorizontalOverflow(page, 'mobile-menu')
    checks.push({ name: 'القائمة الهاتفية قابلة للتمرير ولا تتجاوز ارتفاع الشاشة', ok: true, detail: `${Math.round(menuBox?.height || 0)}px` })

    await page.getByLabel(/افتح وكيل واتساب الذكي/).click()
    await expect(page.getByText('وكيل واتساب الذكي').first()).toBeVisible()
    const chatBox = await page.getByText('وكيل واتساب الذكي').first().locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]').boundingBox()
    expect(chatBox?.width || 0, `WhatsApp assistant popup is wider than mobile viewport: ${JSON.stringify(chatBox)}`).toBeLessThanOrEqual(390)
    expect(chatBox?.height || 0, `WhatsApp assistant popup is too tall: ${JSON.stringify(chatBox)}`).toBeLessThanOrEqual(700)
    checks.push({ name: 'نافذة وكيل واتساب مناسبة للهاتف ولا تغطي الشاشة كاملة', ok: true, detail: `${Math.round(chatBox?.width || 0)}x${Math.round(chatBox?.height || 0)}px` })

    const adminLogin = await login(page, requiredEnv('E2E_ADMIN_EMAIL'), requiredEnv('E2E_ADMIN_PASSWORD'))
    const setup = await createFullJourneyStudent(page, adminLogin.token)
    const studentLogin = await login(page, setup.student.email, setup.student.password)
    await setBrowserToken(page, studentLogin.token)
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
    await assertNoPageHorizontalOverflow(page, 'student-dashboard')
    const programsTab = page.getByRole('tab', { name: /برامجي/ })
    await expect(programsTab).toBeVisible()
    await expect(programsTab).toHaveAttribute('data-state', 'active')
    await page.getByRole('button', { name: /المحتوى والواجبات/ }).click()
    await expect(page.getByRole('tab', { name: /أدلة الدراسة/ })).toBeVisible()
    const visibleTabs = await page.getByRole('tab').evaluateAll((tabs) => tabs.filter((t) => (t as HTMLElement).offsetParent !== null).map((t) => {
      const box = (t as HTMLElement).getBoundingClientRect()
      return { text: (t.textContent || '').trim(), width: Math.round(box.width), height: Math.round(box.height) }
    }))
    expect(visibleTabs.every((t) => t.height >= 32), `Mobile tabs are too cramped: ${JSON.stringify(visibleTabs)}`).toBeTruthy()
    checks.push({ name: 'تبويبات بوابة الطالب قابلة للقراءة والضغط على الهاتف', ok: true, detail: visibleTabs.map((t) => `${t.text}:${t.width}x${t.height}`).join(' / ') })

    await page.getByRole('tab', { name: /الدفعات/ }).click()
    await expect(page.getByText(/قواعد فتح الاختبارات حسب السداد/)).toBeVisible()
    await assertNoPageHorizontalOverflow(page, 'student-payments')
    checks.push({ name: 'تبويب الدفعات لا يسبب تمدداً أفقياً على الهاتف', ok: true })

    const report = { generatedAt: new Date().toISOString(), checks }
    await mkdir('test-results/mobile-ux', { recursive: true }).catch(() => {})
    const jsonPath = 'test-results/mobile-ux/report.json'
    const mdPath = 'test-results/mobile-ux/report.md'
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
    await writeFile(mdPath, md(report), 'utf8')
    await testInfo.attach('mobile-ux-report-json', { path: jsonPath, contentType: 'application/json' })
    await testInfo.attach('mobile-ux-report-md', { path: mdPath, contentType: 'text/markdown' })
  })
})
