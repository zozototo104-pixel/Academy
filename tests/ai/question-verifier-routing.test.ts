import { describe, expect, test } from 'bun:test'
import { __testQuestionVerifierCandidatePlan, parseProviderModelList } from '../../src/lib/text-ai'

describe('question verifier preferred routing', () => {
  test('preferred verifier is used first when available', () => {
    const preferred = parseProviderModelList('OPENAI:gpt-5.1')
    const fallback = parseProviderModelList('ANTHROPIC:claude-sonnet-4-5-20250929')
    const plan = __testQuestionVerifierCandidatePlan({ preferred, fallback, generatorProvider: 'TOPTOOLS', generatorModel: 'DeepSeek-V4-Pro' })

    expect(plan.ordered[0]).toEqual({ provider: 'OPENAI', model: 'gpt-5.1' })
  })

  test('preferred verifier from the same generator family is skipped', () => {
    const preferred = parseProviderModelList('OPENAI:deepseek-r1')
    const fallback = parseProviderModelList('ANTHROPIC:claude-sonnet-4-5-20250929')
    const plan = __testQuestionVerifierCandidatePlan({ preferred, fallback, generatorProvider: 'TOPTOOLS', generatorModel: 'DeepSeek-V4-Pro' })

    expect(plan.ordered[0]).toEqual({ provider: 'ANTHROPIC', model: 'claude-sonnet-4-5-20250929' })
    expect(plan.diagnostics.some((line) => line.includes('SAME_FAMILY_AS_GENERATOR'))).toBe(true)
  })

  test('all preferred verifiers on cooldown fall back to normal candidates', () => {
    const preferred = parseProviderModelList('OPENAI:gpt-5.1,ANTHROPIC:claude-sonnet-4-5-20250929')
    const fallback = parseProviderModelList('GEMINI:gemini-2.5-pro')
    const plan = __testQuestionVerifierCandidatePlan({ preferred, fallback, cooldown: ['OPENAI:gpt-5.1', 'ANTHROPIC:claude-sonnet-4-5-20250929'] })

    expect(plan.ordered[0]).toEqual({ provider: 'GEMINI', model: 'gemini-2.5-pro' })
    expect(plan.diagnostics.filter((line) => line.includes('COOLDOWN')).length).toBe(2)
  })

  test('empty preferred verifier setting does not change fallback behavior', () => {
    const preferred = parseProviderModelList('')
    const fallback = parseProviderModelList('GEMINI:gemini-2.5-pro,OPENAI:gpt-5.1')
    const plan = __testQuestionVerifierCandidatePlan({ preferred, fallback })

    expect(plan.ordered).toEqual(fallback)
  })

  test('diagnostics include cooldown and no-balance reasons', () => {
    const preferred = parseProviderModelList('OPENAI:gpt-5.1,ANTHROPIC:claude-sonnet-4-5-20250929')
    const plan = __testQuestionVerifierCandidatePlan({ preferred, cooldown: ['OPENAI:gpt-5.1'], noBalance: ['ANTHROPIC'] })

    expect(plan.diagnostics.some((line) => line.includes('OPENAI:gpt-5.1 COOLDOWN'))).toBe(true)
    expect(plan.diagnostics.some((line) => line.includes('ANTHROPIC:claude-sonnet-4-5-20250929 NO_BALANCE'))).toBe(true)
  })
})
