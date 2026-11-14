/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// «ترتيب المزودات الاحتياطية» (2026-10-30): Haris's manual provider order is
// literal law — routing policies must NOT reshuffle it. These tests pin the
// manual branch of providerOrder() and the zero-change legacy default.

const db: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: {
    upsert: async () => ({}),
    findUnique: async () => ({ count: 1 }),
  },
  setting: {
    findMany: async () => [],
    findUnique: async () => null,
    upsert: async () => ({}),
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/settings', () => ({ getSetting: async () => '' }))

const textAi = await import('../../src/lib/text-ai')
const { __testB2ProviderOrderForTests, __testParseProviderOrderForTests, __testPrimaryProviderOrder, __resetTextAiStateForTests } = textAi

// The manual chain for a saved [TOPTOOLS, OPENROUTER, GEMINI]: his three
// first, then every provider he did not list, in the coded primary order.
const COMPLETED_CHAIN = [
  'TOPTOOLS', 'OPENROUTER', 'GEMINI',
  'UNOROUTER', 'OPENAI', 'ANTHROPIC', 'ZAI', 'GROQ', 'RELAYROUTER',
  'DEEPINFRA', 'TOGETHER', 'OPENAI_COMPAT', 'ALBORIHI', 'MISTRAL',
  'CLOUDFLARE', 'APINEX', 'OXION',
]

describe('manual provider fallback order', () => {
  beforeEach(() => {
    __resetTextAiStateForTests()
  })

  test('parse drops unknown ids, AUTO and duplicates, and normalizes case', () => {
    expect(__testParseProviderOrderForTests('toptools, OPENROUTER,,toptools,NOPE,AUTO,GEMINI')).toEqual([
      'TOPTOOLS', 'OPENROUTER', 'GEMINI',
    ])
    expect(__testParseProviderOrderForTests('')).toEqual([])
    expect(__testParseProviderOrderForTests('AUTO')).toEqual([])
  })

  test('general chain walks the manual order literally — quality_first does not reshuffle it', () => {
    const order = __testB2ProviderOrderForTests({
      policy: 'quality_first',
      manualOrder: 'TOPTOOLS,OPENROUTER,GEMINI',
    })
    expect(order).toEqual(COMPLETED_CHAIN)
  })

  test('a concretely selected provider leads, then the manual order follows', () => {
    const order = __testB2ProviderOrderForTests({
      provider: 'ALBORIHI',
      manualOrder: 'TOPTOOLS,OPENROUTER',
    })
    expect(order.slice(0, 4)).toEqual(['ALBORIHI', 'TOPTOOLS', 'OPENROUTER', 'GEMINI'])
    expect(order).toHaveLength(17)
    expect(new Set(order).size).toBe(17)
  })

  test('fallback_only keeps its single-provider meaning under a manual order', () => {
    const order = __testB2ProviderOrderForTests({
      provider: 'TOPTOOLS',
      policy: 'fallback_only',
      manualOrder: 'GEMINI,OPENROUTER',
    })
    expect(order).toEqual(['TOPTOOLS'])
  })

  test('academic work: allowlist advances first in HIS relative order, and paid-first cannot jump the queue', () => {
    const order = __testB2ProviderOrderForTests({
      taskLevel: 'ACADEMIC_CRITICAL',
      allowlist: 'OPENROUTER:some/model,TOPTOOLS:top-tools-ai',
      providerTiers: 'GEMINI:PAID',
      paidFirst: true,
      manualOrder: 'GEMINI,TOPTOOLS,OPENROUTER',
    })
    // TOPTOOLS before OPENROUTER because that is HIS order (the allowlist
    // itself lists OPENROUTER first — the manual order wins), and GEMINI
    // stays third even though it is PAID with paidFirst on: no reshuffles.
    expect(order.slice(0, 4)).toEqual(['TOPTOOLS', 'OPENROUTER', 'GEMINI', 'UNOROUTER'])
    expect(order).toHaveLength(17)
  })

  test('balanced only rotates the start of his list, preserving his relative order', () => {
    const order = __testB2ProviderOrderForTests({
      policy: 'balanced',
      manualOrder: 'TOPTOOLS,OPENROUTER,GEMINI',
    })
    expect(order).toHaveLength(COMPLETED_CHAIN.length)
    const start = COMPLETED_CHAIN.indexOf(order[0])
    expect(start).toBeGreaterThanOrEqual(0)
    expect(order).toEqual([...COMPLETED_CHAIN.slice(start), ...COMPLETED_CHAIN.slice(0, start)])
  })

  test('switch OFF parks the saved order and restores the legacy policy ordering', () => {
    const order = __testB2ProviderOrderForTests({
      policy: 'quality_first',
      manualOrder: 'TOPTOOLS,OPENROUTER,GEMINI',
      manualOrderEnabled: false,
    })
    expect(order.slice(0, 5)).toEqual(['ANTHROPIC', 'OPENAI', 'GEMINI', 'UNOROUTER', 'OPENROUTER'])
  })

  test('switch OFF restores paid-first academic jumps; switch ON keeps his order on top', () => {
    const base = {
      policy: 'balanced' as const,
      taskLevel: 'ACADEMIC_CRITICAL' as const,
      allowlist: 'GROQ:gpt-oss-120b,ALBORIHI:claude-sonnet-5',
      providerTiers: 'ALBORIHI:PAID,GROQ:FREE',
      paidFirst: true,
      manualOrder: 'GROQ,ALBORIHI',
    }
    // ON (default): the allowlist pair walks in HIS order — GROQ first even
    // though ALBORIHI is the PAID one.
    expect(__testB2ProviderOrderForTests({ ...base })[0]).toBe('GROQ')
    __resetTextAiStateForTests()
    // OFF: the legacy paid-first jump is back — ALBORIHI leads.
    expect(__testB2ProviderOrderForTests({ ...base, manualOrderEnabled: false })[0]).toBe('ALBORIHI')
  })

  test('admin manual order can put Gemini first or reserve it after APINEX', () => {
    const geminiFirst = __testB2ProviderOrderForTests({ manualOrder: 'GEMINI,APINEX', policy: 'primary_first' })
    expect(geminiFirst.slice(0, 2)).toEqual(['GEMINI', 'APINEX'])
    const apinexFirst = __testB2ProviderOrderForTests({ manualOrder: 'APINEX,GEMINI', policy: 'primary_first' })
    expect(apinexFirst.slice(0, 2)).toEqual(['APINEX', 'GEMINI'])
  })

  test('no saved manual order keeps the legacy coded behavior bit-for-bit', () => {
    expect(__testB2ProviderOrderForTests({ policy: 'primary_first' })).toEqual(__testPrimaryProviderOrder())
    expect(__testB2ProviderOrderForTests({ policy: 'primary_first', manualOrder: '' })).toEqual(__testPrimaryProviderOrder())
  })
})

describe('administrator-registered OpenAI-compatible providers', () => {
  afterEach(() => {
    textAi.__setTextAiSettingStoreForTests(null)
    __resetTextAiStateForTests()
  })

  test('registry is isolated, validated and cannot overwrite built-in providers', () => {
    const id = 'CUSTOM_EXTRAA'
    const registry = JSON.stringify([
      { id, name: 'My Gateway', baseUrl: 'https://api.real-gateway.ai/v1', enabled: true, selectedModel: 'sample-model:free' },
      { id, name: 'Duplicate', baseUrl: 'https://api.real-gateway.ai/v1', enabled: true },
      { id: 'GEMINI', name: 'Built-in collision', baseUrl: 'https://api.real-gateway.ai/v1', enabled: true },
      { id: 'CUSTOM_LOCAL', name: 'Unsafe', baseUrl: 'http://127.0.0.1/v1', enabled: true },
    ])
    expect(textAi.parseCustomTextAiProviders(registry)).toEqual([{
      id, name: 'My Gateway', baseUrl: 'https://api.real-gateway.ai/v1', enabled: true, selectedModel: 'sample-model:free',
    }])
    expect(textAi.customTextAiKeySetting(id)).toBe('AI_CUSTOM_KEY_CUSTOM_EXTRAA')
    expect(textAi.isCustomTextAiProviderId('OPENAI')).toBe(false)
    expect(textAi.isCustomTextAiProviderId(id)).toBe(true)
  })

  test('custom URL validator blocks internal targets, HTTP and token-in-URL forms', () => {
    expect(textAi.normalizeCustomTextAiUrl('https://api.real-gateway.ai/v1/models')).toBe('https://api.real-gateway.ai/v1')
    for (const bad of [
      'http://api.real-gateway.ai/v1',
      'https://localhost/v1',
      'https://169.254.169.254/latest/meta-data',
      'https://user:password@api.real-gateway.ai/v1',
      'https://api.real-gateway.ai/v1?token=secret',
      'https://api.real-gateway.ai:8080/v1',
    ]) {
      expect(() => textAi.normalizeCustomTextAiUrl(bad)).toThrow()
    }
  })

  test('free model recognition requires declared zero input AND output pricing', () => {
    const free = textAi.__testCustomProviderFreeMetadataForTests
    expect(free({ pricing: { prompt: '0', completion: '0' } }, 'open-free-model')).toBe(true)
    expect(free({ is_free: true }, 'some-model')).toBe(true)
    expect(free({}, 'some-model:free')).toBe(true)
    expect(free({ pricing: { prompt: '0.00001', completion: '0' } }, 'paid-model')).toBe(false)
    expect(free({ pricing: { prompt: '0' } }, 'unverified-model')).toBe(false)
    // A misleading free suffix or provider flag MUST NOT override paid pricing.
    expect(free({ pricing: { prompt: '0.01', completion: '0.02' } }, 'example:free')).toBe(false)
    expect(free({ is_free: true, pricing: { prompt: '0.01', completion: '0' } }, 'example-free')).toBe(false)
    expect(free({ free: true, pricing: { prompt: '0' } }, 'example:free')).toBe(false)
    expect(free({ pricing: { prompt: 'free', completion: '0' } }, 'example:free')).toBe(false)
    expect(free({ pricing: { prompt: '0', completion: 'unknown' } }, 'example:free')).toBe(false)
    expect(free({ pricing: { prompt: 0, completion: 0 } }, 'zero-cost-model')).toBe(true)
    expect(free({ pricing: { prompt: '0e-6', completion: '0.000' } }, 'zero-cost-model')).toBe(true)
    expect(free({}, 'unknown-model')).toBe(false)
  })

  test('AUTO detects enabled custom provider keys without rewriting the legacy order', async () => {
    const id = 'CUSTOM_EXTRAA'
    const rows: Record<string, string> = {
      AI_TEXT_PROVIDER: 'AUTO',
      AI_CUSTOM_PROVIDERS: JSON.stringify([{ id, name: 'Gateway', baseUrl: 'https://api.real-gateway.ai/v1', enabled: true, selectedModel: 'sample:free' }]),
      [textAi.customTextAiKeySetting(id)]: 'test-custom-secret',
    }
    textAi.__setTextAiSettingStoreForTests({
      read: async (keys: string[]) => Object.fromEntries(keys.map((key) => [key, rows[key] || ''])),
      write: async () => {},
      delete: async () => {},
    })
    const enabled = await textAi.textAiDiagnostics()
    expect(enabled.keyCounts[id]).toBe(1)
    expect(enabled.activeProvider).toBe(id)
    expect(enabled.selectedProvider).toBe('AUTO')
    rows.AI_CUSTOM_PROVIDERS = JSON.stringify([{ id, name: 'Gateway', baseUrl: 'https://api.real-gateway.ai/v1', enabled: false, selectedModel: 'sample:free' }])
    const disabled = await textAi.textAiDiagnostics()
    expect(disabled.activeProvider).toBeNull()
  })

  test('deleting a registered provider removes only its model lists and resets its selections', () => {
    const id = 'CUSTOM_EXTRAA'
    const saved = {
      AI_TEXT_PROVIDER: id,
      AI_KNOWLEDGE_REPAIR_PROVIDER: id,
      AI_KNOWLEDGE_REPAIR_MODEL: 'special-free-model',
      AI_PROVIDER_FALLBACK_ORDER: `GEMINI,${id},OPENROUTER`,
      AI_ACADEMIC_ALLOWLIST: `GEMINI:gemini-3.8-flash,${id}:special-free-model,OPENAI:gpt-5`,
      AI_VERIFIER_PREFERRED: `${id}:special-free-model,GEMINI:gemini-3.8-flash`,
      AI_PROVIDER_TIERS: `GEMINI:FREE,${id}:FREE,OPENAI:PAID`,
    }
    const removed = textAi.settingsAfterCustomTextAiProviderDeletion(id, saved)
    expect(removed).toEqual({
      AI_TEXT_PROVIDER: 'AUTO',
      AI_KNOWLEDGE_REPAIR_PROVIDER: 'AUTO',
      AI_KNOWLEDGE_REPAIR_MODEL: '',
      AI_PROVIDER_FALLBACK_ORDER: 'GEMINI,OPENROUTER',
      AI_ACADEMIC_ALLOWLIST: 'GEMINI:gemini-3.8-flash,OPENAI:gpt-5',
      AI_VERIFIER_PREFERRED: 'GEMINI:gemini-3.8-flash',
      AI_PROVIDER_TIERS: 'GEMINI:FREE,OPENAI:PAID',
    })
    expect(saved.AI_TEXT_PROVIDER).toBe(id)
    const unrelated = textAi.settingsAfterCustomTextAiProviderDeletion(id, {
      AI_TEXT_PROVIDER: 'GEMINI',
      AI_PROVIDER_FALLBACK_ORDER: 'GEMINI,OPENROUTER',
      AI_KNOWLEDGE_REPAIR_PROVIDER: 'OPENAI',
      AI_KNOWLEDGE_REPAIR_MODEL: 'gpt-5',
      AI_PROVIDER_TIERS: 'GEMINI:FREE,OPENAI:PAID',
    })
    expect(unrelated).toEqual({
      AI_TEXT_PROVIDER: 'GEMINI',
      AI_PROVIDER_FALLBACK_ORDER: 'GEMINI,OPENROUTER',
      AI_KNOWLEDGE_REPAIR_PROVIDER: 'OPENAI',
      AI_KNOWLEDGE_REPAIR_MODEL: 'gpt-5',
      AI_PROVIDER_TIERS: 'GEMINI:FREE,OPENAI:PAID',
    })
    expect(() => textAi.settingsAfterCustomTextAiProviderDeletion('GEMINI', saved)).toThrow('INVALID_CUSTOM_PROVIDER_ID')
  })

  test('deletion is admin-gated, audited and atomic; existing providers have no delete button', () => {
    const code = readFileSync(new URL('../../src/app/api/admin/system/route.ts', import.meta.url), 'utf8')
    const ui = readFileSync(new URL('../../src/components/aact/AdminSystemTab.tsx', import.meta.url), 'utf8')
    expect(code).toContain("if (action === 'delete-custom-ai-provider')")
    expect(code).toContain('const admin = await requireAdmin()')
    expect(code).toContain('if (!isCustomTextAiProviderId(id))')
    expect(code).toContain('const cleanedSettings = await db.$transaction(async (tx) => {')
    expect(code).toContain('await tx.setting.deleteMany({ where: { key: customTextAiKeySetting(id) } })')
    expect(code).toContain('settingsAfterCustomTextAiProviderDeletion(id, before)')
    expect(code).toContain('AI_CUSTOM_PROVIDER_DELETED')
    expect(code).toContain('Prisma.TransactionIsolationLevel.Serializable')
    expect(ui).toContain('setCustomDeleteTarget(entry)')
    expect(ui).toContain('تأكيد حذف المزوّد')
    expect(ui).toContain('action: \'delete-custom-ai-provider\'')
    expect(ui).toContain('setTextModelCatalog((prev) => {')
    expect(ui).toContain('setForm((prev) => ({ ...prev, ...result.clearedSettings }))')
  })

  test('admin API uses encrypted storage and exposes only metadata; UI includes manual ordering', () => {
    const apiRoute = readFileSync(new URL('../../src/app/api/admin/system/route.ts', import.meta.url), 'utf8')
    const ui = readFileSync(new URL('../../src/components/aact/AdminSystemTab.tsx', import.meta.url), 'utf8')
    expect(apiRoute).toContain("if (action === 'save-custom-ai-provider')")
    expect(apiRoute).toContain('await assertPublicCustomTextAiUrl(')
    expect(apiRoute).toContain('const value = encryptSecret(key)')
    expect(apiRoute).toContain('customProviders: await adminCustomTextAiProviders()')
    expect(apiRoute).toContain("if (action === 'refresh-custom-ai-models')")
    expect(apiRoute).toContain("if (action === 'select-custom-ai-model')")
    expect(ui).toContain('allTextProviderChoices')
    expect(ui).toContain('...(data.customProviders || []).map((entry) => entry.id)')
    expect(ui).toContain('إضافة مزوّد ذكاء اصطناعي جديد')
    expect(ui).toContain('تحديث النماذج المجانية')
  })
})
