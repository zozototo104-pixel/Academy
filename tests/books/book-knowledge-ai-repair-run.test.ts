import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'

// AI knowledge repair, end to end through runNextKnowledgeAiRepairStep:
// source recovery (linked chunk, stale link, garbled source via OCR),
// router validate failover (real router + stubbed HTTP), exhaustion
// behaviour, and the real counters the admin reads. Real scheduler code
// against an in-memory fake DB; no production records are touched.
const S1 = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة واتخاذ القرارات.'
const S2 = 'تعرف الأصول المتداولة بأنها الموارد التي تتوقع المنشأة تحويلها إلى نقد خلال دورة التشغيل العادية.'
const S3 = 'يقيس قائمة المركز المالي حقوق الملكية بعد خصم الالتزامات من إجمالي الأصول في تاريخ محدد.'
const S4 = 'تعتمد القوائم المالية على مبدأ الاستحقاق في إثبات الإيرادات والمصروفات عند تحققها.'
const S5 = 'يركز التسويق الحديث على فهم احتياجات العملاء وبناء علاقات طويلة الأمد معهم.'
const S6 = 'تدرس بحوث التسويق سلوك المستهلك لتحديد الشرائح المستهدفة وتصميم المنتجات المناسبة لها.'
const S7 = 'يقسم التسويق السوق إلى شرائح وفق خصائص العملاء وسلوك الشراء لديهم.'
const S8 = 'تعتمد الحملات التسويقية على رسائل واضحة تصل إلى الشرائح المستهدفة عبر القنوات المناسبة.'
const regionA = [S1, S2, S3, S4].map((s) => `${s} `.repeat(12)).join(' ')
const regionB = [S5, S6, S7, S8].map((s) => `${s} `.repeat(12)).join(' ')
const bigChunkText = `${regionA} ${regionB}`
const garbledExcerpt = `${'□ '.repeat(60)}الأصول المتداولة في القوائم المالية.`
const goodAnswer = JSON.stringify({ title: S2, summary: `${S1} ${S2}`, excerpt: S3 })
const marketingAnswer = JSON.stringify({ title: S6, summary: `${S5} ${S6}`, excerpt: S6 })

const cleanOcr = `${S1} ${S2} ${S3} ${S4}`
const garbledChunkText = `${'□ '.repeat(300)}${S1} ${'א ב ג '.repeat(60)}`

let settingsStore = new Map<string, string>()
let items: any[] = []
let chunks: any[] = []
let books: any[] = []
let repairJobs: any[] = []
let ocrCalls: { pages: number[] }[] = []
let ocrImpl: (buffer: Buffer, pages: number[]) => Promise<{ page: number; text: string }[]> =
  async (_buffer, pages) => pages.map((page) => ({ page, text: cleanOcr }))

const values = new Map<string, string>()
const originalFetch = globalThis.fetch
const MOCK_APINEX_TOKEN = 'test-apinex-token'
const APINEX_BASE_URL = 'https://api.apinex.bond/v1'
const APINEX_FREE_MODELS = ['free/gemini-3.8-flash', 'free/deepseek-v4.1-flash']

function matches(row: any, where: any): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    const value = row[key]
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date)) {
      if ('in' in cond) return (cond.in as unknown[]).includes(value)
      if ('gt' in cond) return value > cond.gt
      if ('gte' in cond) return value >= cond.gte
      if ('lte' in cond) return value <= cond.lte
      if ('contains' in cond) return typeof value === 'string' && value.includes(cond.contains)
      if ('startsWith' in cond) return typeof value === 'string' && value.startsWith(cond.startsWith)
      if ('not' in cond) return cond.not === null ? value !== null : value !== cond.not
      return false
    }
    if (cond === null) return value === null || value === undefined
    return value === cond
  })
}

const fakeDb: any = {
  aiUsageLog: { create: async () => ({}) },
  user: { findUnique: async () => null },
  keyRateWindow: { upsert: async () => ({}), findUnique: async () => ({ count: 1 }) },
  setting: {
    findMany: async ({ where, take }: any) => {
      let rows = [...settingsStore.entries()].map(([key, value]) => ({ key, value, updatedAt: new Date(0) }))
      if (where?.key?.startsWith) rows = rows.filter((r) => r.key.startsWith(where.key.startsWith))
      else if (where?.key?.in) rows = rows.filter((r) => where.key.in.includes(r.key))
      else return []
      return take ? rows.slice(0, take) : rows
    },
    findUnique: async ({ where }: any) => {
      const value = settingsStore.get(where.key)
      return value === undefined ? null : { key: where.key, value }
    },
    findUniqueOrThrow: async ({ where }: any) => {
      const value = settingsStore.get(where.key)
      if (value === undefined) throw new Error('NOT_FOUND')
      return { key: where.key, value }
    },
    updateMany: async ({ where, data }: any) => {
      const current = settingsStore.get(where.key)
      if (current === undefined) return { count: 0 }
      if (where.value !== undefined && current !== where.value) return { count: 0 }
      settingsStore.set(where.key, data.value)
      return { count: 1 }
    },
    upsert: async ({ where, create, update }: any) => {
      if (!settingsStore.has(where.key)) settingsStore.set(where.key, create.value)
      else if (update.value !== undefined) settingsStore.set(where.key, update.value)
      return { key: where.key, value: settingsStore.get(where.key) }
    },
    create: async ({ data }: any) => { settingsStore.set(data.key, data.value); return data },
  },
  bookKnowledgeItem: {
    findMany: async ({ where, take }: any) => {
      const rows = items.filter((row) => matches(row, where)).sort((a, b) => (a.id < b.id ? -1 : 1))
      return (take ? rows.slice(0, take) : rows).map((row) => ({ ...row }))
    },
    updateMany: async ({ where, data }: any) => {
      const row = items.find((r) => matches(r, where))
      if (!row) return { count: 0 }
      Object.assign(row, data, { updatedAt: new Date() })
      return { count: 1 }
    },
  },
  bookChunk: {
    findFirst: async ({ where }: any) => {
      const row = chunks.find((c) => matches(c, where))
      return row ? { ...row } : null
    },
    findMany: async ({ where, take }: any) => {
      const rows = chunks.filter((c) => matches(c, where)).sort((a, b) => a.index - b.index)
      return (take ? rows.slice(0, take) : rows).map((row) => ({ ...row }))
    },
  },
  book: { findUnique: async ({ where }: any) => books.find((b) => b.id === where.id) || null },
  bookRepairJob: { findFirst: async ({ where }: any) => repairJobs.find((j) => matches(j, where)) || null },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/book-reader', () => ({
  transcribeScannedDocumentWithVision: async (buffer: Buffer, pages: number[]) => {
    ocrCalls.push({ pages: [...pages] })
    return ocrImpl(buffer, pages)
  },
}))
mock.module('@/lib/storage', () => ({
  getFileBufferFromStorageOrBase64: async () => ({ buffer: Buffer.from('%PDF-1.4 fake'), mimeType: 'application/pdf' }),
}))
mock.module('@/lib/settings', () => ({
  getSetting: async (key: string) => values.get(key) || '',
  getSettings: async () => Object.fromEntries(values),
  getSettingNum: async (key: string) => Number(values.get(key) || 0),
  getSettingJson: async (_key: string, fallback: unknown) => fallback,
}))

const scheduler = await import('../../src/lib/book-knowledge-v2-scheduler')
const textAi = await import('../../src/lib/text-ai')

function makeStore(backing: Map<string, string>) {
  return {
    async read(keys: string[]) { return Object.fromEntries(keys.map((key) => [key, backing.get(key) || ''])) },
    async write(key: string, value: string) { backing.set(key, value) },
    async delete(key: string) { backing.delete(key) },
    async scan(prefix: string) { return Object.fromEntries([...backing.entries()].filter(([key]) => key.startsWith(prefix))) },
    async increment(key: string, amount: number) {
      const next = (Number(backing.get(key) || 0) || 0) + amount
      backing.set(key, String(next))
      return next
    },
  }
}
const store = makeStore(values)

function seedJob(patch: any = {}) {
  const job = {
    programId: 'prog-1', status: 'QUEUED', cursor: '', scanned: 0, repaired: 0,
    needsReview: 0, missingSource: 0, garbledSource: 0, unlocatableSource: 0,
    rejectedCorrections: 0, rejectionReasons: {}, ocrRereads: 0, ocrRereadFailed: 0,
    attempts: 0, lastError: null, leaseToken: null, leaseUntil: null, ...patch,
  }
  settingsStore.set('KNOWLEDGE_AI_REPAIR_JOB:prog-1', JSON.stringify(job))
}

function seedConfig(provider = 'AUTO', model = '', calls = '10', interval = '0') {
  settingsStore.set('AI_KNOWLEDGE_REPAIR_PROVIDER', provider)
  settingsStore.set('AI_KNOWLEDGE_REPAIR_MODEL', model)
  settingsStore.set('AI_KNOWLEDGE_REPAIR_INTERVAL_SECONDS', interval)
  settingsStore.set('AI_KNOWLEDGE_REPAIR_CALLS_PER_RUN', calls)
}

function readJob() {
  return JSON.parse(settingsStore.get('KNOWLEDGE_AI_REPAIR_JOB:prog-1')!)
}

function makeItem(id: string, patch: any = {}) {
  return {
    id, programId: 'prog-1', bookId: 'book-1', chunkId: 'chunk-1', textProvenance: null,
    category: 'CONCEPT', kbVersion: 2,
    title: 'الأصول المتداولة وقياسها في القوائم المالية',
    summary: S2, excerpt: garbledExcerpt, pageStart: 1, pageEnd: 2,
    createdAt: new Date(0), updatedAt: new Date(0), ...patch,
  }
}

function makeChunk(id: string, patch: any = {}) {
  return {
    id, bookId: 'book-1', programId: 'prog-1', index: 0,
    text: `${S1} ${S2} ${S3} ${S4}`, textProvenance: 'NATIVE_TEXT',
    contentHash: 'hash-1', status: 'ANALYZED', pageStart: 1, pageEnd: 2, ...patch,
  }
}

beforeEach(() => {
  settingsStore = new Map()
  items = []
  chunks = []
  books = [{ id: 'book-1', programId: 'prog-1', title: 'كتاب اختبار', storageProvider: 'TEST', storageKey: 'k', fileUrl: null, data: null, mimeType: 'application/pdf' }]
  repairJobs = []
  ocrCalls = []
  ocrImpl = async (_buffer, pages) => pages.map((page) => ({ page, text: cleanOcr }))
  values.clear()
  globalThis.fetch = originalFetch
  delete process.env.APINEX_API_KEYS
  delete process.env.APINEX_API_KEY
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
  seedConfig()
  seedJob()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  textAi.__setTextAiSettingStoreForTests(null)
  delete process.env.APINEX_API_KEYS
  delete process.env.APINEX_API_KEY
})

describe('runNextKnowledgeAiRepairStep with injected AI', () => {
  test('no enqueued job means no AI call at all (AI stays opt-in)', async () => {
    settingsStore.delete('KNOWLEDGE_AI_REPAIR_JOB:prog-1')
    let called = 0
    const result = await scheduler.runNextKnowledgeAiRepairStep({ completeJson: async () => { called++; return goodAnswer } })
    expect(result.status).toBe('NO_JOB')
    expect(called).toBe(0)
  })

  test('a linked chunk with a garbled excerpt is repaired from its own region', async () => {
    chunks = [makeChunk('chunk-1', { text: bigChunkText, contentHash: 'hash-big', pageStart: 1, pageEnd: 9 })]
    items = [makeItem('item-a', {
      title: 'سلوك المستهلك والشرائح المستهدفة في التسويق الحديث',
      summary: `${S5} ${S6}`,
      pageStart: 5, pageEnd: 9,
    })]
    let seenEvidence = ''
    const result = await scheduler.runNextKnowledgeAiRepairStep({
      completeJson: async (opts: any) => {
        seenEvidence = JSON.parse(String(opts.history[0].text)).sourceText
        return marketingAnswer
      },
    })
    expect(result.status).toBe('COMPLETED')
    expect(result.repaired).toBe(1)
    expect(seenEvidence).toContain(S6)
    expect(seenEvidence).not.toContain(S1)
    const saved = items[0]
    expect(saved.id).toBe('item-a')
    expect(saved.chunkId).toBe('chunk-1')
    expect(saved.title).toBe(S6)
    expect(saved.excerpt).toBe(S6)
    expect(readJob().repaired).toBe(1)
  })

  test('an EXTRACTED chunk with healthy text is usable (status is not the evidence)', async () => {
    chunks = [makeChunk('chunk-1', { status: 'EXTRACTED' })]
    items = [makeItem('item-a')]
    const result = await scheduler.runNextKnowledgeAiRepairStep({ completeJson: async () => goodAnswer })
    expect(result.repaired).toBe(1)
    expect(items[0].title).toBe(S2)
  })

  test('a garbled source triggers an OCR re-read and repairs from it; the chunk row is untouched', async () => {
    chunks = [makeChunk('chunk-1', { text: garbledChunkText, contentHash: 'hash-garbled' })]
    items = [makeItem('item-a')]
    const result = await scheduler.runNextKnowledgeAiRepairStep({ completeJson: async () => goodAnswer })
    expect(result.repaired).toBe(1)
    expect(result.ocrRereads).toBe(1)
    expect(result.ocrRereadFailed).toBe(0)
    expect(result.garbledSource).toBe(0)
    expect(ocrCalls).toEqual([{ pages: [1, 2] }])
    expect(chunks[0].text).toBe(garbledChunkText)
    expect(chunks[0].contentHash).toBe('hash-garbled')
    expect(items[0].title).toBe(S2)
  })

  test('a stale link is recovered from the item book by page overlap and the link is healed', async () => {
    chunks = [makeChunk('chunk-1')]
    items = [makeItem('item-a', { chunkId: null })]
    const result = await scheduler.runNextKnowledgeAiRepairStep({ completeJson: async () => goodAnswer })
    expect(result.repaired).toBe(1)
    expect(result.missingSource).toBe(0)
    expect(items[0].chunkId).toBe('chunk-1')
    expect(items[0].title).toBe(S2)
  })

  test('provider exhaustion marks the item for review and the rest still run', async () => {
    chunks = [makeChunk('chunk-1')]
    items = [makeItem('item-a'), makeItem('item-b')]
    const result = await scheduler.runNextKnowledgeAiRepairStep({
      completeJson: async () => { throw new Error('ALL_PROVIDERS_DOWN') },
    })
    expect(result.status).toBe('COMPLETED')
    expect(result.scanned).toBe(2)
    expect(result.repaired).toBe(0)
    expect(result.needsReview).toBe(2)
    expect(items[0].title).not.toBe(S2)
    expect(readJob().cursor).toBe('item-b')
  })

  test('mixed batch records real counts per failure mode', async () => {
    ocrImpl = async () => { throw new Error('OCR_DOWN') }
    chunks = [
      makeChunk('chunk-ok', { contentHash: 'hash-ok' }),
      makeChunk('chunk-garbled', { text: garbledChunkText, contentHash: 'hash-garbled' }),
      makeChunk('chunk-big', { text: bigChunkText, contentHash: 'hash-big', pageStart: 1, pageEnd: 9 }),
    ]
    items = [
      makeItem('item-garbled', { chunkId: 'chunk-garbled' }),
      makeItem('item-missing', { chunkId: 'chunk-gone', pageStart: null, pageEnd: null, excerpt: `${'▒ '.repeat(60)}نص غير موجود في أي مقطع إطلاقا.` }),
      makeItem('item-ok', { chunkId: 'chunk-ok' }),
      makeItem('item-unlocatable', {
        chunkId: 'chunk-big',
        title: 'الفيزياء الكمية والجسيمات الأولية وتفاعلاتها',
        summary: 'تدرس الفيزياء الكمية سلوك الجسيمات الأولية وتفاعلاتها في المختبرات الحديثة.',
        pageStart: 1, pageEnd: 9,
      }),
    ]
    const result = await scheduler.runNextKnowledgeAiRepairStep({ completeJson: async () => goodAnswer })
    expect(result.status).toBe('COMPLETED')
    expect(result.scanned).toBe(4)
    expect(result.repaired).toBe(1)
    expect(result.needsReview).toBe(3)
    expect(result.missingSource).toBe(1)
    expect(result.garbledSource).toBe(1)
    expect(result.unlocatableSource).toBe(1)
    expect(result.ocrRereads).toBe(1)
    expect(result.ocrRereadFailed).toBe(1)
    expect(result.rejectedCorrections).toBe(0)
    const job = readJob()
    expect(job.missingSource).toBe(1)
    expect(job.garbledSource).toBe(1)
    expect(job.unlocatableSource).toBe(1)
  })

  test('an active book repair job blocks the OCR re-read (no task conflict)', async () => {
    repairJobs = [{ id: 'repair-1', bookId: 'book-1', status: 'RUNNING' }]
    chunks = [makeChunk('chunk-1', { text: garbledChunkText, contentHash: 'hash-garbled' })]
    items = [makeItem('item-a')]
    let called = 0
    const result = await scheduler.runNextKnowledgeAiRepairStep({ completeJson: async () => { called++; return goodAnswer } })
    expect(result.garbledSource).toBe(1)
    expect(result.repaired).toBe(0)
    expect(result.ocrRereads).toBe(0)
    expect(ocrCalls).toEqual([])
    expect(called).toBe(0)
  })

  test('a validate rejection inside the injected call is counted, not hidden', async () => {
    chunks = [makeChunk('chunk-1')]
    items = [makeItem('item-a')]
    const result = await scheduler.runNextKnowledgeAiRepairStep({
      completeJson: async (opts: any) => {
        // Simulate the router: the first model answer is rejected by the
        // validate callback, the second model answers cleanly.
        expect(() => opts.validate(JSON.stringify({
          title: S2, summary: `${S1} ${S2}`,
          excerpt: 'تتحدث هذه الفقرة عن موضوع لم يرد في النص الأصلي إطلاقا ولا يوجد له أثر فيه.',
        }))).toThrow('AI_KNOWLEDGE_REPAIR_REJECTED:NOT_GROUNDED')
        return goodAnswer
      },
    })
    expect(result.repaired).toBe(1)
    expect(result.rejectedCorrections).toBe(1)
    expect(result.rejectionReasons).toEqual({ NOT_GROUNDED: 1 })
  })
})

function stubFetch(chatReply: (model: string) => string) {
  const chatRequests: { model: string }[] = []
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlText = String(url)
    if (urlText.endsWith('/models')) {
      return new Response(JSON.stringify({ data: APINEX_FREE_MODELS.map((id) => ({ id, context_length: 1000000 })) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (urlText.endsWith('/chat/completions')) {
      const body = JSON.parse(String(init?.body || '{}'))
      chatRequests.push({ model: String(body.model || '') })
      return new Response(JSON.stringify({ choices: [{ message: { content: chatReply(String(body.model || '')) } }] }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-test' } })
    }
    throw new Error(`unexpected fetch: ${urlText}`)
  }) as any
  return chatRequests
}

const badAnswer = JSON.stringify({
  title: S2,
  summary: `${S1} ${S2}`,
  excerpt: 'تتحدث هذه الفقرة عن موضوع لم يرد في النص الأصلي إطلاقا ولا يوجد له أثر فيه.',
})

describe('router validate failover through the real router', () => {
  beforeEach(() => {
    values.set('AI_TEXT_PROVIDER', 'APINEX')
    process.env.APINEX_API_KEYS = MOCK_APINEX_TOKEN
    values.set('APINEX_TEXT_MODEL', 'free/gemini-3.8-flash')
    values.set('APINEX_BASE_URL', APINEX_BASE_URL)
    seedConfig('APINEX', 'free/gemini-3.8-flash', '10', '0')
  })

  test('a rejected correction fails over to the next model and is counted', async () => {
    chunks = [makeChunk('chunk-1')]
    items = [makeItem('item-a')]
    const chatRequests = stubFetch((model) => (model === 'free/gemini-3.8-flash' ? badAnswer : goodAnswer))
    const result = await scheduler.runNextKnowledgeAiRepairStep()
    expect(result.repaired).toBe(1)
    expect(result.rejectedCorrections).toBe(1)
    expect(result.rejectionReasons).toEqual({ NOT_GROUNDED: 1 })
    expect(chatRequests.map((request) => request.model)).toEqual(['free/gemini-3.8-flash', 'free/deepseek-v4.1-flash'])
    expect(items[0].title).toBe(S2)
  })

  test('when every model is rejected the item goes to review and the job continues', async () => {
    chunks = [makeChunk('chunk-1')]
    items = [makeItem('item-a'), makeItem('item-b')]
    const chatRequests = stubFetch(() => badAnswer)
    const result = await scheduler.runNextKnowledgeAiRepairStep()
    expect(result.status).toBe('COMPLETED')
    expect(result.scanned).toBe(2)
    expect(result.repaired).toBe(0)
    expect(result.needsReview).toBe(2)
    expect(result.rejectedCorrections).toBe(4)
    expect(result.rejectionReasons).toEqual({ NOT_GROUNDED: 4 })
    expect(chatRequests.map((request) => request.model)).toEqual([
      'free/gemini-3.8-flash', 'free/deepseek-v4.1-flash',
      'free/gemini-3.8-flash', 'free/deepseek-v4.1-flash',
    ])
  })
})
