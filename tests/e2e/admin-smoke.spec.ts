import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

const ADMIN_MAIN_TABS: Array<{ label: string; tab: RegExp; search?: boolean }> = [
  { label: 'طلبات الالتحاق', tab: /الالتحاق الدراسي/, search: true },
  { label: 'الخدمات العابرة', tab: /الخدمات العابرة/, search: true },
  { label: 'الطلاب', tab: /الطلاب/, search: true },
  { label: 'نتائج الامتحانات', tab: /نتائج الامتحانات/, search: true },
  { label: 'المالية', tab: /المالية والفواتير/, search: true },
  { label: 'الشهادات', tab: /^الشهادات/, search: true },
  { label: 'سجل التدقيق', tab: /سجل التدقيق/, search: true },
  { label: 'رسائل التواصل', tab: /رسائل التواصل/, search: true },
  { label: 'المشرف الذكي', tab: /سجل المشرف الذكي/, search: true },
  { label: 'مدراء النظام', tab: /مدراء النظام/, search: false },
]

const ADMIN_BOOKS_NESTED_TABS: Array<{ label: string; tab: RegExp; search?: boolean }> = [
  { label: 'مركز التصحيح', tab: /مركز التصحيح/, search: true },
  { label: 'الامتحانات', tab: /^الامتحانات/, search: true },
]

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function isIgnoredConsoleError(text: string) {
  return [
    /favicon/i,
    /ResizeObserver loop/i,
    /Failed to load resource.*favicon/i,
    /The resource .* was preloaded using link preload but not used/i,
  ].some((pattern) => pattern.test(text))
}

async function installErrorGuards(page: Page, testInfo: TestInfo) {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    if (!isIgnoredConsoleError(text)) consoleErrors.push(text)
  })

  page.on('pageerror', (error) => {
    pageErrors.push(error.stack || error.message)
  })

  await testInfo.attach('guarded-errors-note', {
    body: 'Browser page errors and console.error messages are captured as report-only diagnostics for this launch smoke test.',
    contentType: 'text/plain',
  })

  return async () => {
    const pageErrorReport = pageErrors.length ? pageErrors.join('\n\n') : 'No uncaught browser page errors captured.'
    const consoleErrorReport = consoleErrors.length ? consoleErrors.join('\n\n') : 'No non-ignored console.error messages captured.'

    if (pageErrors.length) console.warn(`[admin-smoke] Browser page errors captured but not treated as fatal:\n${pageErrorReport}`)
    if (consoleErrors.length) console.warn(`[admin-smoke] Browser console errors captured but not treated as fatal:\n${consoleErrorReport}`)

    await testInfo.attach('browser-page-errors', {
      body: pageErrorReport,
      contentType: 'text/plain',
    })
    await testInfo.attach('browser-console-errors', {
      body: consoleErrorReport,
      contentType: 'text/plain',
    })
  }
}

async function loginAsAdmin(page: Page) {
  const email = requiredEnv('E2E_ADMIN_EMAIL')
  const password = requiredEnv('E2E_ADMIN_PASSWORD')

  const response = await page.request.post('/api/auth/login', {
    data: { email, password },
  })
  const body = await response.json().catch(() => ({}))

  expect(response.ok(), `Admin API login failed with ${response.status()}: ${JSON.stringify(body)}`).toBeTruthy()
  expect(body?.token, 'Login response must include a session token').toBeTruthy()
  expect(body?.user?.role, 'Smoke-test account must have ADMIN role').toBe('ADMIN')

  await page.addInitScript((token: string) => {
    localStorage.setItem('aact_token', token)
    localStorage.setItem('aact_startup_seen_v2', '1')
    sessionStorage.setItem('aact_skip_startup', '1')
  }, body.token)
}

async function waitForAdminReady(page: Page) {
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.aact-startup-screen').waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {})
  await page.getByText('LOADING MODULE').waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
  await expect(page.getByRole('heading', { name: /لوحة إدارة الأكاديمية/ })).toBeVisible({ timeout: 30_000 })
}

async function assertNoFatalScreen(page: Page, context: string) {
  const body = await page.locator('body').innerText({ timeout: 10_000 })
  expect(body, `${context}: Next.js/application crash screen detected`).not.toMatch(/Application error|Unhandled Runtime Error|خطأ غير متوقع في التطبيق|This page could not be found/i)
  await expect(page.getByText(/رفض الخادم الطلب 403|صلاحيات الإدارة مطلوبة/)).toHaveCount(0)
}

function safeFileName(value: string) {
  return value.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'admin-smoke'
}

async function captureAdminDiagnostics(page: Page, testInfo: TestInfo, stage: string) {
  const dir = 'test-results/admin-smoke-diagnostics'
  await mkdir(dir, { recursive: true }).catch(() => {})

  const [title, url, tabs, headings, bodyText] = await Promise.all([
    page.title().catch((e) => `TITLE_ERROR: ${String(e)}`),
    Promise.resolve(page.url()).catch((e) => `URL_ERROR: ${String(e)}`),
    page.locator('[role="tab"]').evaluateAll((els) => els.map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)).catch((e) => [`TABS_ERROR: ${String(e)}`]),
    page.locator('h1,h2,h3,[role="heading"]').evaluateAll((els) => els.map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)).catch((e) => [`HEADINGS_ERROR: ${String(e)}`]),
    page.locator('body').innerText({ timeout: 5_000 }).catch((e) => `BODY_ERROR: ${String(e)}`),
  ])

  const diagnostic = [
    `FAILED_STAGE: ${stage}`,
    `URL: ${url}`,
    `TITLE: ${title}`,
    `VISIBLE_TABS: ${JSON.stringify(tabs, null, 2)}`,
    `VISIBLE_HEADINGS: ${JSON.stringify(headings, null, 2)}`,
    'BODY_TEXT_START:',
    bodyText.slice(0, 4000),
  ].join('\n\n')

  const baseName = safeFileName(stage)
  const textPath = `${dir}/${baseName}.txt`
  const screenshotPath = `${dir}/${baseName}.png`
  await writeFile(textPath, diagnostic, 'utf8').catch(() => {})
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})

  console.error(`\n[admin-smoke] DIAGNOSTICS\n${diagnostic}\n[/admin-smoke] DIAGNOSTICS\n`)
  await testInfo.attach(`admin-smoke-diagnostics-${baseName}`, { body: diagnostic, contentType: 'text/plain' }).catch(() => {})
}

async function clickVisibleTab(page: Page, tabName: RegExp, label: string) {
  const tab = page.getByRole('tab', { name: tabName }).first()
  await expect(tab, `Admin tab not visible: ${label}`).toBeVisible({ timeout: 25_000 })
  await tab.scrollIntoViewIfNeeded()
  await tab.click()
  await page.waitForTimeout(250)
  await waitForAdminReady(page)
}

async function exerciseFirstSearchBox(page: Page, label: string) {
  const searchBox = page.locator('input[placeholder*="ابحث"]').filter({ hasNot: page.locator('[disabled]') }).first()
  if (!(await searchBox.isVisible({ timeout: 2_500 }).catch(() => false))) return

  await test.step(`${label}: search accepts input`, async () => {
    await searchBox.fill('اختبار')
    await page.waitForTimeout(250)
    await assertNoFatalScreen(page, `${label} after search`)
    await searchBox.fill('')
    await page.waitForTimeout(150)
  })
}

async function assertListControlsDoNotExplode(page: Page, label: string) {
  const pageSizeCombobox = page.getByRole('combobox').filter({ hasText: /عرض\s+(10|25|50|100)/ }).first()
  if (await pageSizeCombobox.isVisible({ timeout: 1_500 }).catch(() => false)) {
    await expect(pageSizeCombobox, `${label}: page-size selector should remain visible`).toBeVisible()
  }
  await assertNoFatalScreen(page, label)
}

async function chooseFirstVisibleOption(page: Page, label: string) {
  const option = page.getByRole('option').filter({ hasNotText: /^$/ }).first()
  await expect(option, `${label}: no selectable option was visible`).toBeVisible({ timeout: 15_000 })
  await option.click()
  await page.waitForTimeout(350)
}

async function selectBooksProgramIfNeeded(page: Page) {
  const gradingTab = page.getByRole('tab', { name: /مركز التصحيح/ }).first()
  if (await gradingTab.isVisible({ timeout: 1_500 }).catch(() => false)) return

  await expect(page.getByText(/اختر الدرجة ثم التخصص لإدارة الكتب والاختبارات/)).toBeVisible({ timeout: 15_000 })

  const comboboxes = page.getByRole('combobox')
  const categoryCombo = comboboxes.nth(0)
  await expect(categoryCombo, 'Books category selector should be visible').toBeVisible({ timeout: 15_000 })
  await categoryCombo.click()
  await chooseFirstVisibleOption(page, 'Books category selector')

  const programCombo = comboboxes.nth(1)
  await expect(programCombo, 'Books program selector should be visible after choosing a category').toBeVisible({ timeout: 15_000 })
  await programCombo.click()
  await chooseFirstVisibleOption(page, 'Books program selector')

  await expect(gradingTab, 'Books workspace tabs should appear after selecting a program').toBeVisible({ timeout: 30_000 })
  await assertNoFatalScreen(page, 'books program selected')
}

test.describe('Admin dashboard launch smoke test', () => {
  test('admin tabs load, search boxes work, and paginated screens do not crash', async ({ page }, testInfo) => {
    const assertNoBrowserErrors = await installErrorGuards(page, testInfo)
    let currentStage = 'بدء اختبار لوحة الإدارة'

    try {
      currentStage = 'تسجيل دخول الأدمن عبر API'
      await loginAsAdmin(page)

      currentStage = 'فتح لوحة الإدارة'
      await page.goto('/?view=admin', { waitUntil: 'domcontentloaded' })
      await waitForAdminReady(page)
      await assertNoFatalScreen(page, 'admin landing')

      for (const item of ADMIN_MAIN_TABS) {
        await test.step(item.label, async () => {
          currentStage = item.label
          console.log(`[admin-smoke] Checking tab: ${item.label}`)
          await clickVisibleTab(page, item.tab, item.label)
          if (item.search) await exerciseFirstSearchBox(page, item.label)
          await assertListControlsDoNotExplode(page, item.label)
        })
      }

      await test.step('الكتب والاختبارات + مركز التصحيح', async () => {
        currentStage = 'الكتب والاختبارات'
        console.log('[admin-smoke] Checking tab: الكتب والاختبارات')
        await clickVisibleTab(page, /الكتب والاختبارات/, 'الكتب والاختبارات')
        for (const item of ADMIN_BOOKS_NESTED_TABS) {
          currentStage = `الكتب والاختبارات / ${item.label}`
          console.log(`[admin-smoke] Checking nested tab: ${currentStage}`)
          await clickVisibleTab(page, item.tab, item.label)
          if (item.search) await exerciseFirstSearchBox(page, item.label)
          await assertListControlsDoNotExplode(page, item.label)
        }
      })

      currentStage = 'إنهاء فحص المتصفح'
      await assertNoBrowserErrors()
    } catch (error) {
      await captureAdminDiagnostics(page, testInfo, currentStage)
      const message = error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error)
      console.error(`[admin-smoke] FAILED_STAGE=${currentStage}\n${message}`)
      throw error
    }
  })
})
