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
// لذلك تتحقق البوابة أدناه قبل أي خطوة: العنوان مضبوط صراحةً، واسم المضيف موحّد الصيغة
// (أحرف صغيرة وبلا نقطة نهائية — فالنقطة النهائية لا تصنع نطاقًا مختلفًا)، والإنتاج مرفوض
// رفضًا صلبًا ولو ذُكر في قائمة السماح بالخطأ، والوجهة إما محلية أو مذكورة حرفيًا في
// قائمة السماح E2E_QA_HOSTS. طلبات الـAPI المباشرة في هذه المواصفة لا تتبع التحويلات
// (maxRedirects: 0) فأي تحويل يظهر كفشل صريح بدل أن يُتبع بصمت — بما فيه طلب التحقق
// الحامل لرمز الإدارة بعد الرفض، حتى لا يتسرب الرمز إلى مضيف آخر عبر تحويل.
// وتنقّل المتصفح نفسه محمي من التحويلات: حقن رمز الجلسة لا يحدث إلا على أصل بيئة
// الاختبار المقصود، والتنقّلات الرئيسية تُجلب يدويًا قفزةً قفزة دون اتباع تلقائي
// (لأن معالج الاعتراض لا يُستدعى لوجهات التحويل التالية)، فتُفحص كل قفزة قبل جلبها
// ولا يصل أي طلب إلى أصل أجنبي، ثم يُتحقق من بقاء الصفحة على الأصل بعد الفتح.
// حدود البوابة: هي تضبط عنوان الوجهة فقط — فصل قاعدة بيانات QA وخدمات الإرسال عن
// الإنتاج شرط بيئي مستقل لا تستطيع هذه الدالة التحقق منه.
// كل السيناريوهات تعمل على طلبات اختبار مخصصة معزولة تُنشأ عبر /api/agent-apply كزائر
// بأسماء وبريد فريدة لكل تشغيلة (RUN_ID داخل الاسم والبريد، ونطاق example.com — لا يصل
// أي إشعار لشخص حقيقي)، ولا تلمس أي طلب حقيقي قائم.
// سياسة البقايا: التشغيلة الكاملة تُنشئ ١٤ طلبًا (١ فتح + ١١ تصفّح + ١ رفض + ١ خروج)
// تبقى كلها في قاعدة بيانات QA كسجلات اختبار منتهية قابلة للتتبع ببادئة التشغيلة؛
// لا توجد واجهة حذف لطلبات الوكالة، فالتنظيف يكون بسياسة بيئة QA نفسها (تصفير/تدوير
// قاعدة الاختبار)، وليس المرفوض وحده هو المتروك.

const PRODUCTION_HOSTS = ['academy-raqaba.vercel.app', 'www.aactacademy.com', 'aactacademy.com']

function normalizeHost(host: string) {
  // توحيد: أحرف صغيرة، بلا نقطة نهائية، وبلا أقواس IPv6 (URL.hostname يعيد [::1] بأقواسها).
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^\[/, '').replace(/\]$/, '')
}

// أصل بيئة الاختبار المعتمد (protocol//host[:port]) — يُضبط في beforeAll من البوابة،
// ويُستخدم لتقييد حقن الرمز وتنقّل المتصفح بهذه الوجهة وحدها.
let QA_ORIGIN = ''

function assertQaEnvironment(): string {
  const raw = process.env.E2E_BASE_URL?.trim()
  if (!raw) {
    throw new Error(
      'E2E_BASE_URL غير مضبوط: مواصفة جدول الوكالة تُنشئ طلبات اختبار وترفضها، وتُمنع من العمل على الرابط الافتراضي (الإنتاج). اضبط E2E_BASE_URL على بيئة QA صراحةً.'
    )
  }
  const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
  const host = normalizeHost(url.hostname)
  if (PRODUCTION_HOSTS.map(normalizeHost).includes(host)) {
    throw new Error(`E2E_BASE_URL يشير إلى نطاق إنتاج (${host}) — تشغيل هذه المواصفة عليه ممنوع.`)
  }
  const allowlist = (process.env.E2E_QA_HOSTS || '').split(',').map(normalizeHost).filter(Boolean)
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'
  if (!isLocal && !allowlist.includes(host)) {
    throw new Error(
      `المضيف ${host} ليس محليًا وليس في قائمة سماح QA (E2E_QA_HOSTS) — أضفه صراحةً إن كان وجهة اختبار مقصودة، فلا يُفترض أي نطاق غير محظور بيئةَ اختبار.`
    )
  }
  return url.origin
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
    maxRedirects: 0, // لا اتباع تحويلات بصمت قبل أي كتابة
  })
  const body = await response.json().catch(() => ({}))

  expect(response.ok(), `Admin API login failed with ${response.status()}: ${JSON.stringify(body)}`).toBeTruthy()
  expect(body?.token, 'Login response must include a session token').toBeTruthy()
  expect(body?.user?.role, 'Test account must have ADMIN role').toBe('ADMIN')

  await page.addInitScript((arg: { token: string; origin: string }) => {
    // لا حقن للرمز خارج أصل بيئة الاختبار المقصود — سكربتات التهيئة تعمل عند كل تنقّل،
    // فلو انحرف المتصفح إلى أصل آخر لا يصله الرمز.
    if (window.location.origin !== arg.origin) return
    localStorage.setItem('aact_token', arg.token)
    localStorage.setItem('aact_startup_seen_v2', '1')
    sessionStorage.setItem('aact_skip_startup', '1')
  }, { token: String(body.token), origin: QA_ORIGIN })

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
  // حماية وجهة المتصفح من التحويلات: معالج page.route يُستدعى للعنوان الأول فقط،
  // والمتصفح يتبع التحويلات بعده دون إعادة فحص — لذلك يُجلب التنقّل يدويًا بلا اتباع
  // تحويلات (route.fetch بـ maxRedirects: 0) وتُفحص كل قفزة قبل جلبها: أي قفزة إلى
  // أصل غير أصل الاختبار تُجهض التنقّل قبل أن يصل أي طلب إلى الوجهة الأجنبية،
  // ولا تُسلَّم للمتصفح إلا الاستجابة النهائية بعد التحقق من سلسلتها كاملة.
  await page.route('**/*', async (route) => {
    const req = route.request()
    if (!req.isNavigationRequest()) {
      await route.continue()
      return
    }
    let url = req.url()
    let prevStatus = 0
    for (let hop = 0; hop < 10; hop++) {
      let hopOrigin = ''
      try {
        hopOrigin = new URL(url).origin
      } catch {
        hopOrigin = ''
      }
      if (!hopOrigin || hopOrigin !== QA_ORIGIN) {
        await route.abort()
        return
      }
      // قفزات 307/308 وحدها تحافظ على طريقة الطلب الأصلي وجسمه؛ غيرها يتحول إلى GET.
      const preserveMethod = hop > 0 && (prevStatus === 307 || prevStatus === 308) && req.method() !== 'GET'
      const res = hop === 0
        ? await route.fetch({ maxRedirects: 0 })
        : preserveMethod
          ? await route.fetch({ url, method: req.method(), postData: req.postData() ?? undefined, maxRedirects: 0 })
          : await route.fetch({ url, method: 'GET', maxRedirects: 0 })
      const status = res.status()
      const location = res.headers()['location']
      if (status >= 300 && status < 400 && location) {
        prevStatus = status
        url = new URL(location, url).toString()
        await res.dispose()
        continue
      }
      await route.fulfill({ response: res })
      return
    }
    await route.abort() // سلسلة تحويلات أطول من الحد — تُرفض
  })
  await page.goto('/admin', { waitUntil: 'domcontentloaded' })
  expect(new URL(page.url()).origin, 'the browser must stay on the gated QA origin').toBe(QA_ORIGIN)
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
// يعيد اسم الجهة ومعرّف السجل المنشأ حتى تثبت الاختبارات أن أفعالها استهدفت سجلّها هي.
async function createDedicatedApplication(request: APIRequestContext, orgName: string, emailTag: string) {
  const res = await request.post('/api/agent-apply', {
    maxRedirects: 0, // طلب كتابة: أي تحويل فشل صريح، لا اتباع صامت
    data: {
      kind: 'AGENCY',
      orgName,
      repName: 'ممثل اختبار آلي',
      email: `qa-agents-${RUN_ID}-${emailTag}@example.com`,
      phone: '+970000000000',
      country: 'فلسطين',
      territory: 'نطاق اختبار آلي',
      experience: 'طلب اختبار معزول لمواصفة جدول الوكالة والاعتماد — بيانات QA فقط',
    },
  })
  const body = await res.json().catch(() => ({}))
  expect(res.ok(), `creating the dedicated QA application failed with ${res.status()}: ${JSON.stringify(body)}`).toBeTruthy()
  const id = String(body?.id || '')
  expect(id, 'agent-apply must return the created application id').toBeTruthy()
  return { orgName, id }
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
    QA_ORIGIN = assertQaEnvironment()
  })

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page)
    await openAgentsTab(page)
  })

  test('opening an application from the table shows its full card alone', async ({ page, request }) => {
    const { orgName } = await createDedicatedApplication(request, `${RUN_ID}-OPEN`, 'open')
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

    // الانتقال إلى الصفحة الثانية. المحدد محصور داخل المصفّح نفسه (جذر مكوّن التصفّح
    // حول نص «عرض X–Y من Z») — عدّاد شريط الأدوات «N / N» عنصر آخر خارج هذا النطاق
    // ولا يجوز أن يطابقه المحدد، ولا تُستخدم .first() لإخفاء التباس.
    const pagerRoot = page.getByText(/عرض \d+–\d+ من \d+ طلب وكالة\/اعتماد/).locator('..')
    const chip = pagerRoot.locator('span', { hasText: /^\d+ \/ \d+$/ })
    await expect(chip).toHaveCount(1)
    await expect(chip).toContainText('1 / 2')
    await pagerRoot.locator('button').nth(2).click()
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
    const created = await createDedicatedApplication(request, `${RUN_ID}-REJECT`, 'reject')
    await chooseStatusFilter(page, 'معلقة')
    const nameButton = await openDedicatedRow(page, created.orgName)
    await nameButton.click()
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: /^رفض$/ }).first().click()

    // التفصيل باقٍ ويعكس «مرفوض» — لا انهيار ولا عودة قسرية للجدول.
    await expect(backButton(page)).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('مرفوض', { exact: true }).first()).toBeVisible({ timeout: 15_000 })
    await expect(agentsTable(page)).toHaveCount(0)

    // إثبات بالمعرّف أن الرفض استهدف السجل الذي أنشأته هذه التشغيلة تحديدًا.
    const token = await page.evaluate(() => localStorage.getItem('aact_token'))
    const check = await page.request.get(
      `/api/admin/applications?search=${encodeURIComponent(created.orgName)}&status=ALL&page=1&pageSize=5`,
      {
        headers: { Authorization: `Bearer ${token}` },
        maxRedirects: 0, // طلب يحمل رمز الإدارة: أي تحويل فشل صريح — لا يتسرب الرمز لمضيف آخر
      }
    )
    expect(check.ok()).toBeTruthy()
    const checkBody = await check.json().catch(() => ({}))
    const record = (checkBody?.applications || []).find((a: { id: string }) => a.id === created.id)
    expect(record, 'the created application must be findable by its id').toBeTruthy()
    expect(record.status).toBe('REJECTED')
  })

  test('when the open application leaves the loaded data, the selection ends and never resurrects', async ({ page, request }) => {
    const { orgName } = await createDedicatedApplication(request, `${RUN_ID}-EXIT`, 'exit')
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
