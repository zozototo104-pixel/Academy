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
  // Cookie-based login: the raw session token arrives only as the
  // httpOnly aact_session cookie; it doubles as the bearer token.
  const sessionCookie = response.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value).join('; ')
  const sessionToken = decodeURIComponent(sessionCookie.match(/aact_session=([^;]+)/)?.[1] || '')
  expect(sessionToken, 'Login must set the aact_session session cookie').toBeTruthy()
  return { token: sessionToken, user: body.user }
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
  const width = await page.evaluate(() => {
    const inner = window.innerWidth
    const doc = document.documentElement.scrollWidth
    const body = document.body.scrollWidth
    const clippedByOverflowAncestor = (el: HTMLElement, rect: DOMRect) => {
      let parent = el.parentElement
      while (parent && parent !== document.body && parent !== document.documentElement) {
        const style = window.getComputedStyle(parent)
        const clipsX = ['hidden', 'clip'].includes(style.overflowX) || ['hidden', 'clip'].includes(style.overflow)
        if (clipsX) {
          const parentRect = parent.getBoundingClientRect()
          const childEscapesParent = rect.left < parentRect.left - 1 || rect.right > parentRect.right + 1 || rect.width > parentRect.width + 1
          const parentIsViewportSafe = parentRect.left >= -4 && parentRect.right <= inner + 4
          if (childEscapesParent && parentIsViewportSafe) return true
        }
        parent = parent.parentElement
      }
      return false
    }
    const offenders = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .map((el) => {
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        return {
          tag: el.tagName.toLowerCase(),
          className: String(el.className || '').slice(0, 160),
          text: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          position: style.position,
          display: style.display,
          visibility: style.visibility,
          opacity: Number.parseFloat(style.opacity || '1'),
          clipped: clippedByOverflowAncestor(el, rect),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        }
      })
      .filter((item) => item.display !== 'none' && item.visibility !== 'hidden' && item.opacity > 0.05 && item.height > 0 && item.width > 0)
      .filter((item) => !item.clipped)
      .filter((item) => item.position !== 'fixed' && (item.left < -4 || item.right > inner + 4 || item.width > inner + 4))
      .slice(0, 12)
    const previousX = window.scrollX
    window.scrollTo(9999, window.scrollY)
    const actualScrollX = window.scrollX
    window.scrollTo(previousX, window.scrollY)
    return { inner, doc, body, actualScrollX, offenders }
  })
  expect(width.doc, `${label} root has horizontal page overflow: ${JSON.stringify(width)}`).toBeLessThanOrEqual(width.inner + 4)
  expect(width.actualScrollX, `${label} can actually scroll horizontally: ${JSON.stringify(width)}`).toBeLessThanOrEqual(1)
  expect(width.offenders, `${label} has visible non-fixed elements outside viewport: ${JSON.stringify(width)}`).toHaveLength(0)
}

async function assertMobileFormControlsFit(page: Page, selector: string, label: string) {
  const summary = await page.locator(selector).evaluate((root) => {
    const viewport = window.innerWidth
    const controls = Array.from(root.querySelectorAll<HTMLElement>('input, textarea, select, [data-slot="select-trigger"]'))
      .filter((node) => {
        const style = getComputedStyle(node)
        return node.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      })
      .map((node) => {
        const rect = node.getBoundingClientRect()
        return {
          label: node.getAttribute('aria-label') || node.getAttribute('data-slot') || node.tagName.toLowerCase(),
          left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width),
        }
      })
    return { viewport, count: controls.length, outside: controls.filter((c) => c.left < -3 || c.right > viewport + 3 || c.width > viewport + 3) }
  })
  expect(summary.count, label + ' has no visible controls to validate').toBeGreaterThan(0)
  expect(summary.outside, label + ' has controls outside the phone: ' + JSON.stringify(summary)).toHaveLength(0)
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
    await expect(page.getByText('القائمة الرئيسية')).toBeVisible()
    const menu = page.getByText('القائمة الرئيسية').locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]')
    const menuBox = await menu.boundingBox()
    expect(menuBox?.height || 0, `Mobile menu should fit within viewport: ${JSON.stringify(menuBox)}`).toBeLessThanOrEqual(780)
    await assertNoPageHorizontalOverflow(page, 'mobile-menu')
    checks.push({ name: 'القائمة الهاتفية قابلة للتمرير ولا تتجاوز ارتفاع الشاشة', ok: true, detail: `${Math.round(menuBox?.height || 0)}px` })
    await page.getByLabel('القائمة').click()

    await page.getByLabel(/افتح وكيل واتساب الذكي/).click()
    await expect(page.getByText('وكيل واتساب الذكي').first()).toBeVisible()
    const chatBox = await page.getByText('وكيل واتساب الذكي').first().locator('xpath=ancestor::div[contains(@class,"rounded-3xl")][1]').boundingBox()
    expect(chatBox?.width || 0, `WhatsApp assistant popup is wider than mobile viewport: ${JSON.stringify(chatBox)}`).toBeLessThanOrEqual(390)
    expect(chatBox?.height || 0, `WhatsApp assistant popup is too tall: ${JSON.stringify(chatBox)}`).toBeLessThanOrEqual(700)
    checks.push({ name: 'نافذة وكيل واتساب مناسبة للهاتف ولا تغطي الشاشة كاملة', ok: true, detail: `${Math.round(chatBox?.width || 0)}x${Math.round(chatBox?.height || 0)}px` })
    await page.getByLabel(/إغلاق وكيل واتساب الذكي/).click()

    const adminLogin = await login(page, requiredEnv('E2E_ADMIN_EMAIL'), requiredEnv('E2E_ADMIN_PASSWORD'))
    const setup = await createFullJourneyStudent(page, adminLogin.token)
    const studentLogin = await login(page, setup.student.email, setup.student.password)
    await setBrowserToken(page, studentLogin.token)
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
    await assertNoPageHorizontalOverflow(page, 'student-dashboard')
    // Main dashboard tabs live in a hidden Radix TabsList; the student navigates
    // via visible controls (a nav select at phone width). Assert the internal
    // active state with includeHidden, and prove the section by visible content.
    const programsTab = page.getByRole('tab', { name: /برامجي/, includeHidden: true })
    await expect(programsTab).toHaveAttribute('data-state', 'active')
    await expect(page.getByText(setup.program.title).first()).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /المحتوى والواجبات/ }).click()
    await expect(page.getByRole('tab', { name: /أدلة الدراسة/ })).toBeVisible()
    const visibleTabs = await page.getByRole('tab').evaluateAll((tabs) => tabs.filter((t) => (t as HTMLElement).offsetParent !== null).map((t) => {
      const box = (t as HTMLElement).getBoundingClientRect()
      return { text: (t.textContent || '').trim(), width: Math.round(box.width), height: Math.round(box.height) }
    }))
    expect(visibleTabs.every((t) => t.height >= 32), `Mobile tabs are too cramped: ${JSON.stringify(visibleTabs)}`).toBeTruthy()
    checks.push({ name: 'تبويبات بوابة الطالب قابلة للقراءة والضغط على الهاتف', ok: true, detail: visibleTabs.map((t) => `${t.text}:${t.width}x${t.height}`).join(' / ') })

    // At phone width the visible navigation is a select; use it to open payments.
    await page.getByLabel('القائمة الكاملة لتبويبات بوابة الطالب').selectOption('payments')
    await expect(page.getByText(/قواعد فتح الاختبارات حسب السداد/)).toBeVisible()
    await assertNoPageHorizontalOverflow(page, 'student-payments')
    checks.push({ name: 'تبويب الدفعات لا يسبب تمدداً أفقياً على الهاتف', ok: true })

    // Admin tabs at phone width (Haris 2026-11-12): the books workspace and
    // the system settings tab scrolled horizontally because Radix select
    // triggers carried their full selected label as intrinsic min-content
    // width inside grids without min-w-0. The books check covers the
    // program picker (the wide element); the outline/buttons rows are
    // pinned by tests/admin/mobile-overflow-guard.test.ts.
    await setBrowserToken(page, adminLogin.token)
    await page.goto('/admin', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
    await page.getByRole('tab', { name: /الكتب والاختبارات/ }).click()
    await expect(page.getByText('اختر الدرجة ثم التخصص لإدارة الكتب والاختبارات')).toBeVisible({ timeout: 30_000 })
    await assertNoPageHorizontalOverflow(page, 'admin-books')
    checks.push({ name: 'تبويب الكتب لا يسبب تمدداً أفقياً على الهاتف', ok: true })
    await page.getByRole('tab', { name: /البريد والدفع والفيديو/ }).click()
    await page.getByRole('tab', { name: /Gemini \/ AI/ }).click()
    await page.getByRole('button', { name: /سياسات توجيه الذكاء/ }).click()
    const routingPanel = '#gemini-section-routing'
    await expect(page.locator(routingPanel)).toBeVisible({ timeout: 30_000 })
    for (const width of [320, 375, 390, 430]) {
      await page.setViewportSize({ width, height: 844 })
      await assertNoPageHorizontalOverflow(page, 'admin-system-routing-' + width)
      await assertMobileFormControlsFit(page, routingPanel, 'admin-system-routing-' + width)
      const firstSelect = page.locator(routingPanel + ' [data-slot="select-trigger"]').first()
      // The selected AI model must be readable (wrapped), not clipped off-screen.
      const visibleLabel = firstSelect.locator('span.min-w-0.flex-1')
      await expect(visibleLabel).toBeVisible()
      await expect(visibleLabel).toHaveCSS('white-space', 'normal')
      await firstSelect.click()
      const dropdown = page.locator('[data-slot="select-content"]').last()
      await expect(dropdown).toBeVisible()
      const rect = await dropdown.boundingBox()
      expect(rect, 'Open AI-provider menu must have a bounding box').toBeTruthy()
      expect(rect!.x, 'AI-provider menu starts before the viewport').toBeGreaterThanOrEqual(-3)
      expect(rect!.x + rect!.width, 'AI-provider menu extends past the viewport').toBeLessThanOrEqual(width + 3)
      await page.keyboard.press('Escape')
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole('button', { name: /مزوّدو النصوص والمفاتيح/ }).click()
    await assertMobileFormControlsFit(page, '#gemini-section-providers', 'admin-system-providers')
    await assertNoPageHorizontalOverflow(page, 'admin-system-providers')
    checks.push({ name: 'حقول النظام واختيارات المزوّدين لا تخرج عن 320/375/390/430px', ok: true })

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
