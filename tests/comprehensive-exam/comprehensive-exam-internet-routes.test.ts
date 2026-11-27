// Comprehensive exam — internet route against an in-memory fake DB.
// Real route code; only the DB/auth/audit and the search+generation
// libs are faked (those libs are unit-tested separately). The Tavily
// error class is re-exported by the mock so the route's instanceof
// check sees the same class the fake search throws.
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

let exams: any[] = []
let questions: any[] = []
let settings: { key: string; value: string; updatedAt: Date }[] = []
let qSeq = 0

let tavilyKey: string | null = 'tvly-test-key'
let searchResult: any = null
let searchError: Error | null = null
let searchCalls: any[] = []
let advancedSingleDomain = false
let generateResult: any = null
let generateError: any = null
let generateInput: any = null
let duringGeneration: (() => void) | undefined
let adminActive = true

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
  $queryRaw: async (_query: TemplateStringsArray, examId: string) => exams.filter((exam) => exam.id === examId),
  setting: {
    findUnique: async ({ where }: any) => where?.key === 'TAVILY_API_KEY'
      ? (tavilyKey ? { key: 'TAVILY_API_KEY', value: tavilyKey } : null)
      : settings.find((row) => row.key === where?.key) || null,
    findMany: async ({ where, take }: any) => settings.filter((row) =>
      row.key.startsWith(where?.key?.startsWith || '') &&
      (!where?.OR || where.OR.some((condition: any) => row.value.includes(condition.value.contains))),
    ).sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime()).slice(0, take),
    create: async ({ data }: any) => {
      if (settings.some((row) => row.key === data.key)) throw Object.assign(new Error('duplicate'), { code: 'P2002' })
      const row = { ...data, updatedAt: new Date() }
      settings.push(row)
      return row
    },
    updateMany: async ({ where, data }: any) => {
      const row = settings.find((item) => item.key === where.key && item.value === where.value)
      if (!row) return { count: 0 }
      row.value = data.value
      row.updatedAt = new Date()
      return { count: 1 }
    },
  },
  program: {
    findUnique: async ({ where }: any) => {
      if (where?.id === 'specialization-1') return { id: 'specialization-1', titleAr: 'الدكتوراه المهنية في إدارة الأعمال', category: 'DOCTORATE', units: [] }
      return where?.id === 'program-1' ? { id: 'program-1', titleAr: 'الشهادات التدريبية ومعادلة الخبرات' } : null
    },
  },
  comprehensiveExam: {
    findUnique: async ({ where }: any) => exams.find((x) => x.id === where?.id) || null,
  },
  comprehensiveExamQuestion: {
    count: async ({ where }: any) => questions.filter((q) =>
      (!where?.examId || q.examId === where.examId) &&
      (!where?.source || q.source === where.source) &&
      (!where?.sourceBookId || q.sourceBookId === where.sourceBookId) &&
      (!where?.status?.in || where.status.in.includes(q.status)),
    ).length,
    findMany: async ({ where, take }: any = {}) =>
      questions.filter((q) => !where?.examId || q.examId === where.examId).sort((a, b) => a.order - b.order).slice(0, take),
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
    if (input.searchDepth === 'advanced' && !advancedSingleDomain) {
      const searchNumber = searchCalls.length
      return { results: Array.from({ length: 3 }, (_, i) => ({
        title: `مصدر علمي ${searchNumber}-${i}`,
        url: `https://research${searchNumber}${i}.org/article/${searchNumber}-${i}`,
        content: 'دراسة أكاديمية تناقش منهجية تحليل الحالة المهنية ونتائج مقارنة البدائل في المؤسسات وقياس أثر القرارات المستندة إلى البيانات.',
      })), creditsUsed: 2 }
    }
    return searchResult
  },
}))
mock.module('@/lib/comprehensive-exam-internet', () => ({
  INTERNET_MAX_SEARCH_RESULTS: 10,
  buildSpecialtyInternetQuery: (topic: string, specialty: string) => `${topic} ${specialty}`,
  buildSpecialtyResearchQueries: (topic: string, specialty: string) => [
    `${topic} ${specialty} theories`, `${topic} ${specialty} research`, `${topic} ${specialty} cases`,
  ],
  suggestComprehensiveInternetPlan: async () => ({
    axes: [{ topic: 'الإدارة الاستراتيجية وتحليل البيئة التنافسية', origin: 'AI_SUGGESTION' },
      { topic: 'القيادة التحويلية والتغيير التنظيمي', origin: 'AI_SUGGESTION' }],
    basis: 'AI_SUGGESTION',
  }),
  diverseInternetEvidence: (groups: any[][]) => {
    const results: any[] = []
    const seen = new Set<string>()
    const domains = new Map<string, number>()
    for (const group of groups) for (const item of group) {
      const domain = new URL(item.url).hostname
      if (seen.has(item.url) || (domains.get(domain) || 0) >= 2) continue
      seen.add(item.url)
      domains.set(domain, (domains.get(domain) || 0) + 1)
      results.push(item)
    }
    return { results: results.slice(0, 12), distinctDomains: domains.size }
  },
  clampInternetQuestionCount: (v: unknown) => {
    const n = Number(v)
    if (!Number.isFinite(n)) return 5
    return Math.max(1, Math.min(10, Math.floor(n)))
  },
  internetSourceId: (topic: string) => `tavily:${String(topic || '').slice(0, 8)}`,
  generateInternetQuestions: async (_results: unknown, input: unknown) => {
    duringGeneration?.()
    generateInput = input
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

function seedExam(status = 'DRAFT', id = 'exam-1', specializationProgramId?: string) {
  const exam = { id, programId: 'program-1', specializationProgramId, title: 'امتحان شامل تجريبي', level: 'DOCTORATE', status, passScore: 60, durationMin: 120 }
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
  advancedSingleDomain = false
  generateResult = defaultGeneration()
  generateError = null
  generateInput = null
  duringGeneration = undefined
  delete process.env.TAVILY_API_KEY
})

describe('POST from-internet — happy path', () => {
  test('prepares an editable, unapproved specialty axis plan before searching', async () => {
    const examId = seedExam('DRAFT', 'exam-plan', 'specialization-1')
    const res = await route.POST(jsonReq(examId, { action: 'PLAN' }), ctx(examId))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.axes).toHaveLength(2)
    expect(body.needsReview).toBe(true)
    expect(searchCalls).toHaveLength(0)
    expect(questions).toHaveLength(0)
  })
  test('uses the actual specialization and refuses a broad degree-only query', async () => {
    const examId = seedExam('DRAFT', 'exam-specialty', 'specialization-1')
    const broad = await route.POST(jsonReq(examId, { topic: 'دكتوراه إدارة الأعمال DBA', count: 2 }), ctx(examId))
    expect(broad.status).toBe(422)
    expect((await broad.json()).code).toBe('ACADEMIC_TOPIC_REQUIRED')
    expect(searchCalls).toHaveLength(0)

    generateResult = defaultGeneration()
    const specialized = await route.POST(jsonReq(examId, { topic: 'الإدارة الاستراتيجية وتحليل المنافسة', count: 2 }), ctx(examId))
    expect(specialized.status).toBe(200)
    expect(generateInput.programTitleAr).toBe('الدكتوراه المهنية في إدارة الأعمال')
  })

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

  test('comprehensive mode searches with the specialty and does not refill an existing axis', async () => {
    const examId = seedExam('DRAFT', 'exam-specialty', 'specialization-1')
    const body = { mode: 'COMPREHENSIVE', topic: 'التحليل المالي واتخاذ القرارات الاستثمارية', count: 10, axisTarget: 2 }
    const first = await route.POST(jsonReq(examId, body), ctx(examId))
    expect(first.status).toBe(200)
    expect(generateInput.comprehensive).toBe(true)
    expect(generateInput.programLevel).toBe('DOCTORATE')
    expect(searchCalls[0].query).toContain('إدارة الأعمال')
    const firstBody = await first.json()
    expect(firstBody.axisRemaining).toBe(0)
    expect(firstBody.search.creditsUsed).toBe(6)
    expect(firstBody.search.researchDirections).toBe(3)
    expect(firstBody.search.distinctDomains).toBeGreaterThanOrEqual(3)
    const second = await route.POST(jsonReq(examId, body), ctx(examId))
    expect((await second.json()).skipped).toBe(true)
    expect(searchCalls).toHaveLength(3)
    expect(searchCalls.every((call) => call.searchDepth === 'advanced' && call.chunksPerSource === 3)).toBe(true)
    expect(questions).toHaveLength(2)
  })

  test('checks late questions and skips duplicates added while the model was running', async () => {
    const examId = seedExam()
    questions = Array.from({ length: 85 }, (_, i) => ({
      examId, order: i + 1, text: `سؤال إداري سابق رقم ${i + 1}`, status: 'APPROVED',
    }))
    const lastText = questions[84].text
    duringGeneration = () => questions.push({ examId, order: 86, text: generateResult.questions[0].text, status: 'PENDING_REVIEW' })
    const res = await route.POST(jsonReq(examId, { topic: 'مبادئ المحاسبة', count: 2 }), ctx(examId))
    expect(generateInput.previousQuestionTexts).toContain(lastText)
    expect(res.status).toBe(200)
    expect((await res.json()).imported).toBe(1)
    expect(questions.at(-1).order).toBe(87)
    expect(questions.at(-1).text).toBe(generateResult.questions[1].text)
  })

  test('a draft archived during generation receives no new questions', async () => {
    const examId = seedExam()
    duringGeneration = () => { exams[0].status = 'ARCHIVED' }
    const res = await route.POST(jsonReq(examId, { topic: 'مبادئ المحاسبة', count: 2 }), ctx(examId))
    expect(res.status).toBe(409)
    expect(questions).toHaveLength(0)
  })

  test('simultaneous internet batches share the last free slot', async () => {
    const examId = seedExam('DRAFT', 'exam-concurrent', 'specialization-1')
    questions = Array.from({ length: 99 }, (_, i) => ({ examId, order: i + 1, text: `سؤال ${i}`, status: 'APPROVED' }))
    // Model the database serialization of the final save transaction.
    let queue = Promise.resolve()
    const original = fakeDb.$transaction
    fakeDb.$transaction = (work: (tx: any) => Promise<any>) => {
      const result = queue.then(() => work(fakeDb))
      queue = result.then(() => undefined)
      return result
    }
    try {
      const body = { mode: 'COMPREHENSIVE', topic: 'التحليل المالي واتخاذ القرارات الاستثمارية', axisTarget: 10, count: 10 }
      const responses = await Promise.all([1, 2].map(() => route.POST(jsonReq(examId, body), ctx(examId))))
      const results = await Promise.all(responses.map((res) => res.json()))
      expect(results.map((r) => r.imported).sort()).toEqual([0, 1])
      expect(questions).toHaveLength(100)
    } finally {
      fakeDb.$transaction = original
    }
  })

  test('refuses to generate a specialty-wide exam from one repeated website', async () => {
    const examId = seedExam('DRAFT', 'exam-shallow', 'specialization-1')
    advancedSingleDomain = true
    const res = await route.POST(jsonReq(examId, { mode: 'COMPREHENSIVE', topic: 'التحليل المالي واتخاذ القرارات الاستثمارية', axisTarget: 10, count: 10 }), ctx(examId))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe('INADEQUATE_SOURCE_DIVERSITY')
    expect(questions).toHaveLength(0)
    expect(generateInput).toBeNull()
  })

  test('comprehensive mode respects the remaining 100 eligible-question slots', async () => {
    const examId = seedExam('DRAFT', 'exam-cap', 'specialization-1')
    questions = Array.from({ length: 99 }, (_, i) => ({ id: `old-${i}`, examId, order: i + 1, source: 'MANUAL', status: 'APPROVED' }))
    const res = await route.POST(jsonReq(examId, { mode: 'COMPREHENSIVE', topic: 'التحليل المالي واتخاذ القرارات الاستثمارية', axisTarget: 10, count: 10 }), ctx(examId))
    expect(res.status).toBe(200)
    expect(generateInput.count).toBe(1)
    expect((await res.json()).imported).toBe(1)
    expect(questions).toHaveLength(100)
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
