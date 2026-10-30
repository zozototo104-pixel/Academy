/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

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

  test('no saved manual order keeps the legacy coded behavior bit-for-bit', () => {
    expect(__testB2ProviderOrderForTests({ policy: 'primary_first' })).toEqual(__testPrimaryProviderOrder())
    expect(__testB2ProviderOrderForTests({ policy: 'primary_first', manualOrder: '' })).toEqual(__testPrimaryProviderOrder())
  })
})
