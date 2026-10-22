import { describe, expect, mock, test } from 'bun:test'

mock.module('@/lib/db', () => ({ db: {} }))

const { __testApplyModelRestrictionForTests } = await import('../../src/lib/text-ai')

describe('D2.1b router restriction: restrictToModels is a true allowlist', () => {
  const restriction = [
    { provider: 'GEMINI' as const, model: 'gemini-ocr-a' },
    { provider: 'OPENAI' as const, model: 'gpt-vis' },
  ]

  test('only the listed models of the provider survive', () => {
    expect(__testApplyModelRestrictionForTests(['gemini-ocr-a', 'gemini-other', 'gemini-third'], 'GEMINI', restriction))
      .toEqual(['gemini-ocr-a'])
    expect(__testApplyModelRestrictionForTests(['gpt-vis', 'gpt-other'], 'OPENAI', restriction)).toEqual(['gpt-vis'])
  })

  test('a provider outside the list gets no candidates at all', () => {
    expect(__testApplyModelRestrictionForTests(['claude-x', 'claude-y'], 'ANTHROPIC', restriction)).toEqual([])
  })

  test('model matching is case-insensitive', () => {
    expect(__testApplyModelRestrictionForTests(['GEMINI-OCR-A'], 'GEMINI', restriction)).toEqual(['GEMINI-OCR-A'])
  })

  test('no restriction (or an empty one) leaves candidates untouched', () => {
    const models = ['a', 'b']
    expect(__testApplyModelRestrictionForTests(models, 'GEMINI', undefined)).toEqual(models)
    expect(__testApplyModelRestrictionForTests(models, 'GEMINI', [])).toEqual(models)
  })
})
