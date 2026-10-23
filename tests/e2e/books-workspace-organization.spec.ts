import { expect, test, type Page } from '@playwright/test'

// اختبار سلوك حقيقي لتبويب «الكتب والاختبارات» بعد تنظيمه (جاهزية قابلة للطي + قائمة كتب
// مختصرة بتفصيل واحد مفتوح وفلاتر عرض محلية). سبعة سيناريوهات على الواجهة — لا فحص نصوص:
// ١) التنقل: اختيار برنامج والمرور بمساحات العمل الثماني والعودة للكتب دون تغيّر السياق.
// ٢) فتح كتاب وطيّه: البداية مختصرة، تفصيل واحد مفتوح كحد أقصى.
// ٣) البحث ومنع الانبعاث: فتح كتاب ثم بحث يستبعده ينهي اختياره فعليًا، ومسح البحث لا يعيده.
// ٤) مسودة غير محفوظة: رابط مصدر مكتوب وملف مختار دون حفظ ينجوان من الطي وإعادة الفتح.
// ٥) تغيير البرنامج: اختيار الكتاب القديم ينتهي وكتب البرنامج الجديد فقط تظهر — يُفحص
//    بعد اكتمال تحميل الجديد فعليًا، لا أثناء التحميل.
// ٦) فشل تحميل البرنامج الجديد: تفاصيل كتاب البرنامج السابق لا تظهر تحته أبدًا، حتى مع
//    بقاء كتبه القديمة محمّلة (سلوك تحميل سابق — الاختيار ينتهي عند التبديل نفسه).
// ٧) العرض المتجاوب: هاتف ومكتب بلا تمرير أفقي للصفحة.
//
// أمان البيئة (إلزامي): هذه المواصفة قرائية بالكامل — لا إنشاء ولا حذف ولا رفع ولا توليد.
// بوابة العناوين أدناه هي نفسها في tests/e2e/agents-table.spec.ts بنسختها الحالية الكاملة:
// E2E_BASE_URL صراحةً، توحيد اسم المضيف (بما فيه أقواس IPv6)، رفض صلب للإنتاج ولو كان
// مدرجًا في قائمة السماح، قائمة سماح E2E_QA_HOSTS، maxRedirects: 0 لطلب تسجيل الدخول
// الحامل لبيانات الاعتماد، حقن الرمز مقيد بأصل QA المعتمد، وتنقّل المتصفح يُفحص قفزةً
// قفزة قبل جلبها (route.fetch بـ maxRedirects: 0) فلا يصل أي طلب إلى أصل أجنبي.
// حدود البوابة: تضبط عنوان الوجهة فقط — فصل قاعدة بيانات QA وخدماتها عن الإنتاج شرط بيئي
// مستقل لا تستطيع هذه المواصفة التحقق منه.
//
// بيانات QA المطلوبة (معزولة ومجهزة مسبقًا، والفشل عند غيابها صريح لا تخطٍّ صامت):
// حساب إدارة ببيانات E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD (أو ADMIN_EMAIL/ADMIN_PASSWORD)،
// وبرنامج مؤهل في أي درجة: كتابان على الأقل وأحدهما «يحتاج مصدر قراءة»، ودرجة فيها
// برنامجان على الأقل أولهما فيه كتاب. المواصفة تكتشف البرنامج المؤهل قرائيًا بمسح
// الدرجات والبرامج بالترتيب بدل افتراض أن أول برنامج هو المؤهل.
// حارس الكتابة: أي طلب كتابة من الصفحة نحو مسارات الكتب/الامتحانات/الأسئلة يُجهض ويُسجَّل،
// ويُختم كل سيناريو بالتأكد أن شيئًا لم يُحاول الكتابة أصلًا.

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
      'E2E_BASE_URL غير مضبوط: مواصفة تنظيم الكتب قرائية لكنها تعمل بحساب إدارة، وتُمنع من العمل على الرابط الافتراضي (الإنتاج). اضبط E2E_BASE_URL على بيئة QA صراحةً.'
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

// طلبات كتابة حاولتها الصفحة نحو مسارات الوظائف قيد الاختبار (تُجهض فورًا وتُسجَّل).
const attemptedWrites: string[] = []

async function openBooksWorkspace(page: Page) {
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
  // حارس الكتابة القرائية: يُسجّل ويُجهض أي كتابة نحو مسارات الكتب/الامتحانات/الأسئلة.
  await page.route('**/api/**', async (route) => {
    const req = route.request()
    const watched = /\/(books|exams|questions|question-bank)/.test(new URL(req.url()).pathname)
    if (watched && !['GET', 'HEAD', 'OPTIONS'].includes(req.method())) {
      attemptedWrites.push(`${req.method()} ${req.url()}`)
      await route.abort()
      return
    }
    await route.continue()
  })
  await page.goto('/admin', { waitUntil: 'domcontentloaded' })
  expect(new URL(page.url()).origin, 'the browser must stay on the gated QA origin').toBe(QA_ORIGIN)
  await waitForAdminReady(page)
  const booksTab = page.getByRole('tab', { name: /الكتب والاختبارات/ }).first()
  if (!(await booksTab.isVisible().catch(() => false))) {
    await page.getByText('العملية الأكاديمية').first().click().catch(() => {})
  }
  await booksTab.click()
  await expect(page.getByText('جاهزية البرنامج الأكاديمية').or(page.getByText('نوع البرنامج / الدرجة'))).toBeVisible({ timeout: 30_000 })
}

const comboboxes = (page: Page) => page.locator('button[role="combobox"]')

async function pickOption(page: Page, triggerIndex: number, optionIndex: number): Promise<string> {
  await comboboxes(page).nth(triggerIndex).click()
  const options = page.getByRole('option')
  await expect(options.first()).toBeVisible({ timeout: 15_000 })
  const count = await options.count()
  if (optionIndex >= count) {
    throw new Error(`بيانات QA غير كافية: المطلوب خيار رقم ${optionIndex + 1} في القائمة ${triggerIndex + 1} والمتاح ${count} فقط — جهّز بيانات الاختبار كما في ترويسة المواصفة.`)
  }
  const label = (await options.nth(optionIndex).innerText()).trim()
  await options.nth(optionIndex).click()
  return label
}

// اختيار أول درجة وأول برنامج فيها (برنامج A). يعيد نص بانر الربط الخاص بالبرنامج.
async function chooseFirstProgram(page: Page): Promise<string> {
  await pickOption(page, 0, 0) // الدرجة
  const programLabel = await pickOption(page, 1, 0) // البرنامج
  await expect(page.getByText(/الكتب والامتحانات ستُربط تحديداً بـ/)).toBeVisible({ timeout: 30_000 })
  return programLabel
}

async function gotoBooksCurrent(page: Page) {
  await page.getByRole('tab', { name: /الكتب\/الإضافة\/AI/ }).first().click()
  await page.getByRole('tab', { name: /الكتب الحالية/ }).first().click()
  await expect(page.getByPlaceholder(/ابحث بالعربية أو الإنجليزية/)).toBeVisible({ timeout: 30_000 })
}

const bookToggles = (page: Page) => page.locator('button[id^="book-toggle-"]')
const visibleDetails = (page: Page) => page.locator('[id^="book-details-"]:not([hidden])')

// انتظار اكتمال تحميل كتب البرنامج الحالي فعليًا: قائمة الكتب (أو حالة الفراغ) ظاهرة
// والشبكة هادئة. بلا هذا الانتظار قد «ينجح» فحص غياب التفاصيل أثناء التحميل نفسه،
// حيث لا شيء مرسوم أصلًا — وهو نجاح زائف لا يثبت انتهاء الاختيار.
async function waitForBooksSettled(page: Page) {
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
  await expect(
    page.locator('.aact-scroll').or(page.getByText('لا توجد كتب مقررة لهذا التخصص بعد')).first()
  ).toBeVisible({ timeout: 30_000 })
}

async function countOptions(page: Page, triggerIndex: number): Promise<number> {
  await comboboxes(page).nth(triggerIndex).click()
  const options = page.getByRole('option')
  await expect(options.first()).toBeVisible({ timeout: 15_000 })
  const count = await options.count()
  await page.keyboard.press('Escape')
  return count
}

// اكتشاف قرائي لبرنامج مؤهل (كتابان على الأقل وأحدهما يحتاج مصدر قراءة): يمسح الدرجات
// والبرامج بالترتيب ويتوقف عند أول مؤهل؛ يفشل بصوت عالٍ إن لم يوجد أي مؤهل.
async function findQualifyingProgram(page: Page) {
  const categoryCount = await countOptions(page, 0)
  let scanned = 0
  for (let c = 0; c < categoryCount; c++) {
    await pickOption(page, 0, c)
    const programCount = await countOptions(page, 1)
    for (let p = 0; p < programCount; p++) {
      if (++scanned > 12) {
        throw new Error('بيانات QA: مسح الاكتشاف تجاوز 12 برنامجًا دون العثور على برنامج مؤهل (كتابان على الأقل وأحدهما يحتاج مصدر قراءة).')
      }
      await pickOption(page, 1, p)
      await expect(page.getByText(/الكتب والامتحانات ستُربط تحديداً بـ/)).toBeVisible({ timeout: 30_000 })
      await gotoBooksCurrent(page)
      await waitForBooksSettled(page)
      const books = await bookToggles(page).count()
      const needy = await page.getByText('يحتاج مصدر قراءة', { exact: true }).count()
      if (books >= 2 && needy >= 1) return
    }
  }
  throw new Error('بيانات QA غير كافية: لا يوجد برنامج مؤهل (كتابان على الأقل وأحدهما «يحتاج مصدر قراءة») في أي درجة — جهّز واحدًا كما في ترويسة المواصفة.')
}

// درجة فيها برنامجان على الأقل وأولهما فيه كتاب: يفتح تفاصيل أول كتاب في البرنامج الأول
// ويترك المشهد جاهزًا لسيناريوَي التبديل (نجاح التحميل وفشله).
async function openFirstBookInTwoProgramCategory(page: Page) {
  const categoryCount = await countOptions(page, 0)
  for (let c = 0; c < categoryCount; c++) {
    await pickOption(page, 0, c)
    if ((await countOptions(page, 1)) < 2) continue
    await pickOption(page, 1, 0)
    await expect(page.getByText(/الكتب والامتحانات ستُربط تحديداً بـ/)).toBeVisible({ timeout: 30_000 })
    await gotoBooksCurrent(page)
    await waitForBooksSettled(page)
    if ((await bookToggles(page).count()) < 1) continue
    await bookToggles(page).nth(0).click()
    await expect(visibleDetails(page)).toHaveCount(1)
    return
  }
  throw new Error('بيانات QA غير كافية: لا درجة فيها برنامجان أولهما فيه كتاب واحد على الأقل.')
}

async function expectNoWrites() {
  expect(attemptedWrites, `read-only spec attempted writes: ${attemptedWrites.join(' | ')}`).toEqual([])
}

test.describe('books workspace organization (QA, read-only)', () => {
  test.beforeAll(() => {
    QA_ORIGIN = assertQaEnvironment()
  })

  test.beforeEach(async ({ page }) => {
    attemptedWrites.length = 0
    await loginAsAdmin(page)
    await openBooksWorkspace(page)
  })

  test.afterEach(async () => {
    await expectNoWrites()
  })

  test('navigation keeps the chosen program across all eight workspaces', async ({ page }) => {
    await chooseFirstProgram(page)
    const banner = await page.getByText(/الكتب والامتحانات ستُربط تحديداً بـ/).innerText()
    for (const name of [/نظرة عامة/, /بنك المعرفة/, /الوحدات/, /أدلة الدراسة/, /الواجبات/, /مركز التصحيح/, /الامتحانات/]) {
      await page.getByRole('tab', { name }).first().click()
      await expect(page.getByRole('tab', { name }).first()).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByText(/الكتب والامتحانات ستُربط تحديداً بـ/)).toHaveText(banner)
    }
    await gotoBooksCurrent(page)
    for (const sub of [/الكتب الحالية/, /إضافة كتاب/, /توليد\/اقتراح كتب AI/]) {
      await expect(page.getByRole('tab', { name: sub }).first()).toBeVisible()
    }
  })

  test('books start collapsed and only one detail opens at a time', async ({ page }) => {
    await findQualifyingProgram(page)
    const toggles = bookToggles(page)
    const count = await toggles.count()
    if (count < 2) throw new Error(`بيانات QA غير كافية: برنامج الاختبار فيه ${count} كتاب — يلزم كتابان على الأقل لهذا السيناريو.`)
    await expect(visibleDetails(page)).toHaveCount(0)
    await toggles.nth(0).click()
    await expect(visibleDetails(page)).toHaveCount(1)
    await expect(toggles.nth(0)).toHaveAttribute('aria-expanded', 'true')
    await toggles.nth(1).click()
    await expect(visibleDetails(page)).toHaveCount(1)
    await expect(toggles.nth(0)).toHaveAttribute('aria-expanded', 'false')
    await expect(toggles.nth(1)).toHaveAttribute('aria-expanded', 'true')
    await toggles.nth(1).click()
    await expect(visibleDetails(page)).toHaveCount(0)
  })

  test('search exclusion terminates the open book and clearing the search does not resurrect it', async ({ page }) => {
    await findQualifyingProgram(page)
    const toggles = bookToggles(page)
    if ((await toggles.count()) < 1) throw new Error('بيانات QA غير كافية: لا كتب في برنامج الاختبار.')
    await toggles.nth(0).click()
    await expect(visibleDetails(page)).toHaveCount(1)
    const search = page.getByPlaceholder(/ابحث بالعربية أو الإنجليزية/)
    await search.fill('ZZZ-QA-NO-SUCH-BOOK-987654')
    await expect(page.getByText(/لا توجد نتائج مطابقة/)).toBeVisible()
    await expect(visibleDetails(page)).toHaveCount(0)
    await search.fill('')
    await expect(toggles.first()).toBeVisible()
    await expect(visibleDetails(page)).toHaveCount(0)
    await expect(toggles.nth(0)).toHaveAttribute('aria-expanded', 'false')
  })

  test('unsaved source link and picked file survive collapse and reopen', async ({ page }) => {
    await findQualifyingProgram(page)
    // كتاب يحتاج مصدر قراءة: شارته ظاهرة في الملخص حتى قبل الفتح.
    const needyCard = page.locator('div', { has: page.getByText('يحتاج مصدر قراءة', { exact: true }) }).filter({ has: page.locator('button[id^="book-toggle-"]') }).last()
    if ((await page.getByText('يحتاج مصدر قراءة', { exact: true }).count()) === 0) {
      throw new Error('بيانات QA غير كافية: لا كتاب «يحتاج مصدر قراءة» في برنامج الاختبار — جهّز واحدًا كما في ترويسة المواصفة.')
    }
    const toggle = needyCard.locator('button[id^="book-toggle-"]').first()
    await toggle.click()
    const detail = page.locator('[id^="book-details-"]:not([hidden])')
    await expect(detail).toHaveCount(1)
    const linkInput = detail.getByPlaceholder(/رابط PDF\/TXT\/HTML/)
    await expect(linkInput).toBeVisible()
    const draftUrl = 'https://example.com/qa-draft-source.pdf'
    await linkInput.fill(draftUrl)
    const fileInput = detail.locator('input[type="file"]')
    await fileInput.setInputFiles({ name: 'qa-draft.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 qa-draft') })
    await expect(detail.getByText('qa-draft.pdf')).toBeVisible()
    await toggle.click()
    await expect(visibleDetails(page)).toHaveCount(0)
    await toggle.click()
    await expect(detail).toHaveCount(1)
    await expect(linkInput).toHaveValue(draftUrl)
    await expect(detail.getByText('qa-draft.pdf')).toBeVisible()
  })

  test('switching programs clears the previous book selection', async ({ page }) => {
    await openFirstBookInTwoProgramCategory(page)
    const openId = await bookToggles(page).nth(0).getAttribute('id')
    // بدّل للبرنامج الثاني وانتظر اكتمال تحميله فعليًا قبل أي فحص — الفحص أثناء
    // التحميل لا يثبت شيئًا لأن التفاصيل غير مرسومة أصلًا في تلك اللحظة.
    await pickOption(page, 1, 1)
    await expect(page.getByText(/الكتب والامتحانات ستُربط تحديداً بـ/)).toBeVisible({ timeout: 30_000 })
    await gotoBooksCurrent(page)
    await waitForBooksSettled(page)
    await expect(visibleDetails(page)).toHaveCount(0)
    // كتاب البرنامج الأول نفسه (بنفس معرّف الزر) لا وجود له في قائمة الجديد.
    if (openId) await expect(page.locator(`button[id="${openId}"]`)).toHaveCount(0)
    const newToggles = bookToggles(page)
    if ((await newToggles.count()) > 0) {
      await expect(newToggles.nth(0)).toHaveAttribute('aria-expanded', 'false')
    }
  })

  test('a failed load on program switch never shows the previous book detail', async ({ page }) => {
    await openFirstBookInTwoProgramCategory(page)
    const openId = await bookToggles(page).nth(0).getAttribute('id')
    // أجهض طلب كتب البرنامج التالي فقط (طلب قراءة — حارس الكتابة لا علاقة له به):
    // التحميل سيفشل، وستبقى كتب البرنامج الأول محمّلة كما هي (سلوك تحميل سابق).
    await page.route('**/api/admin/books**', (route) => route.abort())
    await pickOption(page, 1, 1)
    await expect(page.getByText(/الكتب والامتحانات ستُربط تحديداً بـ/)).toBeVisible({ timeout: 30_000 })
    await gotoBooksCurrent(page)
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    // رغم بقاء القائمة القديمة مرسومة، لا تفصيل مفتوحًا، وزر الكتاب القديم نفسه
    // (ما زال موجودًا في القائمة العتيقة) مطويّ — الاختيار مات لحظة التبديل.
    await expect(visibleDetails(page)).toHaveCount(0)
    if (openId) {
      await expect(page.locator(`button[id="${openId}"]`)).toHaveAttribute('aria-expanded', 'false')
    }
  })

  test('responsive layout has no page-level horizontal scroll on phone or desktop', async ({ page }) => {
    await chooseFirstProgram(page)
    await gotoBooksCurrent(page)
    for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize(viewport)
      await page.waitForTimeout(300)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
      expect(overflow, `horizontal overflow at ${viewport.width}px`).toBeLessThanOrEqual(1)
      await expect(page.getByRole('tab', { name: /الكتب\/الإضافة\/AI/ }).first()).toBeVisible()
      if ((await bookToggles(page).count()) > 0) {
        await expect(bookToggles(page).first()).toBeVisible()
      }
    }
  })
})
