// Bulk review fill ("تكليف الذكاء للكل", POST ai-fill-review-all) —
// scoped to the manual-review queue ONLY (owner's law, 2026-11-25).
//
// Each press takes the first review-queue items by id (no persisted
// cursor: saved items leave the queue, so the next press continues),
// at most N AI calls (N = the admin's 1-10 calls-per-run budget).
// A saved item keeps its ID, holds valid fields, its excerpt is
// verbatim in the chunk text, and gets an audit row. Healthy items
// are never touched — not even an AI call. Real scheduler code
// against an in-memory fake DB.
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
const garbledChunkText = '□ '.repeat(200)
const goodAnswer = JSON.stringify({ title: S2, summary: `${S1} ${S2}`, excerpt: S3 })
const foreignAnswer = JSON.stringify({
  title: S2,
  summary: `${S1} ${S2}`,
  excerpt: 'تدرس إدارة الجودة الشاملة رضا العملاء وتحسين العمليات باستمرار وتطوير المنتجات.',
})

let settingsStore = new Map<string, string>()
let items: any[] = []
let chunks: any[] = []
let books: any[] = []
let auditCalls: any[][] = []

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
    findFirst: async ({ where }: any) => {
      const row = items.find((r) => matches(r, where))
      return row ? { ...row } : null
    },
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
mock.module('@/lib/notify', () => ({
  audit: async (...args: any[]) => { auditCalls.push(args) },
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

const ADMIN = { id: 'admin-1', name: 'Admin' }

beforeEach(() => {
  settingsStore = new Map()
  items = []
  chunks = [makeChunk('chunk-1')]
  books = [{ id: 'book-1', programId: 'prog-1', title: 'كتاب اختبار', storageProvider: 'TEST', storageKey: 'k', fileUrl: null, data: null, mimeType: 'application/pdf' }]
  values.clear()
  auditCalls = []
  globalThis.fetch = originalFetch
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
  seedConfig()
})

afterAll(() => {
  globalThis.fetch = originalFetch
  textAi.__setTextAiSettingStoreForTests(null)
})

describe('runReviewFillAllStep scope — review queue only', () => {
  test('healthy items stay byte-identical and cost no AI call; only review items are processed', async () => {
    const healthy = makeItem('item-1', { title: S2, summary: `${S1} ${S2}`, excerpt: S3 })
    const review = makeItem('item-2')
    const missingSource = makeItem('item-3', { bookId: null, chunkId: null, pageStart: null, pageEnd: null })
    items = [healthy, review, missingSource]
    const healthyBefore = JSON.stringify(healthy)
    const missingBefore = JSON.stringify(missingSource)
    let calls = 0
    const completeJson = async (opts: any) => {
      calls++
      opts.validate?.(goodAnswer)
      return goodAnswer
    }
    const result = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
    expect(calls).toBe(1)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.saved).toBe(1)
    expect(result.scanned).toBe(2)
    expect(result.stillReview).toBe(1)
    expect(result.reasons).toEqual({ SOURCE_MISSING: 1 })
    expect(result.hasMore).toBe(false)
    expect(result.savedIds).toEqual(['item-2'])
    // The healthy item was never touched — not even read for an AI call.
    expect(JSON.stringify(items[0])).toBe(healthyBefore)
    expect(items[0].title).toBe(S2)
    // The missing-source item stays exactly as it was.
    expect(JSON.stringify(items[2])).toBe(missingBefore)
    // The review item was saved in place.
    expect(items[1].excerpt).toBe(S3)
    // Exactly one audit row, for the saved item only.
    expect(auditCalls.length).toBe(1)
    expect(auditCalls[0][1]).toBe('MANUAL_REVIEW_KNOWLEDGE_ITEM')
    expect(auditCalls[0][2]).toBe('BookKnowledgeItem')
    expect(auditCalls[0][3]).toBe('item-2')
  })

  test('one press runs at most the configured AI calls; saved items leave the queue and the next press continues', async () => {
    seedConfig('AUTO', '', '2', '0')
    items = [makeItem('item-1'), makeItem('item-2'), makeItem('item-3'), makeItem('item-4'), makeItem('item-5')]
    let calls = 0
    const completeJson = async (opts: any) => {
      calls++
      opts.validate?.(goodAnswer)
      return goodAnswer
    }
    const first = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
    expect(calls).toBe(2)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected ok')
    expect(first.saved).toBe(2)
    expect(first.scanned).toBe(2)
    expect(first.hasMore).toBe(true)
    expect(first.savedIds).toEqual(['item-1', 'item-2'])
    // Items 3-5 were never attempted: still garbled, still in the queue.
    expect(items[2].excerpt).toBe(garbledExcerpt)
    expect(items[3].excerpt).toBe(garbledExcerpt)
    expect(items[4].excerpt).toBe(garbledExcerpt)

    const second = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
    expect(calls).toBe(4)
    if (!second.ok) throw new Error('expected ok')
    expect(second.saved).toBe(2)
    expect(second.savedIds).toEqual(['item-3', 'item-4'])
    expect(second.hasMore).toBe(true)
    expect(items[4].excerpt).toBe(garbledExcerpt)

    const third = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
    expect(calls).toBe(5)
    if (!third.ok) throw new Error('expected ok')
    expect(third.saved).toBe(1)
    expect(third.savedIds).toEqual(['item-5'])
    expect(third.hasMore).toBe(false)
    expect(auditCalls.length).toBe(5)
  })
})

describe('runReviewFillAllStep save proof', () => {
  test('a saved item keeps its ID, holds valid fields, its excerpt is verbatim in the chunk, and an audit row is written', async () => {
    const item = makeItem('item-1')
    items = [item]
    const completeJson = async (opts: any) => {
      opts.validate?.(goodAnswer)
      return goodAnswer
    }
    const result = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.saved).toBe(1)
    expect(result.savedIds).toEqual(['item-1'])
    const saved = items[0]
    expect(saved.id).toBe('item-1')
    expect(saved.bookId).toBe('book-1')
    expect(saved.chunkId).toBe('chunk-1')
    expect(saved.title).toBe(S2)
    expect(saved.summary).toBe(`${S1} ${S2}`)
    expect(saved.excerpt).toBe(S3)
    // The saved excerpt is a verbatim span of the chunk text.
    expect(bigChunkText.includes(S3)).toBe(true)
    const compact = (text: string) => text.replace(/\s+/g, ' ').trim()
    expect(compact(bigChunkText).includes(compact(saved.excerpt))).toBe(true)
    // The save is a CAS update: updatedAt moved.
    expect(saved.updatedAt.getTime()).toBeGreaterThan(0)
    // One audit row, same action as the manual save.
    expect(auditCalls.length).toBe(1)
    expect(auditCalls[0][0]).toEqual(ADMIN)
    expect(auditCalls[0][1]).toBe('MANUAL_REVIEW_KNOWLEDGE_ITEM')
    expect(auditCalls[0][2]).toBe('BookKnowledgeItem')
    expect(auditCalls[0][3]).toBe('item-1')
  })

  test('a non-verbatim AI answer is not saved, stays in the queue, and is counted', async () => {
    const item = makeItem('item-1')
    items = [item]
    const before = JSON.stringify(items)
    let calls = 0
    const completeJson = async (opts: any) => {
      calls++
      opts.validate?.(foreignAnswer)
      return foreignAnswer
    }
    const result = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
    expect(calls).toBe(1)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.saved).toBe(0)
    expect(result.scanned).toBe(1)
    expect(result.stillReview).toBe(1)
    expect(result.reasons).toEqual({ EXCERPT_NOT_VERBATIM: 1 })
    expect(result.hasMore).toBe(false)
    expect(JSON.stringify(items)).toBe(before)
    expect(auditCalls.length).toBe(0)
  })

  test('a manual edit during the AI call wins over the stale bulk fill', async () => {
    items = [makeItem('item-1')]
    const editedTitle = 'تصحيح المدير المعتمد للأصول المالية'
    let calls = 0
    const completeJson = async (opts: any) => {
      calls++
      // The administrator corrects this item while the model is thinking.
      Object.assign(items[0], {
        title: editedTitle,
        summary: `${S1} ${S2}`,
        excerpt: S3,
        updatedAt: new Date('2026-11-26T10:00:00.000Z'),
      })
      opts.validate?.(goodAnswer)
      return goodAnswer
    }
    const result = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
    expect(calls).toBe(1)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.saved).toBe(0)
    expect(result.reasons).toEqual({ SAVE_CONFLICT: 1 })
    expect(items[0].title).toBe(editedTitle)
    expect(items[0].excerpt).toBe(S3)
    expect(auditCalls).toHaveLength(0)
  })

  test('a lost CAS race is counted, nothing is saved, and the item stays in the queue', async () => {
    const item = makeItem('item-1')
    items = [item]
    const originalUpdateMany = fakeDb.bookKnowledgeItem.updateMany
    fakeDb.bookKnowledgeItem.updateMany = async () => ({ count: 0 })
    try {
      let calls = 0
      const completeJson = async (opts: any) => {
        calls++
        opts.validate?.(goodAnswer)
        return goodAnswer
      }
      const result = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
      expect(calls).toBe(1)
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected ok')
      expect(result.saved).toBe(0)
      expect(result.reasons).toEqual({ SAVE_CONFLICT: 1 })
      expect(items[0].excerpt).toBe(garbledExcerpt)
      expect(auditCalls.length).toBe(0)
    } finally {
      fakeDb.bookKnowledgeItem.updateMany = originalUpdateMany
    }
  })
})

describe('runReviewFillAllStep skips without an AI call', () => {
  test('a garbled source item costs no AI call and is counted', async () => {
    chunks = [makeChunk('chunk-1', { text: garbledChunkText })]
    const item = makeItem('item-1')
    items = [item]
    const before = JSON.stringify(items)
    let calls = 0
    const completeJson = async () => { calls++; return goodAnswer }
    const result = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
    expect(calls).toBe(0)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.saved).toBe(0)
    expect(result.scanned).toBe(1)
    expect(result.stillReview).toBe(1)
    expect(result.reasons).toEqual({ SOURCE_GARBLED: 1 })
    expect(JSON.stringify(items)).toBe(before)
    expect(auditCalls.length).toBe(0)
  })

  test('no configured repair model means no scan and no AI call', async () => {
    settingsStore.set('AI_KNOWLEDGE_REPAIR_PROVIDER', 'GEMINI')
    settingsStore.set('AI_KNOWLEDGE_REPAIR_MODEL', '')
    items = [makeItem('item-1')]
    let calls = 0
    const completeJson = async () => { calls++; return goodAnswer }
    const result = await scheduler.runReviewFillAllStep('prog-1', ADMIN, { completeJson })
    expect(calls).toBe(0)
    expect(result).toEqual({ ok: false, reason: 'AI_UNAVAILABLE', saved: 0, stillReview: 0, scanned: 0, reasons: {}, hasMore: false, savedIds: [] })
    expect(items[0].excerpt).toBe(garbledExcerpt)
    expect(auditCalls.length).toBe(0)
  })
})

describe('isManualReviewQueueItem (shared queue rule)', () => {
  test('a clean item is not in the queue', () => {
    expect(scheduler.isManualReviewQueueItem({ title: S2, summary: `${S1} ${S2}`, excerpt: S3, bookId: 'book-1', chunkId: 'chunk-1', pageStart: 1, pageEnd: 2 })).toBe(false)
  })

  test('a garbled item is in the queue', () => {
    expect(scheduler.isManualReviewQueueItem({ title: 'الأصول المتداولة وقياسها في القوائم المالية', summary: S2, excerpt: garbledExcerpt, bookId: 'book-1', chunkId: 'chunk-1', pageStart: 1, pageEnd: 2 })).toBe(true)
  })

  test('an item with a missing source link is in the queue even when its text is clean', () => {
    expect(scheduler.isManualReviewQueueItem({ title: S2, summary: `${S1} ${S2}`, excerpt: S3, bookId: null, chunkId: null, pageStart: null, pageEnd: null })).toBe(true)
  })

  test('an entirely empty item is in the queue (DELETE_EMPTY)', () => {
    expect(scheduler.isManualReviewQueueItem({ title: '', summary: '', excerpt: '', bookId: 'book-1', chunkId: 'chunk-1', pageStart: 1, pageEnd: 2 })).toBe(true)
  })
})

describe('review bulk fill wiring (source pins)', () => {
  test('the step never enqueues or runs the background smart-repair job', () => {
    const SCHEDULER = readFileSync('src/lib/book-knowledge-v2-scheduler.ts', 'utf8')
    const step = SCHEDULER.split('export async function runReviewFillAllStep')[1]?.split('export async function runNextKnowledgeAiRepairStep')[0] || ''
    expect(step).not.toContain('enqueueKnowledgeAiRepairJob')
    expect(step).not.toContain('runNextKnowledgeAiRepairStep')
    expect(step).toContain('isManualReviewQueueItem')
    expect(step).toContain('aiFillReviewItemFields')
  })
})
