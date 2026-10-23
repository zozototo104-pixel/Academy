import { expect, test, type Page } from '@playwright/test'

// اختبار سلوك حقيقي لتبويب «الوكالة والاعتماد» بعد تحويله إلى جدول خفيف + عرض تفصيلي (نمط A).
// يغطي أربعة سيناريوهات منفّذة على الواجهة — لا فحص نصوص كود:
// ١) فتح الطلب من الجدول يعرض بطاقته الكاملة وحدها.
// ٢) العودة تحفظ حالة القائمة (بحث/فلتر).
// ٣) التفصيل يبقى معروضًا ويعكس الحالة الجديدة بعد تنفيذ فعل حالة من داخله.
// ٤) خروج الطلب المفتوح من البيانات المحمّلة يعيد العرض إلى الجدول تلقائيًا.
// يعمل في بيئة QA بنمط مواصفات tests/e2e الحالية (تسجيل دخول API + aact_token).

function requiredAnyEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw new Error(`Missing required environment variable. Expected one of: ${names.join(', ')}`)
}

async function loginAsAdmin(page: Page): Promise<string> {
  const email = requiredAnyEnv(['ADMIN_EMAIL', 'E2E_ADMIN_EMAIL'])
  const password = requiredAnyEnv(['ADMIN_PASSWORD', 'E2E_ADMIN_PASSWORD'])

  const response = await page.request.post('/api/auth/login', {
    data: { email, password },
  })
  const body = await response.json().catch(() => ({}))

  expect(response.ok(), `Admin API login failed with ${response.status()}: ${JSON.stringify(body)}`).toBeTruthy()
  expect(body?.token, 'Login response must include a session token').toBeTruthy()
  expect(body?.user?.role, 'Test account must have ADMIN role').toBe('ADMIN')

  await page.addInitScript((token: string) => {
    localStorage.setItem('aact_token', token)
    localStorage.setItem('aact_startup_seen_v2', '1')
    sessionStorage.setItem('aact_skip_startup', '1')
  }, body.token)

  return String(body.token)
}

async function waitForAdminReady(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.aact-startup-screen').waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {})
  await page.getByText('LOADING MODULE').waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
  await expect(page.getByRole('heading', { name: /لوحة إدارة الأكاديمية/ })).toBeVisible({ timeout: 30_000 })
}

async function openAgentsTab(page: Page) {
  await page.goto('/admin', { waitUntil: 'domcontentloaded' })
  await waitForAdminReady(page)
  await page.getByRole('tab', { name: /الوكالة والاعتماد/ }).first().click()
  // شريط الأدوات دليل جاهزية التبويب.
  await expect(page.getByPlaceholder('ابحث باسم الجهة أو الممثل أو البلد أو العقد...')).toBeVisible({ timeout: 30_000 })
}

const agentsTable = (page: Page) => page.locator('table').filter({ hasText: 'الوثائق والرسوم' })
const agentsRows = (page: Page) => agentsTable(page).locator('tbody tr')
const backButton = (page: Page) => page.getByRole('button', { name: /عودة إلى القائمة/ })

test.describe('agents tab — table + detail behavior', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await openAgentsTab(page)
  })

  test('opening an application from the table shows its full card alone', async ({ page }) => {
    await expect(agentsTable(page)).toBeVisible({ timeout: 30_000 })
    const rowCount = await agentsRows(page).count()
    test.skip(rowCount === 0, 'لا توجد طلبات وكالة/اعتماد في بيانات QA للفحص')

    const firstRowButton = agentsRows(page).first().locator('button').first()
    const orgName = (await firstRowButton.innerText()).trim()
    await firstRowButton.click()

    // التفصيل وحده: زر العودة ظاهر، الجدول مختفي، وبطاقة الطلب بأفعالها ظاهرة.
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
    await expect(agentsTable(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /معاينة/ }).first()).toBeVisible()
    expect(orgName.length).toBeGreaterThan(0)
  })

  test('returning from the detail preserves the list search state', async ({ page }) => {
    await expect(agentsTable(page)).toBeVisible({ timeout: 30_000 })
    const rowCount = await agentsRows(page).count()
    test.skip(rowCount === 0, 'لا توجد طلبات وكالة/اعتماد في بيانات QA للفحص')

    const orgName = (await agentsRows(page).first().locator('button').first().innerText()).trim()
    const searchBox = page.getByPlaceholder('ابحث باسم الجهة أو الممثل أو البلد أو العقد...')
    await searchBox.fill(orgName)
    await expect(agentsRows(page).first()).toContainText(orgName, { timeout: 15_000 })

    await agentsRows(page).first().locator('button').first().click()
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
    await backButton(page).click()

    // الجدول رجع بنفس البحث — لا تصفير ولا إعادة ضبط.
    await expect(agentsTable(page)).toBeVisible({ timeout: 15_000 })
    await expect(searchBox).toHaveValue(orgName)
    await expect(agentsRows(page).first()).toContainText(orgName)
  })

  test('the detail stays open and reflects the new status after an in-detail status action', async ({ page, request }) => {
    // نبحث عن طلب معلّق عبر الـAPI لنضمن وجود فعل «رفض» داخل التفصيل.
    const token = await page.evaluate(() => localStorage.getItem('aact_token'))
    const res = await request.get('/api/admin/applications?status=PENDING&page=1&pageSize=10', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.ok()).toBeTruthy()
    const data = await res.json().catch(() => ({}))
    const pending = (data?.applications || []).find((a: { submittedByStaff?: boolean }) => !a.submittedByStaff)
    test.skip(!pending, 'لا يوجد طلب معلّق صالح للرفض في بيانات QA')

    const searchBox = page.getByPlaceholder('ابحث باسم الجهة أو الممثل أو البلد أو العقد...')
    await searchBox.fill(String(pending.orgName))
    await expect(agentsTable(page)).toBeVisible({ timeout: 30_000 })
    await agentsRows(page).first().locator('button').first().click()
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /^رفض$/ }).first().click()

    // التفصيل باقٍ ويعكس «مرفوض» — لا انهيار ولا عودة قسرية للجدول.
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('مرفوض', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await expect(agentsTable(page)).toHaveCount(0)
  })

  test('when the open application leaves the loaded data, the view falls back to the table', async ({ page }) => {
    await expect(agentsTable(page)).toBeVisible({ timeout: 30_000 })
    const rowCount = await agentsRows(page).count()
    test.skip(rowCount === 0, 'لا توجد طلبات وكالة/اعتماد في بيانات QA للفحص')

    await agentsRows(page).first().locator('button').first().click()
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })

    // بحث لا يطابق شيئًا: الطلب المفتوح يخرج من البيانات المحمّلة.
    const searchBox = page.getByPlaceholder('ابحث باسم الجهة أو الممثل أو البلد أو العقد...')
    await searchBox.fill('zzz-لا-يوجد-طلب-بهذا-الاسم-zzz')

    // لا بطاقة عالقة: زر العودة يختفي وتظهر حالة الفراغ الخاصة بالبحث.
    await expect(backButton(page)).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText('لا توجد طلبات مطابقة للبحث أو الفلتر الحالي.')).toBeVisible({ timeout: 15_000 })

    // مسح البحث يعيد الجدول.
    await searchBox.fill('')
    await expect(agentsTable(page)).toBeVisible({ timeout: 15_000 })
  })
})
