import { defineConfig, devices } from '@playwright/test'

const configuredBaseURL =
  process.env.E2E_BASE_URL ||
  process.env.NEXTAUTH_URL ||
  process.env.VERCEL_PROJECT_PRODUCTION_URL ||
  process.env.VERCEL_URL ||
  'https://academy-raqaba.vercel.app'

const baseURL = configuredBaseURL.startsWith('http') ? configuredBaseURL : `https://${configuredBaseURL}`
const automationBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET

const extraHTTPHeaders: Record<string, string> = automationBypass
  ? {
      'x-vercel-protection-bypass': automationBypass,
      'x-vercel-set-bypass-cookie': 'true',
    }
  : {}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 70_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [
        ['list'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
        ['junit', { outputFile: 'test-results/admin-smoke.junit.xml' }],
      ]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    extraHTTPHeaders,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1366, height: 900 },
      },
    },
  ],
  outputDir: 'test-results',
})
