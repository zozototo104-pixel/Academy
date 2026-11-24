import { mock, describe, test, expect } from 'bun:test'

// The analyzer pulls the Prisma client at import time, and the sandbox has
// no generated client, so the database module is mocked here; the wrapper
// under test never touches the database. In CI the client is generated and
// the mock below only replaces the provider call itself.
mock.module('@/lib/db', () => ({ db: {} }))

let nextGemini: () => Promise<string> = async () => '{"items":[]}'
mock.module('@/lib/gemini', () => ({ geminiCompleteJson: async () => nextGemini() }))

const analyzer = await import('../../src/lib/book-chunk-analyzer')
const { callAnalysisAiWithExhaustedAsEmpty, isExhaustedBookBatchError, validateSourceBackedBookBatch } = analyzer

const NO_ITEMS = 'EMPTY_BATCH_AFTER_STRUCTURAL_VALIDATION:BOOK_KNOWLEDGE_NO_ITEMS'
const ALL_DUPLICATE = 'EMPTY_BATCH_AFTER_STRUCTURAL_VALIDATION:BOOK_KNOWLEDGE_ALL_DUPLICATE'
const NO_VERIFIED = 'EMPTY_BATCH_AFTER_STRUCTURAL_VALIDATION:BOOK_KNOWLEDGE_NO_VERIFIED_ITEMS'
const STAGE_EXHAUSTED = `GEMINI/gemini-3.5-flash-lite/key#1: ${NO_ITEMS} | APINEX/free/gpt-6-luna/key#1: ${ALL_DUPLICATE}`
const EXHAUSTED_WRAPPED = `BOOK_AI_PROVIDER_EXHAUSTED: STAGE=[${STAGE_EXHAUSTED}] GLOBAL=[GROQ/llama-3.3-70b-versatile/key#1: ${NO_ITEMS}]`
const MIXED_WRAPPED = `BOOK_AI_PROVIDER_EXHAUSTED: STAGE=[GEMINI/gemini-3.5-flash-lite/key#1: ${NO_ITEMS}] GLOBAL=[APINEX/free/gpt-6-luna/key#1: 429 Too Many Requests]`

const usage = { provider: null, model: null, fallbackUsed: false }

describe('exhausted book batch', () => {
  test('validate splits exhausted from broken batches', () => {
    const text = 'نص كتاب طويل بما يكفي ليُقبل كمصدر للمعرفة المستخرجة من صفحاته المتتابعة.'
    const chunkText = text.repeat(2)
    expect(() => validateSourceBackedBookBatch(JSON.stringify({ items: [] }), chunkText, [])).toThrow(/BOOK_KNOWLEDGE_NO_ITEMS/)
    expect(() => validateSourceBackedBookBatch(JSON.stringify({ items: [{ category: 'CONCEPT', title: 'x', summary: 'y', lineStart: 0, lineEnd: 2 }] }), chunkText, [])).toThrow(/BOOK_KNOWLEDGE_NO_VERIFIED_ITEMS/)
  })

  test('detector accepts only all-exhausted attempts', () => {
    expect(isExhaustedBookBatchError(new Error(NO_ITEMS))).toBe(true)
    expect(isExhaustedBookBatchError(new Error(STAGE_EXHAUSTED))).toBe(true)
    expect(isExhaustedBookBatchError(new Error(EXHAUSTED_WRAPPED))).toBe(true)
    expect(isExhaustedBookBatchError(new Error(MIXED_WRAPPED))).toBe(false)
    expect(isExhaustedBookBatchError(new Error(NO_VERIFIED))).toBe(false)
    expect(isExhaustedBookBatchError(new Error('TEXT_AI_ROUTER_FAILED'))).toBe(false)
    expect(isExhaustedBookBatchError(new Error('AI_ACADEMIC_PROVIDER_UNAVAILABLE'))).toBe(false)
  })

  test('all models agreeing on empty resolves to an empty batch', async () => {
    nextGemini = async () => { throw new Error(EXHAUSTED_WRAPPED) }
    const out = await callAnalysisAiWithExhaustedAsEmpty({} as any, null, { ...usage })
    expect(JSON.parse(out)).toEqual({ items: [] })
  })

  test('a lone exhausted error resolves to an empty batch', async () => {
    nextGemini = async () => { throw new Error(NO_ITEMS) }
    const out = await callAnalysisAiWithExhaustedAsEmpty({} as any, null, { ...usage })
    expect(JSON.parse(out)).toEqual({ items: [] })
  })

  test('a mixed failure still throws', async () => {
    nextGemini = async () => { throw new Error(MIXED_WRAPPED) }
    await expect(callAnalysisAiWithExhaustedAsEmpty({} as any, null, { ...usage })).rejects.toThrow('BOOK_AI_PROVIDER_EXHAUSTED')
  })

  test('a real provider failure still throws', async () => {
    nextGemini = async () => { throw new Error('INVALID_JSON_RESPONSE') }
    await expect(callAnalysisAiWithExhaustedAsEmpty({} as any, null, { ...usage })).rejects.toThrow('INVALID_JSON_RESPONSE')
  })

  test('a successful call passes through unchanged', async () => {
    nextGemini = async () => '{"items":[{"category":"CONCEPT"}]}'
    const out = await callAnalysisAiWithExhaustedAsEmpty({} as any, null, { ...usage })
    expect(JSON.parse(out)).toEqual({ items: [{ category: 'CONCEPT' }] })
  })
})
