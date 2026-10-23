import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

// اختبار سلوك حقيقي لتبويب «الوكالة والاعتماد» بعد تحويله إلى جدول خفيف + عرض تفصيلي (نمط A).
// أربعة سيناريوهات منفّذة على الواجهة — لا فحص نصوص كود:
// ١) فتح الطلب من الجدول يعرض بطاقته الكاملة وحدها.
// ٢) العودة تحفظ حالة القائمة كاملة (بحث + فلتر + صفحة) ودون أي إعادة جلب عند الفتح أو العودة.
// ٣) التفصيل يبقى معروضًا ويعكس الحالة الجديدة بعد تنفيذ فعل حالة من داخله.
// ٤) خروج الطلب المفتوح من البيانات المحمّلة ينهي الاختيار: يرجع الجدول، ولا تعود
//    التفاصيل تلقائيًا بعد مسح البحث.
//
// أمان البيئة (إلزامي): هذه المواصفة تُنشئ طلبات اختبار وترفض أحدها — تُمنع من العمل
// خارج بيئة QA. إعداد Playwright يرجع افتراضيًا إلى رابط الإنتاج عند غياب E2E_BASE_URL،
// لذلك تتحقق البوابة أدناه قبل أي خطوة: العنوان مضبوط صراحةً وليس أحد نطاقات الإنتاج.
// كل السيناريوهات تعمل على طلبات اختبار مخصصة معزولة تُنشأ عبر /api/agent-apply كزائر
// بأسماء وبريد فريدة لكل تشغيلة (نطاق example.com — لا يصل أي إشعار لشخص حقيقي)،
// ولا تلمس أي طلب حقيقي قائم. الطلب المرفوض يبقى في قاعدة QA وحده كسجل اختبار منتهٍ.

const PRODUCTION_HOSTS = ['academy-raqaba.vercel.app', 'www.aactacademy.com', 'aactacademy.com']

function assertQaEnvironment() {
  const raw = process.env.E2E_BASE_URL?.trim()
  if (!raw) {
    throw new Error(
      'E2E_BASE_URL غير مضبوط: مواصفة جدول الوكالة تُنشئ طلبات اختبار وترفضها، وتُمنع من العمل على الرابط الافتراضي (الإنتاج). اضبط E2E_BASE_URL على بيئة QA صراحةً.'
    )
  }
  const host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname
  if (PRODUCTION_HOSTS.includes(host)) {
    throw new Error(`E2E_BASE_URL يشير إلى نطاق إنتاج (${host}) — تشغيل هذه المواصفة عليه ممنوع.`)
  }
}

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

const SEARCH_PLACEHOLDER = 'ابحث باسم الجهة أو الممثل أو البلد أو العقد...'
const searchBox = (page: Page) => page.getByPlaceholder(SEARCH_PLACEHOLDER)
const agentsTable = (page: Page) => page.locator('table').filter({ hasText: 'الوثائق والرسوم' })
const agentsRows = (page: Page) => agentsTable(page).locator('tbody tr')
const backButton = (page: Page) => page.getByRole('button', { name: /عودة إلى القائمة/ })
const statusCombobox = (page: Page) => page.locator('button[role="combobox"]').first()

async function openAgentsTab(page: Page) {
  await page.goto('/admin', { waitUntil: 'domcontentloaded' })
  await waitForAdminReady(page)
  await page.getByRole('tab', { name: /الوكالة والاعتماد/ }).first().click()
  await expect(searchBox(page)).toBeVisible({ timeout: 30_000 })
}

async function chooseStatusFilter(page: Page, label: string) {
  await statusCombobox(page).click()
  await page.getByRole('option', { name: label, exact: true }).click()
}

const RUN_ID = `QA-AGT-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`

// إنشاء طلب وكالة اختبار معزول كزائر (بلا أي جلسة إدارة) عبر سياق طلب مستقل.
async function createDedicatedApplication(request: APIRequestContext, orgName: string, emailTag: string) {
  const res = await request.post('/api/agent-apply', {
    data: {
      kind: 'AGENCY',
      orgName,
      repName: 'ممثل اختبار آلي',
      email: `qa-agents-${emailTag}@example.com`,
      phone: '+970000000000',
      country: 'فلسطين',
      territory: 'نطاق اختبار آلي',
      experience: 'طلب اختبار معزول لمواصفة جدول الوكالة والاعتماد — بيانات QA فقط',
    },
  })
  const body = await res.json().catch(() => ({}))
  expect(res.ok(), `creating the dedicated QA application failed with ${res.status()}: ${JSON.stringify(body)}`).toBeTruthy()
  return orgName
}

// بحث + فلتر حتى يظهر صف الطلب المخصص تحديدًا، ثم إرجاع زر اسمه.
async function openDedicatedRow(page: Page, orgName: string) {
  await searchBox(page).fill(orgName)
  const row = agentsRows(page).filter({ hasText: orgName })
  await expect(row).toHaveCount(1, { timeout: 30_000 })
  return row.locator('button').first()
}

test.describe('agents tab — table + detail behavior (QA only, dedicated data)', () => {
  test.beforeAll(() => {
    assertQaEnvironment()
  })

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await openAgentsTab(page)
  })

  test('opening an application from the table shows its full card alone', async ({ page, request }) => {
    const orgName = await createDedicatedApplication(request, `${RUN_ID}-OPEN`, 'open')
    await chooseStatusFilter(page, 'كل الطلبات')
    const nameButton = await openDedicatedRow(page, orgName)
    await nameButton.click()

    // التفصيل وحده: زر العودة ظاهر، الجدول مختفٍ، وبطاقة الطلب بأفعالها ظاهرة.
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
    await expect(agentsTable(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: /معاينة/ }).first()).toBeVisible()
    await expect(page.getByText(orgName).first()).toBeVisible()
  })

  test('returning preserves search, filter and page — with no refetch on open or back', async ({ page, request }) => {
    // ١١ طلبًا مخصصًا بنفس بادئة التشغيلة: بحجم الصفحة الافتراضي (١٠) نحصل على صفحتين بيقين.
    const prefix = `${RUN_ID}-PAGE`
    for (let i = 1; i <= 11; i++) {
      await createDedicatedApplication(request, `${prefix}-${String(i).padStart(2, '0')}`, `page${i}`)
    }

    await chooseStatusFilter(page, 'كل الطلبات')
    await searchBox(page).fill(prefix)
    await expect(agentsRows(page)).toHaveCount(10, { timeout: 30_000 })

    // الانتقال إلى الصفحة الثانية (شريحة المصفّح «1 / 2» ثم زر التالي).
    const chip = page.locator('span', { hasText: /^\d+ \/ \d+$/ })
    await expect(chip).toContainText('1 / 2')
    await chip.locator('..').locator('button').nth(2).click()
    await expect(chip).toContainText('2 / 2')
    await expect(agentsRows(page)).toHaveCount(1)

    // عدّاد طلبات الجلب: الفتح والعودة حالتا اختيار فقط — لا إعادة جلب مسموحة.
    let applicationsRequests = 0
    page.on('request', (req) => {
      if (req.url().includes('/api/admin/applications')) applicationsRequests++
    })

    const pageTwoOrg = (await agentsRows(page).first().locator('button').first().innerText()).trim()
    await agentsRows(page).first().locator('button').first().click()
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
    await backButton(page).click()
    await expect(agentsTable(page)).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1_200) // أكبر من مهلة التأخير + الجلب لو حدث

    expect(applicationsRequests, 'opening the detail or returning must not refetch the applications list').toBe(0)
    await expect(searchBox(page)).toHaveValue(prefix)
    await expect(statusCombobox(page)).toContainText('كل الطلبات')
    await expect(chip).toContainText('2 / 2')
    await expect(agentsRows(page).first()).toContainText(pageTwoOrg)
  })

  test('the detail stays open and reflects the new status after rejecting a dedicated application', async ({ page, request }) => {
    const orgName = await createDedicatedApplication(request, `${RUN_ID}-REJECT`, 'reject')
    await chooseStatusFilter(page, 'معلقة')
    const nameButton = await openDedicatedRow(page, orgName)
    await nameButton.click()
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /^رفض$/ }).first().click()

    // التفصيل باقٍ ويعكس «مرفوض» — لا انهيار ولا عودة قسرية للجدول.
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('مرفوض', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await expect(agentsTable(page)).toHaveCount(0)
  })

  test('when the open application leaves the loaded data, the selection ends and never resurrects', async ({ page, request }) => {
    const orgName = await createDedicatedApplication(request, `${RUN_ID}-EXIT`, 'exit')
    await chooseStatusFilter(page, 'كل الطلبات')
    const nameButton = await openDedicatedRow(page, orgName)
    await nameButton.click()
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })

    // بحث لا يطابق شيئًا: الطلب المفتوح يخرج من البيانات المحمّلة فينتهي اختياره.
    await searchBox(page).fill('zzz-لا-يوجد-طلب-بهذا-الاسم-zzz')
    await expect(backButton(page)).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText('لا توجد طلبات مطابقة للبحث أو الفلتر الحالي.')).toBeVisible({ timeout: 15_000 })

    // مسح البحث: يرجع الجدول — ولا تعود تفاصيل الطلب تلقائيًا.
    await searchBox(page).fill('')
    await expect(agentsTable(page)).toBeVisible({ timeout: 15_000 })
    await expect(backButton(page)).toHaveCount(0)
  })
})
