import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 6f — knowledge-AI repair model choice: auto ON ignores the
// dedicated AI_KNOWLEDGE_REPAIR_PROVIDER/MODEL and uses the
// ANALYSIS/REVIEW auto ranking (1–10 calls-per-run budget and lease
// untouched); auto OFF keeps today's dedicated settings.
const S1 = 'تتناول هذه الوحدة أسس المحاسبة المالية وأهدافها في خدمة الإدارة واتخاذ القرارات.'
const S2 = 'تعرف الأصول المتداولة بأنها الموارد التي تتوقع المنشأة تحويلها إلى نقد خلال دورة التشغيل العادية.'
const S3 = 'يقيس قائمة المركز المالي حقوق الملكية بعد خصم الالتزامات من إجمالي الأصول في تاريخ محدد.'
const S4 = 'تعتمد القوائم المالية على مبدأ الاستحقاق في إثبات الإيرادات والمصروفات عند تحققها.'
const garbledExcerpt = `${'□ '.repeat(60)}الأصول المتداولة في القوائم المالية.`
const goodAnswer = JSON.stringify({ title: S2, summary: `${S1} ${S2}`, excerpt: S3 })

let settingsStore = new Map<string, string>()
let items: any[] = []
let chunks: any[] = []

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
      return false
    }
    return value === cond
  })
}

const fakeDb: any = {
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
  book: { findUnique: async () => ({ id: 'book-1', programId: 'prog-1' }) },
  bookRepairJob: { findFirst: async () => null },
}
mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/book-reader', () => ({
  transcribeScannedDocumentWithVision: async () => [],
}))
mock.module('@/lib/storage', () => ({
  getFileBufferFromStorageOrBase64: async () => ({ buffer: Buffer.from('%PDF-1.4 fake'), mimeType: 'application/pdf' }),
}))

const scheduler = await import('../../src/lib/book-knowledge-v2-scheduler')

function seedJob() {
  settingsStore.set('KNOWLEDGE_AI_REPAIR_JOB:prog-1', JSON.stringify({
    programId: 'prog-1', status: 'QUEUED', cursor: '', scanned: 0, repaired: 0,
    needsReview: 0, missingSource: 0, garbledSource: 0, unlocatableSource: 0,
    rejectedCorrections: 0, rejectionReasons: {}, ocrRereads: 0, ocrRereadFailed: 0,
    attempts: 0, lastError: null, leaseToken: null, leaseUntil: null,
  }))
}

function seedConfig(provider = 'AUTO', model = '', calls = '10', interval = '0') {
  settingsStore.set('AI_KNOWLEDGE_REPAIR_PROVIDER', provider)
  settingsStore.set('AI_KNOWLEDGE_REPAIR_MODEL', model)
  settingsStore.set('AI_KNOWLEDGE_REPAIR_INTERVAL_SECONDS', interval)
  settingsStore.set('AI_KNOWLEDGE_REPAIR_CALLS_PER_RUN', calls)
}

function seedItemAndChunk() {
  chunks = [{
    id: 'chunk-1', bookId: 'book-1', programId: 'prog-1', index: 0,
    text: `${S1} ${S2} ${S3} ${S4}`, textProvenance: 'NATIVE_TEXT',
    contentHash: 'hash-1', status: 'EXTRACTED', pageStart: 1, pageEnd: 2,
  }]
  items = [{
    id: 'item-a', programId: 'prog-1', bookId: 'book-1', chunkId: 'chunk-1',
    textProvenance: null, category: 'CONCEPT', kbVersion: 2,
    title: 'الأصول المتداولة وقياسها في القوائم المالية',
    summary: S2, excerpt: garbledExcerpt, pageStart: 1, pageEnd: 2,
    createdAt: new Date(0), updatedAt: new Date(0),
  }]
}

beforeEach(() => {
  settingsStore = new Map()
  items = []
  chunks = []
  seedConfig()
  seedJob()
  seedItemAndChunk()
})

describe('chooseKnowledgeRepairModels — pure choice', () => {
  const ranking = (models: Array<{ provider: string; model: string }>) =>
    JSON.stringify({ candidates: models })
  test('auto ON with a REVIEW ranking uses it and ignores the dedicated provider/model', () => {
    const chosen = scheduler.chooseKnowledgeRepairModels({
      autoMode: true,
      reviewRankingRaw: ranking([{ provider: 'GROQ', model: 'groq-model-a' }]),
      analysisRankingRaw: ranking([]),
      repairProvider: 'GEMINI', repairModel: 'gemini-3.5-flash-lite', repairProviderAllowed: true,
    })
    expect(chosen.source).toBe('auto')
    expect(chosen.models).toEqual([{ provider: 'GROQ', model: 'groq-model-a' }])
  })
  test('auto ON falls back to ANALYSIS when REVIEW is empty; excluded entries are dropped', () => {
    const chosen = scheduler.chooseKnowledgeRepairModels({
      autoMode: true,
      reviewRankingRaw: ranking([]),
      analysisRankingRaw: ranking([
        { provider: 'GROQ', model: 'cooled-model', excludedReason: 'QUOTA_COOLDOWN' },
        { provider: 'GEMINI', model: 'gemini-3.5-flash-lite' },
      ]),
      repairProvider: 'GEMINI', repairModel: 'gemini-3.5-flash-lite', repairProviderAllowed: true,
    })
    expect(chosen.source).toBe('auto')
    expect(chosen.models.map((m: any) => m.model)).toEqual(['gemini-3.5-flash-lite'])
  })
  test('auto ON with an empty ranking falls back to the dedicated settings instead of refusing', () => {
    const chosen = scheduler.chooseKnowledgeRepairModels({
      autoMode: true, reviewRankingRaw: '', analysisRankingRaw: '',
      repairProvider: 'GEMINI', repairModel: 'gemini-3.5-flash-lite', repairProviderAllowed: true,
    })
    expect(chosen.source).toBe('dedicated')
    expect(chosen.models).toEqual([{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }])
  })
  test('auto OFF uses the dedicated settings even when a ranking exists', () => {
    const chosen = scheduler.chooseKnowledgeRepairModels({
      autoMode: false,
      reviewRankingRaw: ranking([{ provider: 'GROQ', model: 'groq-model-a' }]),
      analysisRankingRaw: ranking([]),
      repairProvider: 'GEMINI', repairModel: 'gemini-3.5-flash-lite', repairProviderAllowed: true,
    })
    expect(chosen.source).toBe('dedicated')
    expect(chosen.models).toEqual([{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }])
  })
})

describe('runNextKnowledgeAiRepairStep — auto ranking end to end', () => {
  test('auto ON: the repair call goes to the ranked model, not the dedicated one', async () => {
    settingsStore.set('AI_KNOWLEDGE_REPAIR_PROVIDER', 'GEMINI')
    settingsStore.set('AI_KNOWLEDGE_REPAIR_MODEL', 'gemini-3.5-flash-lite')
    settingsStore.set('AI_AUTO_MODE_ENABLED', '1')
    settingsStore.set('AI_AUTO_RANKING:REVIEW', JSON.stringify({ candidates: [
      { provider: 'GROQ', model: 'groq-model-a' },
    ] }))
    const seen: any[] = []
    const result = await scheduler.runNextKnowledgeAiRepairStep({
      completeJson: async (opts: any) => { seen.push(opts); return goodAnswer },
    })
    expect(result.repaired).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0].preferredModels).toEqual([{ provider: 'GROQ', model: 'groq-model-a' }])
    expect(items[0].id).toBe('item-a')
  })

  test('auto OFF: the repair call uses the dedicated provider/model', async () => {
    settingsStore.set('AI_KNOWLEDGE_REPAIR_PROVIDER', 'GEMINI')
    settingsStore.set('AI_KNOWLEDGE_REPAIR_MODEL', 'gemini-3.5-flash-lite')
    settingsStore.set('AI_AUTO_RANKING:REVIEW', JSON.stringify({ candidates: [
      { provider: 'GROQ', model: 'groq-model-a' },
    ] }))
    const seen: any[] = []
    const result = await scheduler.runNextKnowledgeAiRepairStep({
      completeJson: async (opts: any) => { seen.push(opts); return goodAnswer },
    })
    expect(result.repaired).toBe(1)
    expect(seen).toHaveLength(1)
    expect(seen[0].preferredModels).toEqual([{ provider: 'GEMINI', model: 'gemini-3.5-flash-lite' }])
  })
})
