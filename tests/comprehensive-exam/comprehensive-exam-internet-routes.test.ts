// Comprehensive exam — internet route against an in-memory fake DB.
// Real route code; only the DB/auth/audit and the search+generation
// libs are faked (those libs are unit-tested separately). The Tavily
// error class is re-exported by the mock so the route's instanceof
// check sees the same class the fake search throws.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

let exams: any[] = []
let questions: any[] = []
let qSeq = 0

let tavilyKey: string | null = 'tvly-test-key'
let searchResult: any = null
let searchError: Error | null = null
let searchCalls: any[] = []
let generateResult: any = null
let generateError: any = null

class TestTavilySearchError extends Error {
  kind: string
  constructor(kind: string, message: string) {
    super(message)
    this.name = 'TavilySearchError'
    this.kind = kind
  }
}

const fakeDb: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(fakeDb),
  setting: {
    findUnique: async ({ where }: any) =>
      where?.key === 'TAVILY_API_KEY' && tavilyKey ? { key: 'TAVILY_API_KEY', value: tavilyKey } : null,
  },
  program: {
    findUnique: async ({ where }: any) =>
      where?.id === 'program-1' ? { id: 'program-1', titleAr: 'الماجستير المهني في إدارة الأعمال' } : null,
  },
  comprehensiveExam: {
    findUnique: async ({ where }: any) => exams.find((x) => x.id === where?.id) || null,
  },
  comprehensiveExamQuestion: {
    findMany: async ({ where }: any = {}) =>
      questions.filter((q) => !where?.examId || q.examId === where.examId).sort((a, b) => a.order - b.order),
    findFirst: async ({ where, orderBy }: any = {}) => {
      const rows = questions.filter((q) => !where?.examId || q.examId === where.examId)
      if (orderBy?.order === 'desc') rows.sort((a, b) => b.order - a.order)
      return rows[0] || null
    },
    createMany: async ({ data }: any) => {
      for (const row of data) {
        questions.push({ id: `q-${++qSeq}`, ...row, createdAt: new Date(), updatedAt: new Date() })
      }
      return { count: data.length }
    },
  },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'مدير الاختبار', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => null }))
mock.module('@/lib/tavily-search', () => ({
  TavilySearchError: TestTavilySearchError,
  searchTavily: async (input: any) => {
    searchCalls.push(input)
    if (searchError) throw searchError
    return searchResult
  },
}))
mock.module('@/lib/comprehensive-exam-internet', () => ({
  INTERNET_MAX_SEARCH_RESULTS: 10,
  clampInternetQuestionCount: (v: unknown) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return 5
    return Math.max(1, Math.min(10, Math.floor(n)))
  },
  internetSourceId: (topic: string) => `tavily:${String(topic || '').slice(0, 8)}`,
  generateInternetQuestions: async () => {
    if (generateError) throw generateError
    return generateResult
  },
}))

const route = await import('../../src/app/api/admin/comprehensive-exams/[id]/questions/from-internet/route')

function ctx(id: string): any {
  return { params: Promise.resolve({ id }) }
}

function jsonReq(examId: string, body: any) {
  return new NextRequest(new URL(`/api/admin/comprehensive-exams/${examId}/questions/from-internet`, 'http://localhost'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function seedExam(status = 'DRAFT', id = 'exam-1') {
  const exam = { id, programId: 'program-1', title: 'امتحان شامل تجريبي', status, passScore: 60, durationMin: 120 }
  exams.push(exam)
  return exam.id
}

function defaultSearch() {
  return {
    query: 'مبادئ المحاسبة',
    results: [
      { title: 'الأصول المتداولة', url: 'https://example.com/assets', content: 'الأصول المتداولة هي الموارد الاقتصادية التي تتوقع المنشأة تحويلها إلى نقد.' },
      { title: 'الالتزامات المتداولة', url: 'https://example.com/liabilities', content: 'الالتزامات المتداولة تستحق السداد خلال سنة مالية واحدة.' },
    ],
    creditsUsed: 1,
    responseTime: 1.2,
  }
}

function defaultGeneration() {
  return {
    questions: [
      {
        type: 'MCQ',
        text: 'أي مما يلي يُعد من الأصول المتداولة؟',
        options: ['النقدية', 'المباني', 'براءات الاختراع', 'الشهرة'],
        correctAnswer: '0',
        sourceEvidence: 'الأصول المتداولة هي الموارد الاقتصادية التي تتوقع المنشأة تحويلها إلى نقد.',
        sourceUrl: 'https://example.com/assets',
      },
      {
        type: 'TF',
        text: 'الالتزامات المتداولة تستحق السداد خلال سنة مالية واحدة.',
        options: ['صح', 'خطأ'],
        correctAnswer: '0',
        sourceEvidence: 'الالتزامات المتداولة تستحق السداد خلال سنة مالية واحدة.',
        sourceUrl: 'https://example.com/liabilities',
      },
    ],
    requested: 2,
    accepted: 2,
    rejected: [],
    rejectedCount: 0,
    provider: 'GEMINI',
    model: 'gemini-3.5-flash-lite',
    search: { resultsFound: 2, chunksUsed: 2 },
  }
}

beforeEach(() => {
  exams = []
  questions = []
  qSeq = 0
  tavilyKey = 'tvly-test-key'
  searchResult = defaultSearch()
  searchError = null
  searchCalls = []
  generateResult = defaultGeneration()
  generateError = null
  delete process.env.TAVILY_API_KEY
})

describe('POST from-internet — happy path', () => {
  test('saves PENDING_REVIEW questions with source AI_INTERNET, evidence and source url', async () => {
    const examId = seedExam()
    const res = await route.POST(jsonReq(examId, { topic: 'مبادئ المحاسبة', count: 2 }), ctx(examId))
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.source).toBe('AI_INTERNET')
    expect(data.imported).toBe(2)
    expect(data.requested).toBe(2)
    expect(data.search).toEqual({ topic: 'مبادئ المحاسبة', resultsFound: 2, chunksUsed: 2, creditsUsed: 1 })
    expect(searchCalls.length).toBe(1)
    expect(searchCalls[0].query).toBe('مبادئ المحاسبة')
    expect(searchCalls[0].apiKey).toBe('tvly-test-key')
    expect(questions.length).toBe(2)
    expect(questions[0].status).toBe('PENDING_REVIEW')
    expect(questions[0].source).toBe('AI_INTERNET')
    expect(questions[0].sourceBookId.startsWith('tavily:')).toBe(true)
    expect(questions[0].sourceEvidence.length).toBeGreaterThan(40)
    expect(questions[0].sourceUrl).toBe('https://example.com/assets')
    expect(questions[1].sourceUrl).toBe('https://example.com/liabilities')
    expect(questions[0].order).toBe(1)
    expect(questions[1].order).toBe(2)
  })
})

describe('POST from-internet — honest failure states', () => {
  test('no key → 422 TAVILY_KEY_MISSING, no search, nothing saved', async () => {
    tavilyKey = null
    const examId = seedExam()
    const res = await route.POST(jsonReq(examId, { topic: 'مبادئ المحاسبة', count: 2 }), ctx(examId))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('TAVILY_KEY_MISSING')
    expect(String(data.error)).toContain('Tavily')
    expect(searchCalls.length).toBe(0)
    expect(questions.length).toBe(0)
  })

  test('zero search results → 422 INTERNET_NO_RESULTS, nothing invented', async () => {
    searchResult = { query: 'موضوع غريب', results: [], creditsUsed: 1, responseTime: 0.5 }
    const examId = seedExam()
    const res = await route.POST(jsonReq(examId, { topic: 'موضوع غريب', count: 2 }), ctx(examId))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('INTERNET_NO_RESULTS')
    expect(questions.length).toBe(0)
  })

  test('search failure → 502 TAVILY_SEARCH_FAILED with the typed kind', async () => {
    searchError = new TestTavilySearchError('RATE_LIMIT', 'تجاوزت حد طلبات Tavily المؤقت')
    const examId = seedExam()
    const res = await route.POST(jsonReq(examId, { topic: 'مبادئ المحاسبة', count: 2 }), ctx(examId))
    expect(res.status).toBe(502)
    const data = await res.json()
    expect(data.code).toBe('TAVILY_SEARCH_FAILED')
    expect(data.tavilyErrorKind).toBe('RATE_LIMIT')
    expect(questions.length).toBe(0)
  })

  test('insufficient source from generation → 422, nothing saved', async () => {
    const err: any = new Error('مصادر غير كافية')
    err.code = 'INSUFFICIENT_SOURCE'
    generateError = err
    const examId = seedExam()
    const res = await route.POST(jsonReq(examId, { topic: 'مبادئ المحاسبة', count: 2 }), ctx(examId))
    expect(res.status).toBe(422)
    const data = await res.json()
    expect(data.code).toBe('INSUFFICIENT_SOURCE')
    expect(questions.length).toBe(0)
  })

  test('non-DRAFT exam → 409; empty topic → 400', async () => {
    const readyId = seedExam('READY', 'exam-ready')
    const resReady = await route.POST(jsonReq(readyId, { topic: 'مبادئ المحاسبة', count: 2 }), ctx(readyId))
    expect(resReady.status).toBe(409)
    const draftId = seedExam('DRAFT', 'exam-draft')
    const resEmpty = await route.POST(jsonReq(draftId, { topic: '   ', count: 2 }), ctx(draftId))
    expect(resEmpty.status).toBe(400)
    expect(questions.length).toBe(0)
  })
})
