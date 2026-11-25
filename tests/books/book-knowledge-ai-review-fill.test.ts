// Manual-review AI buttons ("تكليف الذكاء" per item + "تكليف الذكاء للكل").
//
// Per-item fill: one AI call drafts the three fields from the item's own
// chunk evidence; it must NEVER save — the helper has no DB write path.
// The bulk button is SCOPED to the manual-review queue (owner's law,
// 2026-11-25): it fills + saves review items only, one AI call each,
// and never enqueues the whole-bank smart-repair job — its budget and
// scope tests live in book-knowledge-ai-review-fill-all.test.ts. The
// background-job tests below guard the untouched «بدء التصحيح الذكي»
// job itself. Real scheduler code against an in-memory fake DB.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const S1 = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة واتخاذ القرارات.'
const S2 = 'تعرف الأصول المتداولة بأنها الموارد التي تتوقع المنشأة تحويلها إلى نقد خلال دورة التشغيل العادية.'
const S3 = 'يقيس قائمة المركز المالي حقوق الملكية بعد خصم الالتزامات من إجمالي الأصول في تاريخ محدد.'
const S4 = 'تعتمد القوائم المالية على مبدأ الاستحقاق في إثبات الإيرادات والمصروفات عند تحققها.'
const S5 = 'يركز التسويق الحديث على فهم احتياجات العملاء وبناء علاقات طويلة الأمد معهم.'
const S6 = 'تدرس بحوث التسويق سلوك المستهلك لتحديد الشرائح المستهدفة وتصميم المنتجات المناسبة لها.'
const regionA = [S1, S2, S3, S4].map((s) => `${s} `.repeat(12)).join(' ')
const regionB = [S5, S6].map((s) => `${s} `.repeat(12)).join(' ')
const bigChunkText = `${regionA} ${regionB}`
const garbledExcerpt = `${'□ '.repeat(60)}الأصول المتداولة في القوائم المالية.`
const goodAnswer = JSON.stringify({ title: S2, summary: `${S1} ${S2}`, excerpt: S3 })
// Clean Arabic, but from nowhere in the chunk: the excerpt cannot be proven.
const foreignAnswer = JSON.stringify({
  title: S2,
  summary: `${S1} ${S2}`,
  excerpt: 'تدرس إدارة الجودة الشاملة رضا العملاء وتحسين العمليات باستمرار وتطوير المنتجات.',
})

let settingsStore = new Map<string, string>()
let items: any[] = []
let chunks: any[] = []
let books: any[] = []

const values = new Map<string, string>()
const originalFetch = globalThis.fetch

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
  bookRepairJob: { findFirst: async () => null },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/book-reader', () => ({
  transcribeScannedDocumentWithVision: async () => { throw new Error('OCR_NOT_STUBBED') },
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

function seedConfig(provider = 'AUTO', model = '', calls = '10', interval = '0') {
  settingsStore.set('AI_KNOWLEDGE_REPAIR_PROVIDER', provider)
  settingsStore.set('AI_KNOWLEDGE_REPAIR_MODEL', model)
  settingsStore.set('AI_KNOWLEDGE_REPAIR_INTERVAL_SECONDS', interval)
  settingsStore.set('AI_KNOWLEDGE_REPAIR_CALLS_PER_RUN', calls)
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
    text: bigChunkText, textProvenance: 'NATIVE_TEXT',
    contentHash: 'hash-big', status: 'ANALYZED', pageStart: 1, pageEnd: 9, ...patch,
  }
}

beforeEach(() => {
  settingsStore = new Map()
  items = []
  chunks = [makeChunk('chunk-1')]
  books = [{ id: 'book-1', programId: 'prog-1', title: 'كتاب اختبار', storageProvider: 'TEST', storageKey: 'k', fileUrl: null, data: null, mimeType: 'application/pdf' }]
  values.clear()
  globalThis.fetch = originalFetch
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
  seedConfig()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  textAi.__setTextAiSettingStoreForTests(null)
})

describe('aiFillReviewItemFields (per-item "تكليف الذكاء")', () => {
  const fillArgs = (item: any) => {
    const window = scheduler.repairSourceWindow(bigChunkText, item)
    expect(window.status).toBe('OK')
    if (window.status !== 'OK') throw new Error('fixture evidence window must be OK')
    return { item: { title: item.title, summary: item.summary, excerpt: item.excerpt }, chunkText: bigChunkText, evidence: window.evidence }
  }

  test('a proven AI draft returns the three fields and saves nothing', async () => {
    const item = makeItem('item-1')
    items = [item]
    const before = JSON.stringify(items)
    let calls = 0
    const completeJson = async (opts: any) => {
      calls++
      opts.validate?.(goodAnswer)
      return goodAnswer
    }
    const result = await scheduler.aiFillReviewItemFields(fillArgs(item), { completeJson })
    expect(calls).toBe(1)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.fields.title).toBe(S2)
    expect(result.fields.summary).toBe(`${S1} ${S2}`)
    expect(result.fields.excerpt).toBe(S3)
    // The fill has no write path: the stored item is byte-identical.
    expect(JSON.stringify(items)).toBe(before)
  })

  test('a non-verbatim AI excerpt returns a reason and saves nothing', async () => {
    const item = makeItem('item-1')
    items = [item]
    const before = JSON.stringify(items)
    let calls = 0
    const completeJson = async (opts: any) => {
      calls++
      opts.validate?.(foreignAnswer)
      return foreignAnswer
    }
    const result = await scheduler.aiFillReviewItemFields(fillArgs(item), { completeJson })
    expect(calls).toBe(1)
    expect(result).toEqual({ ok: false, reason: 'EXCERPT_NOT_VERBATIM' })
    expect(JSON.stringify(items)).toBe(before)
  })

  test('an invalid JSON answer returns a reason and saves nothing', async () => {
    const item = makeItem('item-1')
    items = [item]
    const before = JSON.stringify(items)
    const result = await scheduler.aiFillReviewItemFields(fillArgs(item), {
      completeJson: async () => 'not json at all',
    })
    expect(result).toEqual({ ok: false, reason: 'INVALID_JSON' })
    expect(JSON.stringify(items)).toBe(before)
  })

  test('no configured repair model means no AI call at all', async () => {
    settingsStore.set('AI_KNOWLEDGE_REPAIR_PROVIDER', 'GEMINI')
    settingsStore.set('AI_KNOWLEDGE_REPAIR_MODEL', '')
    const item = makeItem('item-1')
    items = [item]
    let calls = 0
    const result = await scheduler.aiFillReviewItemFields(fillArgs(item), {
      completeJson: async () => { calls++; return goodAnswer },
    })
    expect(calls).toBe(0)
    expect(result).toEqual({ ok: false, reason: 'AI_UNAVAILABLE' })
  })

  test('a provider failure returns AI_CALL_FAILED and saves nothing', async () => {
    const item = makeItem('item-1')
    items = [item]
    const before = JSON.stringify(items)
    const result = await scheduler.aiFillReviewItemFields(fillArgs(item), {
      completeJson: async () => { throw new Error('provider down') },
    })
    expect(result).toEqual({ ok: false, reason: 'AI_CALL_FAILED' })
    expect(JSON.stringify(items)).toBe(before)
  })
})

describe('validateReviewFillFields (the manual-save rule)', () => {
  test('accepts fields the manual save would accept', () => {
    const checked = scheduler.validateReviewFillFields(
      { title: S2, summary: `${S1} ${S2}`, excerpt: S3 }, bigChunkText)
    expect(checked.ok).toBe(true)
  })

  test('rejects a title shorter than the manual-save floor', () => {
    const checked = scheduler.validateReviewFillFields(
      { title: 'قصير', summary: `${S1} ${S2}`, excerpt: S3 }, bigChunkText)
    expect(checked).toEqual({ ok: false, reason: 'FIELD_LENGTH' })
  })

  test('rejects a garbled summary the manual save would refuse', () => {
    const checked = scheduler.validateReviewFillFields(
      { title: S2, summary: garbledExcerpt, excerpt: S3 }, bigChunkText)
    expect(checked).toEqual({ ok: false, reason: 'FIELD_BROKEN' })
  })

  test('rejects an excerpt that is not a verbatim span of the chunk', () => {
    const checked = scheduler.validateReviewFillFields(
      { title: S2, summary: `${S1} ${S2}`, excerpt: 'تدرس إدارة الجودة الشاملة رضا العملاء.' }, bigChunkText)
    expect(checked).toEqual({ ok: false, reason: 'EXCERPT_NOT_VERBATIM' })
  })
})

describe('background smart-repair job ("بدء التصحيح الذكي", untouched by the review bulk button)', () => {
  test('one press runs at most the configured calls and leaves the rest queued', async () => {
    seedConfig('AUTO', '', '2', '0')
    items = [makeItem('item-1'), makeItem('item-2'), makeItem('item-3'), makeItem('item-4'), makeItem('item-5')]
    await scheduler.enqueueKnowledgeAiRepairJob('prog-1')
    let calls = 0
    const completeJson = async (opts: any) => {
      calls++
      opts.validate?.(goodAnswer)
      return goodAnswer
    }
    const first = await scheduler.runNextKnowledgeAiRepairStep({ completeJson })
    expect(calls).toBe(2)
    expect(first.status).toBe('QUEUED')
    expect(first.repaired).toBe(2)
    // Items 3–5 were never attempted: still garbled, still in the queue.
    expect(items[2].excerpt).toBe(garbledExcerpt)
    expect(items[3].excerpt).toBe(garbledExcerpt)
    expect(items[4].excerpt).toBe(garbledExcerpt)
    expect(items[0].excerpt).toBe(S3)
    expect(items[1].excerpt).toBe(S3)

    const second = await scheduler.runNextKnowledgeAiRepairStep({ completeJson })
    expect(calls).toBe(4)
    expect(second.repaired).toBe(4)
    expect(items[2].excerpt).toBe(S3)
    expect(items[3].excerpt).toBe(S3)
    // The fifth item is still queued for the next press.
    expect(items[4].excerpt).toBe(garbledExcerpt)
  })

  test('an item the AI cannot prove stays queued with its reason', async () => {
    seedConfig('AUTO', '', '10', '0')
    items = [makeItem('item-1')]
    await scheduler.enqueueKnowledgeAiRepairJob('prog-1')
    let calls = 0
    const completeJson = async (opts: any) => {
      calls++
      opts.validate?.(foreignAnswer)
      return foreignAnswer
    }
    const result = await scheduler.runNextKnowledgeAiRepairStep({ completeJson })
    expect(calls).toBe(1)
    expect(result.repaired).toBe(0)
    expect(result.needsReview).toBe(1)
    expect(result.rejectedCorrections).toBe(1)
    expect(items[0].excerpt).toBe(garbledExcerpt)
  })
})

describe('review AI buttons wiring (source pins)', () => {
  const ADMIN_BOOKS = readFileSync('src/components/aact/AdminBooks.tsx', 'utf8')
  const ROUTE = readFileSync('src/app/api/admin/knowledge-bank/route.ts', 'utf8')

  test('the review card offers a per-item AI fill next to approve', () => {
    expect(ADMIN_BOOKS).toContain('تكليف الذكاء')
    expect(ADMIN_BOOKS).toContain('const aiFillManualReview')
    expect(ADMIN_BOOKS).toContain("action: 'ai-fill-review'")
    // The fill only fills the form; the save stays the admin's press.
    expect(ADMIN_BOOKS).toContain('لم يُحفظ أي تعديل بعد')
  })

  test('the review header offers one general button scoped to the review queue, never the smart-repair job', () => {
    expect(ADMIN_BOOKS).toContain('تكليف الذكاء للكل')
    expect(ADMIN_BOOKS).toContain('const aiFillAllManualReview')
    const bulkHandler = ADMIN_BOOKS.split('const aiFillAllManualReview')[1]?.split('const previewChunkRepair')[0] || ''
    expect(bulkHandler).toContain("action: 'ai-fill-review-all'")
    expect(bulkHandler).not.toContain("action: 'repair-ai'")
    expect(bulkHandler).not.toContain('تمت جدولة التصحيح الذكي')
  })

  test('the route serves the fill action and never saves from it', () => {
    expect(ROUTE).toContain("body.action === 'ai-fill-review'")
    expect(ROUTE).toContain('aiFillReviewItemFields')
    expect(ROUTE).toContain('repairSourceWindow')
  })

  test('the route serves the scoped bulk fill and leaves the smart-repair enqueue untouched', () => {
    expect(ROUTE).toContain("action === 'ai-fill-review-all'")
    expect(ROUTE).toContain('runReviewFillAllStep')
    expect(ROUTE).toContain("action === 'repair-ai'")
    expect(ROUTE).toContain('enqueueKnowledgeAiRepairJob')
  })
})
