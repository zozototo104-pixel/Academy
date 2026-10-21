import { describe, expect, test } from 'bun:test'
import { __testB2ProviderOrderForTests, __testPrimaryProviderOrder, __testStickyCandidateOrderForTests, modelFamily } from '../../src/lib/text-ai'
import { __testVerifierFamilyAllowedForTests } from '../../src/lib/question-verifier'

describe('router admin policy B2', () => {
  test('RANK_BY=provider preserves quality_first and cost_saver provider snapshots', () => {
    expect(__testB2ProviderOrderForTests({ policy: 'quality_first', rankBy: 'provider' }).slice(0, 5)).toEqual([
      'ANTHROPIC',
      'OPENAI',
      'GEMINI',
      'UNOROUTER',
      'OPENROUTER',
    ])
    expect(__testB2ProviderOrderForTests({ policy: 'cost_saver', rankBy: 'provider' }).slice(0, 5)).toEqual([
      'GROQ',
      'ZAI',
      'UNOROUTER',
      'OPENROUTER',
      'RELAYROUTER',
    ])
  })

  test('RANK_BY=family quality_first puts Claude-family gateways before Gemini and gpt-oss', () => {
    const order = __testB2ProviderOrderForTests({
      policy: 'quality_first',
      rankBy: 'family',
      topToolsModel: 'claude-x',
      alborihiModel: 'claude-sonnet-5',
      groqModel: 'gpt-oss-120b',
      geminiModel: 'gemini-3.8-flash',
    })

    expect(order.indexOf('ALBORIHI')).toBeLessThan(order.indexOf('GEMINI'))
    expect(order.indexOf('TOPTOOLS')).toBeLessThan(order.indexOf('GEMINI'))
    expect(order.indexOf('ALBORIHI')).toBeLessThan(order.indexOf('GROQ'))
    expect(order.indexOf('TOPTOOLS')).toBeLessThan(order.indexOf('GROQ'))
  })

  test('RANK_BY=family cost_saver puts gpt-oss before Claude', () => {
    const order = __testB2ProviderOrderForTests({
      policy: 'cost_saver',
      rankBy: 'family',
      alborihiModel: 'claude-sonnet-5',
      groqModel: 'gpt-oss-120b',
    })

    expect(order.indexOf('GROQ')).toBeLessThan(order.indexOf('ALBORIHI'))
  })

  test('PAID_FIRST applies only to academic tasks and keeps general routing unchanged', () => {
    const academic = __testB2ProviderOrderForTests({
      policy: 'balanced',
      taskLevel: 'ACADEMIC_CRITICAL',
      allowlist: 'GROQ:gpt-oss-120b,ALBORIHI:claude-sonnet-5',
      providerTiers: 'ALBORIHI:PAID,GROQ:FREE',
      paidFirst: true,
    })
    const general = __testB2ProviderOrderForTests({
      policy: 'balanced',
      providerTiers: 'ALBORIHI:PAID,GROQ:FREE',
      paidFirst: true,
    })

    expect(academic[0]).toBe('ALBORIHI')
    expect(general).toEqual(__testPrimaryProviderOrder())
  })

  test('PAID_FIRST=false preserves current academic allowlist order', () => {
    const order = __testB2ProviderOrderForTests({
      policy: 'balanced',
      taskLevel: 'ACADEMIC_CRITICAL',
      allowlist: 'GROQ:gpt-oss-120b,ALBORIHI:claude-sonnet-5',
      providerTiers: 'ALBORIHI:PAID,GROQ:FREE',
      paidFirst: false,
    })

    expect(order[0]).toBe('GROQ')
  })

  test('sticky keeps priority over paid-first ordering', () => {
    expect(__testStickyCandidateOrderForTests({
      stickyOnSuccess: true,
      provider: 'GROQ',
      model: 'gpt-oss-120b',
      key: 'key-a',
      candidates: ['claude-sonnet-5', 'gpt-oss-120b'],
    })).toEqual(['gpt-oss-120b', 'claude-sonnet-5'])
  })

  test('verifier still excludes a paid model from the same generator family', () => {
    expect(__testVerifierFamilyAllowedForTests(
      { provider: 'ALBORIHI', model: 'claude-sonnet-5' },
      'GROQ',
      modelFamily('claude-opus-4-6')
    )).toEqual({ ok: false, reason: 'VERIFIER_SAME_FAMILY' })
  })

  test('OPENAI_COMPAT keeps its existing tier logic when omitted from AI_PROVIDER_TIERS', () => {
    const order = __testB2ProviderOrderForTests({
      policy: 'balanced',
      taskLevel: 'ACADEMIC_CRITICAL',
      allowlist: 'GROQ:gpt-oss-120b,OPENAI_COMPAT:openai/gpt-oss-120b',
      providerTiers: 'GROQ:FREE',
      paidFirst: true,
      openaiCompatTier: 'PAID',
    })

    expect(order.indexOf('OPENAI_COMPAT')).toBeLessThan(order.indexOf('GROQ'))
  })
})
