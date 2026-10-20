/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

const settings = new Map<string, string>()

const db: any = {
  setting: {
    findMany: async (args?: any) => {
      const allowed = new Set<string>(args?.where?.key?.in || [])
      return [...settings.entries()]
        .filter(([key]) => !allowed.size || allowed.has(key))
        .map(([key, value]) => ({ key, value }))
    },
    findUnique: async ({ where }: any) => settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
    upsert: async ({ where, create, update }: any) => {
      const key = where.key
      const value = String(update?.value ?? create?.value ?? '')
      settings.set(key, value)
      return { key, value }
    },
    create: async ({ data }: any) => {
      settings.set(data.key, data.value)
      return data
    },
    delete: async ({ where }: any) => {
      settings.delete(where.key)
      return { key: where.key }
    },
  },
  emailLog: { findMany: async () => [] },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => ({}) }))
mock.module('@/lib/mailer', () => ({
  sendEmail: async () => true,
  getSmtpConfig: async () => ({ enabled: false }),
  emailTemplate: (title: string, body: string) => `${title}\n${body}`,
}))
mock.module('@/lib/gemini', () => ({
  ensureGeminiKey: async () => {},
  hasGemini: () => false,
  invalidateGeminiKeyCache: () => {},
  normalizeGeminiModelName: (value: string) => value,
  geminiActiveLiveModel: async () => 'gemini-3.8-live',
  isValidGeminiLiveModel: () => true,
  geminiApiKey: async () => '',
  isQuotaError: () => false,
  isAuthError: () => false,
  isModelUnavailableError: () => false,
  isInvalidArgumentError: () => false,
  geminiKeyDiagnostics: async () => ({ source: 'none' }),
  geminiTestConnection: async () => ({ ok: false, error: 'not configured' }),
}))
mock.module('@/lib/open-source-llm', () => ({
  localAgentDiagnostics: async () => ({}),
  testLocalAgentConnection: async () => ({ ok: true, message: 'ok' }),
}))
mock.module('@/lib/payments', () => ({
  getGatewayConfig: async () => ({}),
  paymentDiagnostics: () => ({ mode: 'LIVE', trueGatewayCount: 0, usdtConfigured: false, usdtNetwork: '', errors: [] }),
}))
mock.module('@/lib/text-ai', () => ({
  textAiCheckAllModelHealth: async () => ({ checked: 0, results: [] }),
  textAiDiagnostics: async () => ({ message: 'ok', externalConfigured: false }),
  textAiFreeModelsForProvider: async (provider: string) => ({ provider, models: [], discoveredCount: 0, staticCount: 0, message: '' }),
  textAiModelHealthSnapshot: async () => [],
  textAiTestConnection: async () => ({ ok: true, provider: 'ALBORIHI', model: 'claude-sonnet-5', reply: 'ok' }),
}))
mock.module('@/lib/secret-crypto', () => ({
  clearSecretCache: () => {},
  decryptSecret: (value: string) => value,
  encryptSecret: (value: string) => `enc:${value}`,
  hasSecretEncryptionKey: () => true,
  isEncryptedSecret: (value: string) => value.startsWith('enc:'),
  isMaskedSecret: (value: string) => /^••••/.test(value),
  isSecretKeyName: (key: string) => /KEY|SECRET|TOKEN|CREDENTIAL|PASSWORD/i.test(key),
  redactDeep: (body: unknown) => body,
  redactSecrets: (value: string) => value,
  secretLast4: (value: string) => String(value || '').slice(-4),
}))

const { PATCH, POST } = await import('../../src/app/api/admin/system/route')

function request(body: Record<string, unknown>, method: 'PATCH' | 'POST' = 'PATCH') {
  return new NextRequest('http://localhost/api/admin/system', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  settings.clear()
})

describe('admin system Alborihi settings validation', () => {
  test('PATCH accepts ALBORIHI in AI_ACADEMIC_ALLOWLIST and AI_VERIFIER_PREFERRED', async () => {
    const allowlist = await PATCH(request({ AI_ACADEMIC_ALLOWLIST: 'GEMINI:gemini-3.8-flash,ALBORIHI:claude-sonnet-5' }))
    expect(allowlist.status).toBe(200)
    expect(settings.get('AI_ACADEMIC_ALLOWLIST')).toBe('GEMINI:gemini-3.8-flash,ALBORIHI:claude-sonnet-5')

    const verifier = await PATCH(request({ AI_VERIFIER_PREFERRED: 'ALBORIHI:gpt-5.6-luna' }))
    expect(verifier.status).toBe(200)
    expect(settings.get('AI_VERIFIER_PREFERRED')).toBe('ALBORIHI:gpt-5.6-luna')
  })

  test('PATCH rejects ALBORIHI:auto', async () => {
    const response = await PATCH(request({ AI_ACADEMIC_ALLOWLIST: 'ALBORIHI:auto' }))
    expect(response.status).toBe(400)
    expect(settings.has('AI_ACADEMIC_ALLOWLIST')).toBe(false)
  })

  test('POST add-academic-allowlist accepts ALBORIHI provider items', async () => {
    const response = await POST(request({ action: 'add-academic-allowlist', allowlistItem: 'ALBORIHI:claude-sonnet-5' }, 'POST'))
    expect(response.status).toBe(200)
    const payload = await response.json()
    expect(payload.allowlist).toContain('ALBORIHI:claude-sonnet-5')
  })
})
