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

async function installLongTaskCollector(page: Page) {
  await page.addInitScript(() => {
    ;(window as any).__aactLongTasks = []
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          ;(window as any).__aactLongTasks.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration })
        }
      })
      observer.observe({ type: 'longtask', buffered: true } as any)
      ;(window as any).__aactLongTaskObserver = observer
    } catch {}
  })
}

async function collectMetrics(page: Page, path: string) {
  const started = Date.now()
  const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
  const wallMs = Date.now() - started
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    const js = resources.filter((r) => /\.js(\?|$)/.test(r.name) || r.initiatorType === 'script')
    const css = resources.filter((r) => /\.css(\?|$)/.test(r.name) || r.initiatorType === 'css' || r.initiatorType === 'link')
    const images = resources.filter((r) => r.initiatorType === 'img' || /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(r.name))
    const sizeOf = (items: PerformanceResourceTiming[]) => items.reduce((sum, r) => sum + (r.transferSize || r.encodedBodySize || 0), 0)
    const longTasks = ((window as any).__aactLongTasks || []) as Array<{ duration: number }>
    const longTaskMs = Math.round(longTasks.reduce((sum, t) => sum + Math.max(0, Number(t.duration || 0) - 50), 0))
    return {
      domContentLoadedMs: nav ? Math.round(nav.domContentLoadedEventEnd - nav.startTime) : 0,
      loadEventMs: nav ? Math.round(nav.loadEventEnd - nav.startTime) : 0,
      resourceCount: resources.length,
      jsCount: js.length,
      cssCount: css.length,
      imageCount: images.length,
      jsKB: Math.round(sizeOf(js) / 1024),
      cssKB: Math.round(sizeOf(css) / 1024),
      imageKB: Math.round(sizeOf(images) / 1024),
      totalResourceKB: Math.round(sizeOf(resources) / 1024),
      longTaskMs,
      longTaskCount: longTasks.length,
    }
  })
  return {
    path,
    status: response?.status() || 0,
    ok: !!response?.ok(),
    wallMs,
    ...metrics,
  }
}

function md(report: any) {
  const rows = report.pages.map((p: any) => `| ${p.path} | ${p.status} | ${p.domContentLoadedMs}ms | ${p.wallMs}ms | ${p.longTaskMs}ms | ${p.jsKB}KB | ${p.totalResourceKB}KB | ${p.resourceCount} | ${p.ok ? '✅' : '❌'} |`).join('\n')
  return `# AACT Performance Guardrails Report\n\nGenerated: ${new Date().toISOString()}\n\n| Page | Status | DOM | Total | Long-task estimate | JS | Total resources | Count | Result |\n|---|---:|---:|---:|---:|---:|---:|---:|---|\n${rows}\n\n## Thresholds\n\n- Public DOMContentLoaded: <= 1800ms\n- Admin DOMContentLoaded: <= 2500ms\n- Total wall time: <= 9000ms\n- Estimated long-task blocking: <= 2200ms\n- JavaScript transfer: <= 6500KB per page\n- Resource count: <= 180 resources per page\n`
}

test.describe('AACT performance guardrails suite', () => {
  test.setTimeout(120_000)

  test('core pages stay responsive and avoid heavy JavaScript regressions', async ({ page }, testInfo: TestInfo) => {
    await installLongTaskCollector(page)

    const pages = ['/', '/programs', '/apply', '/verify']
    const results: any[] = []
    for (const path of pages) {
      const result = await collectMetrics(page, path)
      console.log(`[perf] ${path} status=${result.status} dom=${result.domContentLoadedMs}ms total=${result.wallMs}ms long=${result.longTaskMs}ms js=${result.jsKB}KB resources=${result.resourceCount}`)
      results.push(result)
      expect(result.ok, `${path} must respond successfully`).toBeTruthy()
      expect(result.domContentLoadedMs, `${path} DOMContentLoaded is too slow`).toBeLessThanOrEqual(1800)
      expect(result.wallMs, `${path} total wall time is too slow`).toBeLessThanOrEqual(9000)
      expect(result.longTaskMs, `${path} estimated blocking time is too high`).toBeLessThanOrEqual(2200)
      expect(result.jsKB, `${path} JavaScript transfer is too large`).toBeLessThanOrEqual(6500)
      expect(result.resourceCount, `${path} loads too many resources`).toBeLessThanOrEqual(180)
    }

    const adminLogin = await login(page, requiredEnv('E2E_ADMIN_EMAIL'), requiredEnv('E2E_ADMIN_PASSWORD'))
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.evaluate((token) => {
      localStorage.setItem('aact_token', token)
      localStorage.setItem('aact_startup_seen_v2', '1')
      sessionStorage.setItem('aact_skip_startup', '1')
    }, adminLogin.token)
    const adminResult = await collectMetrics(page, '/admin')
    console.log(`[perf] /admin status=${adminResult.status} dom=${adminResult.domContentLoadedMs}ms total=${adminResult.wallMs}ms long=${adminResult.longTaskMs}ms js=${adminResult.jsKB}KB resources=${adminResult.resourceCount}`)
    results.push(adminResult)
    expect(adminResult.ok, '/admin must respond successfully').toBeTruthy()
    expect(adminResult.domContentLoadedMs, '/admin DOMContentLoaded is too slow').toBeLessThanOrEqual(2500)
    expect(adminResult.wallMs, '/admin total wall time is too slow').toBeLessThanOrEqual(10000)
    expect(adminResult.longTaskMs, '/admin estimated blocking time is too high').toBeLessThanOrEqual(2600)
    expect(adminResult.jsKB, '/admin JavaScript transfer is too large').toBeLessThanOrEqual(7000)
    expect(adminResult.resourceCount, '/admin loads too many resources').toBeLessThanOrEqual(220)

    const report = { generatedAt: new Date().toISOString(), pages: results }
    await mkdir('test-results/performance-guardrails', { recursive: true }).catch(() => {})
    const jsonPath = 'test-results/performance-guardrails/report.json'
    const mdPath = 'test-results/performance-guardrails/report.md'
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
    await writeFile(mdPath, md(report), 'utf8')
    await testInfo.attach('performance-guardrails-report-json', { path: jsonPath, contentType: 'application/json' })
    await testInfo.attach('performance-guardrails-report-md', { path: mdPath, contentType: 'text/markdown' })
  })
})
