// اختبار سلوك حقيقي لتبويب «مركز الجودة الأكاديمي» بعد تنظيمه إلى سبع مساحات عمل (نمط C):
// مؤشرات عامة (4 افتراضيًا من 12) + توصيات قابلة للطي + أقسام مخفية التركيب لا مفكوكة.
// عشرة سيناريوهات على الواجهة — لا فحص نصوص مصدر:
// ١) التحميل: المؤشرات الأربعة الافتراضية بعينها ظاهرة (برامج نشطة/تحتاج تحسين/توثيق مصادر
//    الأسئلة/طلاب متعثرون) ورؤوس المساحات السبع موجودة.
// ٢) التنقل: مساحة واحدة ظاهرة في كل مرة، والتنقل لا يطلق أي طلب بيانات إضافي.
// ٣) حفظ الحالة: توسيع المؤشرات + مسودة JSON استيراد غير مرسلة تنجو من تبديل المساحات.
// ٤) المؤشرات: 4 افتراضيًا، 12 عند التوسيع، 4 عند الطي.
// ٥) جاهزية المناهج: بطاقتها داخل مساحتها مع شارة عدد البرامج (قراءة فقط — لا اعتماد).
// ٦) البلاغات: عدد المفتوحة في البطاقة لا يتغير بالتنقل، ولا تحديث حالة يحدث.
// ٧) النوافذ: مراقبة الإطلاق تفتح وتغلق من الرأس كالمعتاد.
// ٨) التشغيل: قسم التخزين/الكتالوج ظاهر دون أي استيراد أو حذف.
// ٩) الهاتف: 320 و390 بكسل بلا تمرير أفقي للصفحة.
// ١٠) فشل تحميل البيانات الثانوية: الملخصات تقول «تعذّر التحميل» ولا تعلن أصفارًا نهائية.
//
// أمان البيئة (إلزامي): هذه المواصفة قرائية بالكامل — لا اعتماد مناهج، لا تغيير تسجيل،
// لا حذف وحدات، لا تعديل أسئلة، لا توليد، لا استيراد كتالوج، لا بريد اختبار، لا عناوين أبحاث.
// بوابة العناوين أدناه هي نفسها في tests/e2e/agents-table.spec.ts بنسختها الحالية الكاملة:
// E2E_BASE_URL صراحةً، توحيد اسم المضيف (بما فيه أقواس IPv6)، رفض صلب للإنتاج ولو كان
// مدرجًا في قائمة السماح، قائمة سماح E2E_QA_HOSTS، maxRedirects: 0 لطلب تسجيل الدخول
// الحامل لبيانات الاعتماد، حقن الرمز مقيد بأصل QA المعتمد، وتنقّل المتصفح يُفحص قفزةً
// قفزة قبل جلبها (route.fetch بـ maxRedirects: 0) فلا يصل أي طلب إلى أصل أجنبي.
// حدود البوابة: تضبط عنوان الوجهة فقط — فصل قاعدة بيانات QA وخدماتها عن الإنتاج شرط بيئي
// مستقل لا تستطيع هذه المواصفة التحقق منه.
//
// بيانات QA المطلوبة (معزولة ومجهزة مسبقًا، والفشل عند غيابها صريح لا تخطٍّ صامت):
// حساب إدارة ببيانات E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD (أو ADMIN_EMAIL/ADMIN_PASSWORD).
// لا حاجة لبيانات جودة خاصة: السيناريوهات تتحقق من البنية والحالات الحقيقية أياً كانت
// (برامج جاهزية موجودة أو حالة الفراغ الصريحة)، وسيناريو الفشل يبني حالته باعتراض الشبكة.
// حارس الكتابة: أي طلب كتابة من الصفحة نحو مسارات الجودة والمناهج والأسئلة والطلاب
// والأبحاث والبريد يُجهض ويُسجَّل، ويُختم كل سيناريو بالتأكد أن شيئًا لم يُحاول الكتابة أصلًا.

import { expect, test, type Page } from '@playwright/test'

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
      'E2E_BASE_URL غير مضبوط: مواصفة تنظيم الجودة قرائية لكنها تعمل بحساب إدارة، وتُمنع من العمل على الرابط الافتراضي (الإنتاج). اضبط E2E_BASE_URL على بيئة QA صراحةً.'
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

// طلبات كتابة حاولتها الصفحة نحو المسارات المعنية (تُجهض فورًا وتُسجَّل).
const attemptedWrites: string[] = []
// مسارات بيانات الجودة التي وصلت ردودها فعلًا (لتثبيت اكتمال التحميل الثانوي).
const receivedDataPaths = new Set<string>()
// كل طلبات بيانات الجودة الصادرة (لإثبات أن التنقل بين المساحات لا يطلق طلبات).
const qualityRequestPaths: string[] = []
const QUALITY_PATHS = ['/api/admin/academic-quality', '/api/chat-feedback', '/api/admin/program-readiness', '/api/admin/storage-safety']

async function installGuards(page: Page) {
  // حماية وجهة المتصفح من التحويلات قفزةً قفزة — نفس نمط مواصفة الوكالة الحالي:
  // معالج page.route يُستدعى للعنوان الأول فقط، فيُجلب التنقّل يدويًا بلا اتباع تلقائي.
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
  // حارس الكتابة القرائية + تتبّع طلبات/ردود بيانات الجودة.
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const watched = /\/(academic-quality|chat-feedback|program-readiness|storage-safety|program-catalog|thesis|curriculum|units|question-bank|exams|students|mail)/.test(new URL(req.url()).pathname)
    if (watched && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      attemptedWrites.push(`${req.method()} ${req.url()}`)
      await route.abort()
      return
    }
    await route.continue()
  })
  page.on('request', (req) => {
    try {
      const path = new URL(req.url()).pathname
      if (QUALITY_PATHS.includes(path)) qualityRequestPaths.push(path)
    } catch { /* ignore */ }
  })
  page.on('response', (res) => {
    try {
      const path = new URL(res.url()).pathname
      if (QUALITY_PATHS.includes(path)) receivedDataPaths.add(path)
    } catch { /* ignore */ }
  })
}

// دخول مركز الجودة وانتظار رده الأساسي نفسه — لا فحص قبل اكتمال الرد.
async function enterQualityTab(page: Page) {
  const mainResponse = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/admin/academic-quality', { timeout: 30_000 })
  const tab = page.getByRole('tab', { name: /مركز الجودة/ }).first()
  if (!(await tab.isVisible().catch(() => false))) {
    await page.getByText('العملية الأكاديمية').first().click().catch(() => {})
  }
  await tab.click()
  await mainResponse
  await expect(page.getByRole('heading', { name: 'مركز الجودة الأكاديمي' })).toBeVisible({ timeout: 30_000 })
}

async function openQualityCenter(page: Page) {
  await installGuards(page)
  await page.goto('/admin', { waitUntil: 'domcontentloaded' })
  expect(new URL(page.url()).origin, 'the browser must stay on the gated QA origin').toBe(QA_ORIGIN)
  await waitForAdminReady(page)
  await enterQualityTab(page)
}

// انتظار وصول ردود البيانات الثانوية الثلاثة فعليًا (بلاغات + جاهزية + تخزين).
async function waitForSecondarySettled(page: Page) {
  await expect.poll(() => QUALITY_PATHS.slice(1).every((p) => receivedDataPaths.has(p)), { timeout: 30_000 }).toBe(true)
}

const workspaceHeaders = (page: Page) => page.locator('button[id^="quality-ws-"][id$="-header"]')
const visibleRegions = (page: Page) => page.locator('div[id^="quality-ws-"]:not([hidden])')
const overviewGrid = (page: Page) => page.locator('div[class*="xl:grid-cols-6"]')

async function openWorkspace(page: Page, id: string) {
  await page.locator(`button[id="quality-ws-${id}-header"]`).click()
  await expect(page.locator(`div[id="quality-ws-${id}"]`)).toBeVisible()
  await expect(visibleRegions(page)).toHaveCount(1)
}

async function expectNoWrites() {
  expect(attemptedWrites, `read-only spec attempted writes: ${attemptedWrites.join(' | ')}`).toEqual([])
}

test.describe('quality workspace organization (QA, read-only)', () => {
  test.beforeAll(() => {
    QA_ORIGIN = assertQaEnvironment()
  })

  test.beforeEach(async ({ page }) => {
    attemptedWrites.length = 0
    receivedDataPaths.clear()
    qualityRequestPaths.length = 0
    await loginAsAdmin(page)
    await openQualityCenter(page)
  })

  test.afterEach(async () => {
    await expectNoWrites()
  })

  test('loads with the four named default indicators and all seven workspace headers', async ({ page }) => {
    await expect(workspaceHeaders(page)).toHaveCount(7)
    const grid = overviewGrid(page)
    await expect(grid.locator('> div')).toHaveCount(4)
    for (const label of ['برامج نشطة', 'تحتاج تحسين', 'توثيق مصادر الأسئلة', 'طلاب متعثرون']) {
      await expect(grid.getByText(label, { exact: true })).toHaveCount(1)
    }
    // «امتحانات جاهزة» ثالث المؤشرات ترتيبًا وليست من الأربعة الافتراضية — غائبة الآن.
    await expect(grid.getByText('امتحانات جاهزة', { exact: true })).toHaveCount(0)
    // مساحة واحدة مفتوحة افتراضيًا: جاهزية المناهج.
    await expect(visibleRegions(page)).toHaveCount(1)
    await expect(page.locator('div[id="quality-ws-curricula"]')).toBeVisible()
  })

  test('switching workspaces shows exactly one region and fires no new data requests', async ({ page }) => {
    await waitForSecondarySettled(page)
    const before = qualityRequestPaths.length
    for (const id of ['supervision', 'programs', 'content', 'students', 'operations', 'thesis', 'curricula']) {
      await openWorkspace(page, id)
    }
    expect(qualityRequestPaths.length, 'workspace switching must not refetch quality data').toBe(before)
  })

  test('local display state and an unsent catalog draft survive workspace switching', async ({ page }) => {
    await waitForSecondarySettled(page)
    // وسّع المؤشرات (حالة عرض محلية بحتة).
    await page.getByRole('button', { name: 'عرض جميع المؤشرات' }).click()
    await expect(overviewGrid(page).locator('> div')).toHaveCount(12)
    // مسودة استيراد غير مرسلة: افتح حوار الاستيراد من قسم التشغيل واكتب نصًا ثم أغلقه.
    await openWorkspace(page, 'operations')
    await page.locator('div[id="quality-ws-operations"]').getByRole('button', { name: /استيراد/ }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    const draft = '{"qaDraft":true,"note":"unsent"}'
    await dialog.locator('textarea').first().fill(draft)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    // بدّل بعيدًا وارجع: لا المؤشرات انطوت ولا المسودة ضاعت.
    await openWorkspace(page, 'curricula')
    await expect(overviewGrid(page).locator('> div')).toHaveCount(12)
    await openWorkspace(page, 'operations')
    await page.locator('div[id="quality-ws-operations"]').getByRole('button', { name: /استيراد/ }).first().click()
    await expect(page.getByRole('dialog').locator('textarea').first()).toHaveValue(draft)
    await page.keyboard.press('Escape')
  })

  test('indicators expand to twelve and collapse back to the named four', async ({ page }) => {
    const grid = overviewGrid(page)
    await expect(grid.locator('> div')).toHaveCount(4)
    await page.getByRole('button', { name: 'عرض جميع المؤشرات' }).click()
    await expect(grid.locator('> div')).toHaveCount(12)
    for (const label of ['امتحانات جاهزة', 'اكتمال القياس', 'نسبة النجاح', 'مهارات صغيرة']) {
      await expect(grid.getByText(label, { exact: true })).toHaveCount(1)
    }
    await page.getByRole('button', { name: 'إخفاء المؤشرات الإضافية' }).click()
    await expect(grid.locator('> div')).toHaveCount(4)
    await expect(grid.getByText('امتحانات جاهزة', { exact: true })).toHaveCount(0)
  })

  test('curricula workspace shows the readiness card with its real program count badge', async ({ page }) => {
    await waitForSecondarySettled(page)
    const region = page.locator('div[id="quality-ws-curricula"]')
    await expect(region.getByText('تجهيز واعتماد المناهج للبرامج المسجل بها')).toBeVisible()
    await expect(region.getByText(/\d+ برنامج/).first()).toBeVisible()
    // ملخص رأس القسم وصل لحالة محسومة (أعداد أو تعذّر تحميل) لا حالة تحميل عالقة.
    await expect(page.locator('button[id="quality-ws-curricula-header"]')).not.toContainText('جارٍ تحميل')
  })

  test('review open-count is stable across navigation and no status changes', async ({ page }) => {
    await waitForSecondarySettled(page)
    await openWorkspace(page, 'supervision')
    const region = page.locator('div[id="quality-ws-supervision"]')
    await expect(region.getByText('ردود المشرف الذكي التي تحتاج مراجعة')).toBeVisible()
    const badge = region.getByText(/مفتوحة/).first()
    await expect(badge).toBeVisible()
    const before = (await badge.innerText()).trim()
    await openWorkspace(page, 'programs')
    await openWorkspace(page, 'supervision')
    await expect(region.getByText(/مفتوحة/).first()).toHaveText(before)
  })

  test('header dialogs still open and close (launch monitoring)', async ({ page }) => {
    await page.getByRole('button', { name: 'مراقبة الإطلاق' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('operations workspace shows catalog and storage without any import or delete action', async ({ page }) => {
    await waitForSecondarySettled(page)
    await openWorkspace(page, 'operations')
    const region = page.locator('div[id="quality-ws-operations"]')
    await expect(region.getByText('حفظ كتالوج البرامج قبل تنظيف قاعدة البيانات')).toBeVisible()
    await expect(region.getByText('تقرير سلامة التخزين')).toBeVisible()
    // التقرير إما محمّل بملخصه أو بحالته الصريحة — وكلا الحالتين بلا أي فعل كتابي.
    await expect(region.getByText(/كتب مرتبطة|غير محمّل|تعذّر/).first()).toBeVisible()
  })

  test('mobile widths keep headers usable with no page-level horizontal scroll', async ({ page }) => {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await page.waitForTimeout(300)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1)
      await expect(workspaceHeaders(page)).toHaveCount(7)
      await openWorkspace(page, 'thesis')
      await expect(page.locator('div[id="quality-ws-thesis"]').getByText('إدارة عناوين بحث التخرج')).toBeVisible()
    }
  })

  test('failed secondary loads are reported as failures, never as final zeros', async ({ page }) => {
    // اعترض البيانات الثانوية الثلاثة قبل إعادة الدخول للتبويب (إعادة تركيب المكوّن).
    await page.route('**/api/chat-feedback**', (route) => route.abort())
    await page.route('**/api/admin/program-readiness**', (route) => route.abort())
    await page.route('**/api/admin/storage-safety**', (route) => route.abort())
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForAdminReady(page)
    await enterQualityTab(page)
    await expect(page.locator('button[id="quality-ws-curricula-header"]')).toContainText('تعذّر تحميل بيانات الجاهزية', { timeout: 30_000 })
    await expect(page.locator('button[id="quality-ws-supervision-header"]')).toContainText('تعذّر تحميل البلاغات')
    await expect(page.locator('button[id="quality-ws-curricula-header"]')).not.toContainText('0 برنامج')
    // وقسم التشغيل يصرّح أن التقرير غير محمّل بدل اختلاق أرقام.
    await openWorkspace(page, 'operations')
    await expect(page.locator('button[id="quality-ws-operations-header"]')).toContainText('تقرير التخزين غير محمّل')
  })
})
