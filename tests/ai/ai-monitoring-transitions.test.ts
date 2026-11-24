/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// Step 8 (addition a) — transitions log: every auto<->manual switch is
// recorded in the system settings PATCH handler (src/app/api/admin/
// system/route.ts) when AI_AUTO_MODE_ENABLED changes value, stored in
// the NEW Setting key AI_AUTO_MODE_TRANSITIONS as a JSON array of
// { at, from, to }, capped at 20 entries, newest first. The toggle UI
// in AdminSystemTab saves through this PATCH, so recording there covers
// it; the dashboard (GET /api/admin/ai-monitoring) returns the log.
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
  },
  emailLog: { findMany: async () => [] },
  aiPipelineOperationLog: { findMany: async () => [] },
}

mock.module('@/lib/db', () => ({ db }))
// Sandbox note: the Prisma client is NOT generated here (node_modules
// has no .prisma/client), so any route importing '@prisma/client' at
// runtime fails to load — the pre-existing alborihi-admin-system test
// fails identically. The system route uses Prisma only for the
// TransactionIsolationLevel enum value (POST paths) and type positions,
// so the test stubs that one runtime value. CI (generated client) is
// the arbiter for the real import.
mock.module('@prisma/client', () => ({
  Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
}))
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

const { PATCH } = await import('../../src/app/api/admin/system/route')
const { GET } = await import('../../src/app/api/admin/ai-monitoring/route')
const autoMode = await import('../../src/lib/ai-auto-mode')

function patchRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/admin/system', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function transitions(): Array<{ at: string; from: string; to: string }> {
  return JSON.parse(settings.get('AI_AUTO_MODE_TRANSITIONS') || '[]')
}

beforeEach(() => {
  settings.clear()
})

describe('transitions log pure helpers', () => {
  test('parse drops invalid rows and caps at 20', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`, from: 'manual', to: 'auto' }))
    const parsed = autoMode.parseAutoModeTransitions(JSON.stringify([
      ...rows,
      { at: 'not-a-date', from: 'manual', to: 'auto' },
      { at: '2026-01-01T00:00:00.000Z', from: 'sideways', to: 'auto' },
      'garbage',
    ]))
    expect(parsed).toHaveLength(20)
    expect(parsed[0].to).toBe('auto')
    expect(autoMode.parseAutoModeTransitions('garbage')).toEqual([])
    expect(autoMode.parseAutoModeTransitions('')).toEqual([])
  })

  test('record prepends newest-first, caps at 20, and ignores a no-op', () => {
    // Newest first, as stored: 2026-01-20 down to 2026-01-01.
    const before = Array.from({ length: 20 }, (_, i) => ({
      at: `2026-01-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`, from: 'manual' as const, to: 'auto' as const,
    }))
    const next = autoMode.recordAutoModeTransition(before, 'auto', 'manual', Date.parse('2026-11-24T18:00:00.000Z'))
    expect(next).toHaveLength(20)
    expect(next[0]).toEqual({ at: '2026-11-24T18:00:00.000Z', from: 'auto', to: 'manual' })
    // The oldest entry (2026-01-01) was dropped by the cap.
    expect(next.some((entry) => entry.at.startsWith('2026-01-01'))).toBe(false)
    expect(autoMode.recordAutoModeTransition(before, 'auto', 'auto')).toEqual(before)
  })
})

describe('system PATCH records transitions', () => {
  test('flip manual -> auto records one transition', async () => {
    const response = await PATCH(patchRequest({ AI_AUTO_MODE_ENABLED: '1' }))
    expect(response.status).toBe(200)
    expect(settings.get('AI_AUTO_MODE_ENABLED')).toBe('1')
    const log = transitions()
    expect(log).toHaveLength(1)
    expect(log[0].from).toBe('manual')
    expect(log[0].to).toBe('auto')
    expect(Number.isFinite(Date.parse(log[0].at))).toBe(true)
  })

  test('second flip records another, newest first', async () => {
    await PATCH(patchRequest({ AI_AUTO_MODE_ENABLED: '1' }))
    await PATCH(patchRequest({ AI_AUTO_MODE_ENABLED: '0' }))
    expect(settings.get('AI_AUTO_MODE_ENABLED')).toBe('0')
    const log = transitions()
    expect(log).toHaveLength(2)
    expect(log[0]).toMatchObject({ from: 'auto', to: 'manual' })
    expect(log[1]).toMatchObject({ from: 'manual', to: 'auto' })
    expect(Date.parse(log[0].at) >= Date.parse(log[1].at)).toBe(true)
  })

  test('saving the same value again records nothing', async () => {
    await PATCH(patchRequest({ AI_AUTO_MODE_ENABLED: '1' }))
    expect(transitions()).toHaveLength(1)
    const second = await PATCH(patchRequest({ AI_AUTO_MODE_ENABLED: '1' }))
    expect(second.status).toBe(200)
    expect(transitions()).toHaveLength(1)
  })

  test('a save without the toggle key records nothing', async () => {
    const response = await PATCH(patchRequest({ AI_ROUTER_POLICY: 'balanced' }))
    expect(response.status).toBe(200)
    expect(settings.has('AI_AUTO_MODE_TRANSITIONS')).toBe(false)
  })

  test('a rejected save records nothing', async () => {
    // An invalid repair-model value is rejected before any write.
    const response = await PATCH(patchRequest({ AI_KNOWLEDGE_REPAIR_PROVIDER: 'GEMINI', AI_KNOWLEDGE_REPAIR_MODEL: 'bad model!' }))
    expect(response.status).toBe(400)
    expect(settings.has('AI_AUTO_MODE_TRANSITIONS')).toBe(false)
    expect(settings.has('AI_AUTO_MODE_ENABLED')).toBe(false)
  })

  test('log caps at 20 entries: the oldest switch drops off', async () => {
    // Newest first, as stored: 2026-01-20 down to 2026-01-01.
    const seeded = Array.from({ length: 20 }, (_, i) => ({
      at: `2026-01-${String(20 - i).padStart(2, '0')}T00:00:00.000Z`,
      from: i % 2 === 0 ? 'manual' : 'auto',
      to: i % 2 === 0 ? 'auto' : 'manual',
    }))
    settings.set('AI_AUTO_MODE_ENABLED', '0')
    settings.set('AI_AUTO_MODE_TRANSITIONS', JSON.stringify(seeded))
    const response = await PATCH(patchRequest({ AI_AUTO_MODE_ENABLED: '1' }))
    expect(response.status).toBe(200)
    const log = transitions()
    expect(log).toHaveLength(20)
    expect(log[0]).toMatchObject({ from: 'manual', to: 'auto' })
    expect(log.some((entry) => entry.at.startsWith('2026-01-01'))).toBe(false)
    expect(log[log.length - 1].at).toBe('2026-01-02T00:00:00.000Z')
  })
})

describe('dashboard returns the transitions newest-first', () => {
  test('GET surfaces the log recorded by PATCH', async () => {
    await PATCH(patchRequest({ AI_AUTO_MODE_ENABLED: '1' }))
    await PATCH(patchRequest({ AI_AUTO_MODE_ENABLED: '0' }))
    const body = await (await GET()).json()
    expect(body.mode).toEqual({ auto: false, value: '0' })
    expect(body.transitions).toHaveLength(2)
    expect(body.transitions[0]).toMatchObject({ from: 'auto', to: 'manual' })
    expect(body.transitions[1]).toMatchObject({ from: 'manual', to: 'auto' })
  })
})
