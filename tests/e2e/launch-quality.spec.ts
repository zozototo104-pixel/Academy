import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function loginAsAdmin(page: Page): Promise<string> {
  const email = requiredEnv('E2E_ADMIN_EMAIL')
  const password = requiredEnv('E2E_ADMIN_PASSWORD')
  const response = await page.request.post('/api/auth/login', { data: { email, password } })
  const body = await response.json().catch(() => ({}))
  expect(response.ok(), `Admin API login failed with ${response.status()}: ${JSON.stringify(body)}`).toBeTruthy()
  expect(body?.token, 'Login response must include a token').toBeTruthy()
  expect(body?.user?.role, 'Quality test account must have ADMIN role').toBe('ADMIN')
  await page.addInitScript((token: string) => {
    localStorage.setItem('aact_token', token)
    localStorage.setItem('aact_startup_seen_v2', '1')
    sessionStorage.setItem('aact_skip_startup', '1')
  }, body.token)
  return String(body.token)
}

function routeThreshold(path: string) {
  // حدود عملية لبيئة GitHub Actions + Vercel، وليست أرقام Lighthouse محلية.
  if (path === '/admin') return { domContentLoadedMs: 15_000, visibleMs: 25_000, totalMs: 35_000 }
  if (path === '/dashboard') return { domContentLoadedMs: 12_000, visibleMs: 20_000, totalMs: 28_000 }
  return { domContentLoadedMs: 8_000, visibleMs: 15_000, totalMs: 22_000 }
}

async function measureRoute(page: Page, path: string) {
  const threshold = routeThreshold(path)
  const started = Date.now()
  const response = await page.goto(path, { waitUntil: 'domcontentloaded', timeout: threshold.totalMs }).catch((e) => {
    throw new Error(`Navigation to ${path} failed: ${e?.message || e}`)
  })
  const domContentLoadedMs = Date.now() - started
  await page.locator('body').waitFor({ state: 'visible', timeout: threshold.visibleMs })
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
  const totalMs = Date.now() - started
  const bodyText = await page.locator('body').innerText({ timeout: 5_000 }).catch(() => '')
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    const paints = performance.getEntriesByType('paint').map((p) => ({ name: p.name, startTime: Math.round(p.startTime) }))
    return {
      nav: nav ? {
        domInteractive: Math.round(nav.domInteractive),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd),
        loadEventEnd: Math.round(nav.loadEventEnd),
        transferSize: nav.transferSize,
        encodedBodySize: nav.encodedBodySize,
        decodedBodySize: nav.decodedBodySize,
        responseStart: Math.round(nav.responseStart),
      } : null,
      paints,
    }
  })

  const status = response?.status() || 0
  const ok = status >= 200 && status < 400 && !/Application error|Unhandled Runtime Error|حدث خطأ مؤقت في عرض الصفحة|This page could not be found/i.test(bodyText)
  return {
    path,
    status,
    ok,
    domContentLoadedMs,
    totalMs,
    threshold,
    title: await page.title().catch(() => ''),
    bodySample: bodyText.slice(0, 500),
    metrics,
  }
}

function markdownReport(report: any) {
  const routes = report.routes.map((r: any) => `| ${r.path} | ${r.status} | ${r.domContentLoadedMs}ms | ${r.totalMs}ms | ${r.ok ? '✅' : '❌'} |`).join('\n')
  const probes = (report.ai?.probes || []).map((p: any) => `| ${p.kind} | ${p.ms || 0}ms | ${p.keywordScore ?? '—'}% | ${p.passed ? '✅' : '❌'} | ${String(p.replySample || p.reason || '').replace(/\|/g, '/').slice(0, 160)} |`).join('\n')
  return `# AACT Launch Quality Report\n\nGenerated: ${new Date().toISOString()}\n\n## Page speed\n\n| Route | HTTP | DOM ready | Total | OK |\n|---|---:|---:|---:|---|\n${routes}\n\n## AI / curriculum / thesis probes\n\nStatus: **${report.ai?.status || 'unknown'}** · Score: **${report.ai?.summary?.score ?? '—'}%**\n\n| Probe | Latency | Keyword score | Passed | Sample |\n|---|---:|---:|---|---|\n${probes || '| — | — | — | — | لا توجد probes |'}\n\n## Student context coverage\n\n\`\`\`json\n${JSON.stringify(report.ai?.studentContext || {}, null, 2)}\n\`\`\`\n\n## Voice readiness\n\n\`\`\`json\n${JSON.stringify(report.ai?.voiceReadiness || {}, null, 2)}\n\`\`\`\n`
}

test.describe('AACT launch quality suite', () => {
  test.setTimeout(240_000)

  test('pages are fast and AI knows student context, curriculum, thesis, and voice config', async ({ page }, testInfo: TestInfo) => {
    const token = await loginAsAdmin(page)
    const routesToMeasure = ['/', '/programs', '/apply', '/verify', '/admin', '/dashboard']
    const routes = []

    for (const path of routesToMeasure) {
      const result = await measureRoute(page, path)
      routes.push(result)
      console.log(`[launch-quality] ${path} status=${result.status} dom=${result.domContentLoadedMs}ms total=${result.totalMs}ms ok=${result.ok}`)
    }

    const readinessRes = await page.request.get('/api/admin/launch-quality', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const readiness = await readinessRes.json().catch(() => ({}))
    expect(readinessRes.ok(), `Launch quality readiness failed with ${readinessRes.status()}: ${JSON.stringify(readiness).slice(0, 800)}`).toBeTruthy()

    const runVoiceToken = process.env.E2E_RUN_VOICE_TOKEN === '1' || process.env.E2E_RUN_VOICE_TOKEN === 'true'
    const aiRes = await page.request.post('/api/admin/launch-quality', {
      headers: { Authorization: `Bearer ${token}` },
      data: { runAi: true, runVoiceToken },
      timeout: 160_000,
    })
    const ai = await aiRes.json().catch(() => ({}))

    const report = {
      generatedAt: new Date().toISOString(),
      baseURL: process.env.E2E_BASE_URL || '',
      routes,
      readiness,
      ai,
    }

    await mkdir('test-results/launch-quality', { recursive: true }).catch(() => {})
    const jsonPath = 'test-results/launch-quality/report.json'
    const mdPath = 'test-results/launch-quality/report.md'
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
    await writeFile(mdPath, markdownReport(report), 'utf8')
    await testInfo.attach('launch-quality-report-json', { path: jsonPath, contentType: 'application/json' })
    await testInfo.attach('launch-quality-report-md', { path: mdPath, contentType: 'text/markdown' })

    expect(aiRes.ok(), `Launch quality AI probe failed with ${aiRes.status()}: ${JSON.stringify(ai).slice(0, 1200)}`).toBeTruthy()

    for (const route of routes) {
      expect(route.ok, `Route ${route.path} returned status=${route.status} or displayed an error screen`).toBeTruthy()
      expect(route.domContentLoadedMs, `Route ${route.path} DOMContentLoaded is slow`).toBeLessThanOrEqual(route.threshold.domContentLoadedMs)
      expect(route.totalMs, `Route ${route.path} total visible/network time is slow`).toBeLessThanOrEqual(route.threshold.totalMs)
    }

    expect(ai.studentContext?.contextChars || 0, 'Supervisor context must contain enough student/curriculum/research data').toBeGreaterThan(500)
    expect(ai.summary?.hasUsefulContext, 'AI context must include useful student curriculum/research data').toBe(true)
    expect(ai.summary?.score || 0, `AI probe score is too low: ${JSON.stringify(ai.summary)}`).toBeGreaterThanOrEqual(75)
    expect(ai.voiceReadiness?.supervisor?.ok, 'Supervisor voice readiness must be OK').toBe(true)
    expect(ai.voiceReadiness?.discussion?.ok, 'Discussion voice readiness must be OK').toBe(true)
  })
})
