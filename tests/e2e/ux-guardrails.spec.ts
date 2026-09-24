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

async function loginAsAdmin(page: Page) {
  return login(page, requiredEnv('E2E_ADMIN_EMAIL'), requiredEnv('E2E_ADMIN_PASSWORD'))
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
  expect(setup.journeySchemaVersion, 'UX guardrails require full journey schema v4 or newer').toBeGreaterThanOrEqual(4)
  return setup
}

function md(report: any) {
  const rows = report.checks.map((c: any) => `| ${c.name} | ${c.ok ? '✅' : '❌'} | ${String(c.detail || '').replace(/\|/g, '/')} |`).join('\n')
  return `# AACT UX Guardrails Report\n\nGenerated: ${new Date().toISOString()}\n\n| Check | Result | Detail |\n|---|---|---|\n${rows}\n\n## Full journey context\n\n\`\`\`json\n${JSON.stringify(report.context || {}, null, 2)}\n\`\`\`\n`
}

test.describe('AACT UX guardrails suite', () => {
  test.setTimeout(180_000)

  test('critical UX issues are caught across public pages, forms, student portal, admin cards, popups, and payments', async ({ page }, testInfo: TestInfo) => {
    const checks: Array<{ name: string; ok: boolean; detail?: string }> = []

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
    await expect(page.getByText(/تحميل كود المنصة|تحميل كود المنصة \(ZIP\)/)).toHaveCount(0)
    checks.push({ name: 'الفوتر لا يعرض رابط تحميل كود المنصة', ok: true })

    const heroImage = page.getByRole('img', { name: /طلاب وخريجون/ })
    await expect(heroImage).toBeVisible()
    const heroBox = await heroImage.boundingBox()
    expect(heroBox?.height || 0, `Hero image is too tall: ${JSON.stringify(heroBox)}`).toBeLessThanOrEqual(560)
    checks.push({ name: 'الصورة الرئيسية ليست طويلة بشكل يطغى على الصفحة', ok: true, detail: `${Math.round(heroBox?.height || 0)}px` })

    await page.getByLabel(/افتح وكيل واتساب الذكي/).click()
    await expect(page.getByText('وكيل واتساب الذكي').first()).toBeVisible()
    await expect(page.getByText(/فتح المحادثة على واتساب الرسمي/)).toBeVisible()
    await page.getByLabel(/إغلاق وكيل واتساب الذكي/).click()
    await expect(page.getByText(/فتح المحادثة على واتساب الرسمي/)).toHaveCount(0)
    checks.push({ name: 'زر واتساب العائم يفتح ويغلق نافذة الوكيل الذكي', ok: true })

    await page.goto('/apply', { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
    await expect(page.locator('#ad-country')).toBeVisible()
    await expect(page.getByText(/يقبل النظام أرقام الهويات الدولية وجوازات السفر/)).toBeVisible()
    await expect(page.getByText(/9 أرقام للهوية|يجب أن تتكون من 9 أرقام بالضبط/)).toHaveCount(0)
    await expect(page.getByPlaceholder(/\+970598400510/)).toBeVisible()
    checks.push({ name: 'نموذج الالتحاق يستخدم دولة منسدلة وهوية دولية وهاتف واضح', ok: true })

    const adminLogin = await loginAsAdmin(page)
    const setup = await createFullJourneyStudent(page, adminLogin.token)
    checks.push({ name: 'تجهيز طالب رحلة UX كاملة', ok: true, detail: setup.admission?.reference })

    await setBrowserToken(page, adminLogin.token)
    await page.goto('/?view=admin', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
    await page.getByLabel(/فتح الملف الشخصي المختصر/).click()
    await expect(page.getByText(adminLogin.user.email).first()).toBeVisible()
    checks.push({ name: 'الضغط على اسم المستخدم يفتح بطاقة ملف مختصرة', ok: true })

    await page.getByLabel('الإشعارات').click()
    await expect(page.getByText('الإشعارات').first()).toBeVisible()
    await page.mouse.click(20, 20)
    await expect(page.getByText('الإشعارات').first()).toHaveCount(0)
    checks.push({ name: 'قائمة الإشعارات تغلق عند النقر خارجها', ok: true })

    const admissionCard = page.locator(`#admission-${setup.admission.id}`)
    await expect(admissionCard, 'Admin admission card must exist').toBeVisible({ timeout: 30_000 })
    await expect(admissionCard.getByText(/فواتير غير مسددة/), 'Covered installment plan must not show stale unpaid invoices').toHaveCount(0)
    checks.push({ name: 'بطاقة الإدارة لا تعرض فواتير غير مسددة بعد تغطية التقسيط', ok: true })

    const studentLogin = await login(page, setup.student.email, setup.student.password)
    await setBrowserToken(page, studentLogin.token)
    await page.goto('/dashboard', { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
    const programsTab = page.getByRole('tab', { name: /برامجي/ })
    await expect(programsTab).toBeVisible()
    await expect(programsTab, 'Student dashboard should open on programs, not payments').toHaveAttribute('data-state', 'active')
    await expect(page.getByText(setup.program.title).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/برامجي المسجل بها/)).toHaveCount(0)
    await expect(page.getByText(/ملفك الأكاديمي/).first()).toBeVisible()
    await page.getByRole('button', { name: /المحتوى والواجبات/ }).click()
    await expect(page.getByRole('tab', { name: /أدلة الدراسة/ })).toBeVisible()
    await page.getByRole('button', { name: /جدول الدراسة/ }).click()
    await expect(page.getByText(/جدول الدراسة للفصول والمواد المطلوبة/)).toBeVisible()
    checks.push({ name: 'بوابة الطالب تبدأ ببرامجي وتستخدم أقسام داخلية بدل تحميل كل البطاقات دفعة واحدة', ok: true })

    await page.getByRole('tab', { name: /الدفعات/ }).click()
    await expect(page.getByText(/قواعد فتح الاختبارات حسب السداد/)).toBeVisible()
    await expect(page.getByText(/يفتح امتحان الفصل الأول بعد سداد نصف الرسوم/)).toBeVisible()
    await expect(page.getByText(/فاتورة غير مسددة|فواتير غير مسددة/)).toHaveCount(0)
    checks.push({ name: 'تبويب الدفعات يشرح بوابات الرسوم ولا يعرض فواتير متقادمة', ok: true })

    const dashboardTabs = await page.getByRole('tab').evaluateAll((tabs) => tabs.filter((t) => (t as HTMLElement).offsetParent !== null).map((t) => (t.textContent || '').trim()))
    expect(dashboardTabs.length, `Too many student dashboard tabs: ${dashboardTabs.join(' | ')}`).toBeLessThanOrEqual(8)
    checks.push({ name: 'عدد تبويبات بوابة الطالب مضبوط ولا يتكدس', ok: true, detail: dashboardTabs.join(' / ') })

    const report = {
      generatedAt: new Date().toISOString(),
      checks,
      context: {
        admission: setup.admission,
        program: setup.program,
        tuitionGates: setup.tuitionGates,
        finalGrade: setup.academicJourney?.finalGrade,
      },
    }
    await mkdir('test-results/ux-guardrails', { recursive: true }).catch(() => {})
    const jsonPath = 'test-results/ux-guardrails/report.json'
    const mdPath = 'test-results/ux-guardrails/report.md'
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
    await writeFile(mdPath, md(report), 'utf8')
    await testInfo.attach('ux-guardrails-report-json', { path: jsonPath, contentType: 'application/json' })
    await testInfo.attach('ux-guardrails-report-md', { path: mdPath, contentType: 'text/markdown' })
  })
})
