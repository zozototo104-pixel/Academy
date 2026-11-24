import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Repair-first async link (PR #212): a damaged unit whose sources are
// garbled defers (HTTP 202) with a UnitRegenerationIntent while the book
// repair runs, and generation auto-resumes when the repair finishes.
// Exclusion applies ONLY after the repair is exhausted. Real regenerate
// route + real link lib against an in-memory fake DB; no production
// records are touched. The existing book-unit-regeneration.test.ts still
// owns the pure-function pins; this file owns the deferral/resume flow.

const cleanText = 'الأصول المتداولة هي الأصول التي يتوقع تحويلها إلى نقد خلال سنة مالية واحدة، وتشمل النقدية والمخزون والذمم المدينة التي تتحول إلى نقد خلال دورة التشغيل العادية للمنشأة. '.repeat(4)
const garbledPage = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)
const cleanChunk = (index: number) => ({ id: `chunk-${index}`, bookId: 'book-1', index, pageStart: index * 2 + 1, pageEnd: index * 2 + 2, headingPath: 'الباب الأول', text: cleanText, contentHash: `hash-${index}`, status: 'ANALYZED' })
const garbledChunk = (index: number) => ({ id: `chunk-${index}`, bookId: 'book-1', index, pageStart: index * 2 + 1, pageEnd: index * 2 + 2, headingPath: 'الباب الأول', text: garbledPage, contentHash: `hash-${index}`, status: 'ANALYZED' })
const cleanItem = (id: string, chunkId: string) => ({
  id, category: 'CONCEPT', bookId: 'book-1', kbVersion: 2,
  title: 'الأصول المتداولة',
  summary: 'الأصول المتداولة هي الأصول التي يتوقع تحويلها إلى نقد خلال سنة مالية واحدة.',
  excerpt: 'تشمل الأصول المتداولة النقدية والمخزون والذمم المدينة التي تتحول إلى نقد خلال دورة التشغيل العادية للمنشأة.',
  pageStart: 5, pageEnd: 6, chunkId,
})

// 18-word sentence x6 = 108 words: inside the 80–150 summary window, so
// generation succeeds on the first Gemini call (no summary retry).
const summarySentence = 'الأصول المتداولة تتحول إلى نقد خلال السنة المالية وتشمل النقدية والمخزون والذمم المدينة في دورة التشغيل العادية للمنشأة'
const generatedJson = () => JSON.stringify({
  summary: Array(6).fill(summarySentence).join(' '),
  objectives: ['يشرح الأصول المتداولة في المنشأة', 'يميز النقدية عن المخزون', 'يطبق دورة التشغيل العادية', 'يحلل الذمم المدينة بدقة'],
  content: [
    { heading: 'الأصول المتداولة', body: 'شرح تعليمي واضح يذكر الصفحات المرجعية داخل النص صفحات 1–2 ويشرح الأصول المتداولة والنقدية والمخزون والذمم المدينة.', pageRefs: ['صفحات 1–2'], sourceKnowledgeIds: ['item-clean'], sourceChunkIndexes: [0] },
  ],
})

let geminiCalls = 0
let storageImpl: () => Promise<{ buffer: Buffer } | null> = async () => ({ buffer: Buffer.from('%PDF-1.4 fake') })

let units: any[]
let chunks: any[]
let knowledge: any[]
let generationJobs: any[]
let drafts: any[]
let intents: any[]
let repairJobs: any[]
let book: any
let seq = 0

function resetState() {
  geminiCalls = 0
  storageImpl = async () => ({ buffer: Buffer.from('%PDF-1.4 fake') })
  seq = 0
  units = [{
    id: 'unit-1', programId: 'prog-1', title: 'وحدة الأصول', sourceBookId: 'book-1',
    chunkStartIndex: 0, chunkEndIndex: 1,
    program: { id: 'prog-1', titleAr: 'برنامج المحاسبة', titleEn: 'Accounting' },
  }]
  chunks = [cleanChunk(0), garbledChunk(1)]
  knowledge = [cleanItem('item-clean', 'chunk-0')]
  generationJobs = []
  drafts = []
  intents = []
  repairJobs = []
  book = {
    id: 'book-1', programId: 'prog-1', title: 'كتاب المحاسبة',
    storageProvider: 'local', storageKey: 'book-1.pdf', fileUrl: null, data: null, mimeType: 'application/pdf',
  }
}
resetState()

function matches(row: any, where: any): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    const value = row[key]
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('in' in cond) return (cond.in as unknown[]).includes(value)
      if ('not' in cond) return cond.not === null ? value !== null : value !== cond.not
      if ('gte' in cond || 'lte' in cond || 'gt' in cond || 'lt' in cond) {
        const num = (v: any) => (v instanceof Date ? v.getTime() : v)
        if ('gte' in cond && !(num(value) >= num(cond.gte))) return false
        if ('lte' in cond && !(num(value) <= num(cond.lte))) return false
        if ('gt' in cond && !(num(value) > num(cond.gt))) return false
        if ('lt' in cond && !(num(value) < num(cond.lt))) return false
        return true
      }
      return false
    }
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime()
    return value === cond
  })
}

function sortRows(rows: any[], orderBy: any) {
  if (!orderBy) return rows
  const key = Array.isArray(orderBy) ? orderBy[0] : orderBy
  const field = typeof key === 'object' ? Object.keys(key)[0] : 'createdAt'
  const dir = typeof key === 'object' ? key[field] : 'asc'
  return [...rows].sort((a, b) => {
    const av = a[field] instanceof Date ? a[field].getTime() : a[field]
    const bv = b[field] instanceof Date ? b[field].getTime() : b[field]
    if (av === bv) return dir === 'desc' ? b._seq - a._seq : a._seq - b._seq
    return dir === 'desc' ? (bv > av ? 1 : -1) : (av > bv ? 1 : -1)
  })
}

function stamp(row: any) {
  return { ...row, _seq: ++seq, createdAt: row.createdAt ?? new Date(), updatedAt: new Date() }
}

const fakeDb: any = {
  unit: {
    findUnique: async ({ where }: any) => {
      const row = units.find((u) => matches(u, where))
      return row ? { ...row, program: { ...row.program } } : null
    },
  },
  book: {
    findUnique: async ({ where }: any) => (book && matches(book, where) ? { ...book } : null),
  },
  bookChunk: {
    findMany: async ({ where, orderBy }: any) =>
      sortRows(chunks.filter((c) => matches(c, where)).map((c) => ({ ...c })), orderBy ?? { index: 'asc' }),
    findUnique: async ({ where }: any) => chunks.find((c) => matches(c, where)) || null,
  },
  bookKnowledgeItem: {
    findMany: async ({ where }: any) => knowledge.filter((k) => matches(k, where)).map((k) => ({ ...k })),
    findUnique: async ({ where }: any) => knowledge.find((k) => matches(k, where)) || null,
  },
  unitGenerationJob: {
    findFirst: async ({ where, orderBy }: any) => sortRows(generationJobs.filter((j) => matches(j, where)), orderBy)[0] ? { ...sortRows(generationJobs.filter((j) => matches(j, where)), orderBy)[0] } : null,
    create: async ({ data }: any) => {
      const job = stamp({ id: `genjob-${generationJobs.length + 1}`, unitsTotal: 1, unitsDone: 0, lastError: null, retryAt: null, lockedUntil: null, startedAt: null, finishedAt: null, ...data })
      generationJobs.push(job)
      return { ...job }
    },
    update: async ({ where, data }: any) => {
      const job = generationJobs.find((j) => j.id === where.id)
      if (!job) throw new Error('JOB_NOT_FOUND')
      Object.assign(job, data, { updatedAt: new Date() })
      return { ...job }
    },
    updateMany: async ({ where, data }: any) => {
      const matched = generationJobs.filter((j) => matches(j, where))
      for (const job of matched) Object.assign(job, data, { updatedAt: new Date() })
      return { count: matched.length }
    },
  },
  unitRegenerationDraft: {
    deleteMany: async ({ where }: any) => {
      const before = drafts.length
      drafts = drafts.filter((d) => !matches(d, where))
      return { count: before - drafts.length }
    },
    create: async ({ data }: any) => {
      const draft = stamp({ id: `draft-${drafts.length + 1}`, ...data })
      drafts.push(draft)
      return { ...draft }
    },
  },
  unitRegenerationIntent: {
    findFirst: async ({ where, orderBy }: any) => {
      const rows = sortRows(intents.filter((i) => matches(i, where)), orderBy)
      return rows[0] ? { ...rows[0] } : null
    },
    findMany: async ({ where, orderBy }: any) => sortRows(intents.filter((i) => matches(i, where)), orderBy).map((i) => ({ ...i })),
    create: async ({ data }: any) => {
      if (intents.some((i) => i.unitId === data.unitId && i.status === data.status)) {
        const error: any = new Error('Unique constraint failed')
        error.code = 'P2002'
        throw error
      }
      const intent = stamp({ id: `intent-${intents.length + 1}`, repairJobId: null, resolution: null, resolvedAt: null, ...data })
      intents.push(intent)
      return { ...intent }
    },
    update: async ({ where, data }: any) => {
      const intent = intents.find((i) => i.id === where.id)
      if (!intent) throw new Error('INTENT_NOT_FOUND')
      Object.assign(intent, data, { updatedAt: new Date() })
      return { ...intent }
    },
    updateMany: async ({ where, data }: any) => {
      const matched = intents.filter((i) => matches(i, where))
      for (const intent of matched) Object.assign(intent, data, { updatedAt: new Date() })
      return { count: matched.length }
    },
  },
  bookRepairJob: {
    findFirst: async ({ where, orderBy }: any) => {
      const rows = sortRows(repairJobs.filter((j) => matches(j, where)), orderBy)
      return rows[0] ? { ...rows[0] } : null
    },
    findUnique: async ({ where }: any) => {
      const job = repairJobs.find((j) => j.id === where.id)
      return job ? { ...job } : null
    },
    create: async ({ data }: any) => {
      const job = stamp({
        id: `repair-${repairJobs.length + 1}`, mode: 'SCAN',
        chunksTotal: 0, chunksHealthy: 0, chunksCorrected: 0, chunksRemaining: 0, chunksNeedsReview: 0,
        itemsTotal: 0, itemsHealthy: 0, itemsCorrected: 0, itemsRemaining: 0, itemsNeedsReview: 0,
        progress: null, lastError: null, startedAt: null, finishedAt: null, ...data,
      })
      repairJobs.push(job)
      return { ...job }
    },
    update: async ({ where, data }: any) => {
      const job = repairJobs.find((j) => j.id === where.id)
      if (!job) throw new Error('REPAIR_JOB_NOT_FOUND')
      Object.assign(job, data, { updatedAt: new Date() })
      return { ...job }
    },
  },
  $transaction: async (fn: (tx: any) => any) => fn(fakeDb),
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', name: 'Admin', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ audit: async () => undefined }))
const realGemini = await import('../../src/lib/gemini')
mock.module('@/lib/gemini', () => ({
  ...realGemini,
  geminiCompleteJson: async () => { geminiCalls++; return generatedJson() },
  isAuthError: () => false,
  isModelUnavailableError: () => false,
  isQuotaError: () => false,
  isTransientGeminiError: () => false,
}))
mock.module('@/lib/storage', () => ({ getFileBufferFromStorageOrBase64: async () => storageImpl() }))

const { POST } = await import('../../src/app/api/admin/program-units/[unitId]/regenerate/route')
const { resumePendingUnitRegenerations } = await import('../../src/lib/unit-regeneration-link')

const root = join(import.meta.dir, '..', '..')
const regenerateRouteSrc = readFileSync(join(root, 'src/app/api/admin/program-units/[unitId]/regenerate/route.ts'), 'utf8')
const scanRouteSrc = readFileSync(join(root, 'src/app/api/admin/books/[id]/repair-corrupt-pages/route.ts'), 'utf8')
const cronRouteSrc = readFileSync(join(root, 'src/app/api/cron/book-read-jobs/route.ts'), 'utf8')
const linkSrc = readFileSync(join(root, 'src/lib/unit-regeneration-link.ts'), 'utf8')
const coreSrc = readFileSync(join(root, 'src/lib/unit-regeneration.ts'), 'utf8')
const migrationSql = readFileSync(join(root, 'prisma/migrations/20261124130000_unit_regeneration_intent/migration.sql'), 'utf8')
const schemaSrc = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8')

async function postRegenerate(unitId = 'unit-1', body: any = {}) {
  const req = new NextRequest(`http://localhost/api/admin/program-units/${unitId}/regenerate`, { method: 'POST', body: JSON.stringify(body) })
  const res = await POST(req, { params: Promise.resolve({ unitId }) })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function deferOnce() {
  const res = await postRegenerate()
  expect(res.status).toBe(202)
  expect(res.data.deferred).toBe(true)
  return res.data
}

function completeRepairJob() {
  repairJobs[0].status = 'COMPLETED'
  repairJobs[0].finishedAt = new Date()
}

beforeEach(() => { resetState() })

describe('202 deferral (repair first, never skip, never refuse early)', () => {
  test('garbled sources + no repair job → 202, a QUEUED repair job is created, intent PENDING, no draft, no generation call', async () => {
    const res = await postRegenerate()
    expect(res.status).toBe(202)
    expect(res.data.deferred).toBe(true)
    expect(res.data.error).toBe('REPAIR_RUNNING')
    expect(res.data.repairJobId).toBeTruthy()
    expect(res.data.intentId).toBeTruthy()
    expect(res.data.message).toContain('سيستكمل التوليد تلقائياً')
    expect(repairJobs).toHaveLength(1)
    expect(repairJobs[0].status).toBe('QUEUED')
    expect(repairJobs[0].mode).toBe('SCAN')
    expect(intents).toHaveLength(1)
    expect(intents[0].status).toBe('PENDING')
    expect(intents[0].unitId).toBe('unit-1')
    expect(intents[0].bookId).toBe('book-1')
    expect(intents[0].repairJobId).toBe(repairJobs[0].id)
    expect(drafts).toHaveLength(0)
    expect(generationJobs).toHaveLength(0)
    expect(geminiCalls).toBe(0)
  })

  test('an already-active repair job is reused — no second job is created', async () => {
    repairJobs.push(stamp({ id: 'repair-seeded', bookId: 'book-1', programId: 'prog-1', status: 'RUNNING', mode: 'SCAN' }))
    const res = await postRegenerate()
    expect(res.status).toBe(202)
    expect(res.data.repairJobId).toBe('repair-seeded')
    expect(repairJobs).toHaveLength(1)
    expect(intents).toHaveLength(1)
    expect(intents[0].repairJobId).toBe('repair-seeded')
  })

  test('a second deferral reuses the same intent (duplicate prevented)', async () => {
    const first = await deferOnce()
    const second = await postRegenerate()
    expect(second.status).toBe(202)
    expect(second.data.intentId).toBe(first.intentId)
    expect(intents).toHaveLength(1)
    expect(repairJobs).toHaveLength(1)
  })

  test('healthy sources → no repair job, no intent, generation runs immediately', async () => {
    chunks = [cleanChunk(0), cleanChunk(1)]
    const res = await postRegenerate()
    expect(res.status).toBe(200)
    expect(res.data.ok).toBe(true)
    expect(res.data.draft).toBeTruthy()
    expect(repairJobs).toHaveLength(0)
    expect(intents).toHaveLength(0)
    expect(geminiCalls).toBe(1)
  })

  test('unreadable PDF falls through to exclusion (draft from healthy sources), never defers', async () => {
    storageImpl = async () => null
    const res = await postRegenerate()
    expect(res.status).toBe(200)
    expect(res.data.draft).toBeTruthy()
    expect(JSON.parse(drafts[0].gaps).skippedChunkIndexes).toEqual([1])
    expect(repairJobs).toHaveLength(0)
    expect(intents).toHaveLength(0)
  })

  test('unreadable PDF + nothing healthy → refusal, never defers', async () => {
    storageImpl = async () => null
    chunks = [garbledChunk(0)]
    const res = await postRegenerate()
    expect(res.status).toBe(400)
    expect(res.data.error).toBe('UNIT_SOURCE_REQUIRES_REPAIR')
    expect(repairJobs).toHaveLength(0)
    expect(intents).toHaveLength(0)
  })
})

describe('auto-resume after the repair finishes', () => {
  test('repair completes and fixes the chunk → resume generates a draft and resolves the intent', async () => {
    await deferOnce()
    chunks[1].text = cleanText
    completeRepairJob()
    const resumed = await resumePendingUnitRegenerations('book-1', { deadlineMs: Date.now() + 210_000 })
    expect(resumed.resolved).toBe(1)
    expect(resumed.results[0].outcome).toBe('DRAFT_CREATED')
    expect(drafts).toHaveLength(1)
    expect(intents[0].status).toBe('RESOLVED')
    expect(intents[0].resolution).toBe('DRAFT_CREATED')
    expect(intents[0].resolvedAt).toBeTruthy()
    expect(geminiCalls).toBe(1)
  })

  test('exclusion applies ONLY after exhaustion: repair COMPLETED with garbled chunk remaining → draft from healthy sources with gaps', async () => {
    await deferOnce()
    completeRepairJob()
    const resumed = await resumePendingUnitRegenerations('book-1', { deadlineMs: Date.now() + 210_000 })
    expect(resumed.results[0].outcome).toBe('DRAFT_CREATED')
    expect(drafts).toHaveLength(1)
    expect(JSON.parse(drafts[0].gaps).skippedChunkIndexes).toEqual([1])
    expect(JSON.parse(drafts[0].gaps).healthyChunkCount).toBe(1)
    expect(intents[0].status).toBe('RESOLVED')
    expect(intents[0].resolution).toBe('DRAFT_CREATED')
  })

  test('refusal when nothing healthy remains after exhaustion', async () => {
    chunks = [garbledChunk(0)]
    await deferOnce()
    completeRepairJob()
    const resumed = await resumePendingUnitRegenerations('book-1', { deadlineMs: Date.now() + 210_000 })
    expect(resumed.results[0].outcome).toBe('REFUSED_NO_HEALTHY_SOURCES')
    expect(drafts).toHaveLength(0)
    expect(intents[0].status).toBe('RESOLVED')
    expect(intents[0].resolution).toBe('REFUSED_NO_HEALTHY_SOURCES')
  })

  test.each(['PAUSED', 'FAILED'])('intent survives a %s repair job: stays PENDING, no generation', async (status) => {
    await deferOnce()
    repairJobs[0].status = status
    const resumed = await resumePendingUnitRegenerations('book-1', { deadlineMs: Date.now() + 210_000 })
    expect(resumed.results[0].outcome).toBe('STILL_PENDING')
    expect(resumed.resolved).toBe(0)
    expect(drafts).toHaveLength(0)
    expect(geminiCalls).toBe(0)
    expect(intents[0].status).toBe('PENDING')
  })

  test('resume does not touch repair progress or counters', async () => {
    await deferOnce()
    repairJobs[0].chunksCorrected = 1
    repairJobs[0].chunksRemaining = 0
    repairJobs[0].itemsCorrected = 3
    repairJobs[0].progress = JSON.stringify({ repairedChunkIds: ['chunk-1'] })
    completeRepairJob()
    const before = JSON.stringify(repairJobs[0])
    await resumePendingUnitRegenerations('book-1', { deadlineMs: Date.now() + 210_000 })
    expect(JSON.stringify(repairJobs[0])).toBe(before)
  })

  test('insufficient budget → intent stays PENDING, nothing is marked', async () => {
    await deferOnce()
    completeRepairJob()
    const resumed = await resumePendingUnitRegenerations('book-1', { deadlineMs: Date.now() + 10_000 })
    expect(resumed.results[0].outcome).toBe('SKIPPED')
    expect(drafts).toHaveLength(0)
    expect(geminiCalls).toBe(0)
    expect(intents[0].status).toBe('PENDING')
  })
})

describe('re-entry and cancel', () => {
  test('POST after repair COMPLETED heals the timeout edge: generates immediately instead of deferring again', async () => {
    await deferOnce()
    completeRepairJob()
    const res = await postRegenerate()
    expect(res.status).toBe(200)
    expect(res.data.draft).toBeTruthy()
    expect(drafts).toHaveLength(1)
    expect(intents[0].status).toBe('RESOLVED')
    expect(intents[0].resolution).toBe('DRAFT_CREATED')
  })

  test('CANCEL flips a PENDING intent to CANCELLED and resume then finds nothing to do', async () => {
    await deferOnce()
    const cancelled = await postRegenerate('unit-1', { action: 'CANCEL' })
    expect(cancelled.status).toBe(200)
    expect(cancelled.data.cancelled).toBe(true)
    expect(intents[0].status).toBe('CANCELLED')
    expect(intents[0].resolution).toBe('CANCELLED_BY_ADMIN')
    completeRepairJob()
    const resumed = await resumePendingUnitRegenerations('book-1', { deadlineMs: Date.now() + 210_000 })
    expect(resumed.results).toHaveLength(0)
    expect(drafts).toHaveLength(0)
    expect(geminiCalls).toBe(0)
  })

  test('CANCEL with no pending intent → 404', async () => {
    const res = await postRegenerate('unit-1', { action: 'CANCEL' })
    expect(res.status).toBe(404)
    expect(res.data.error).toBe('REGENERATION_INTENT_NOT_FOUND')
  })
})

describe('wiring pins (source)', () => {
  test('the regenerate route defers with 202 + REPAIR_RUNNING and supports CANCEL', () => {
    expect(regenerateRouteSrc).toContain('REPAIR_RUNNING')
    expect(regenerateRouteSrc).toContain('status: 202')
    expect(regenerateRouteSrc).toContain("action: 'CANCEL'")
    expect(regenerateRouteSrc).toContain('maybeDeferUnitRegenerationForRepair')
    expect(regenerateRouteSrc).toContain('runUnitRegeneration')
  })

  test('the SCAN route resumes pending regenerations when a step finishes the repair', () => {
    expect(scanRouteSrc).toContain('resumePendingUnitRegenerations')
    expect(scanRouteSrc).toContain('step.done')
  })

  test('the cron advances repair jobs one bounded step each and runs the resume backstop', () => {
    expect(cronRouteSrc).toContain('runBookRepairScanStep')
    expect(cronRouteSrc).toContain('resumePendingUnitRegenerations')
    expect(cronRouteSrc).toContain('REPAIR_COMPLETED')
    expect(cronRouteSrc).toContain('SKIPPED_READ_JOB_ACTIVE')
    expect(cronRouteSrc).toContain('endAt - 48_000')
  })

  test('the link resolves an intent only after a draft or a final refusal, and skips on low budget', () => {
    expect(linkSrc).toContain('isBookRepairExhausted')
    expect(linkSrc).toContain('RESUME_MIN_GENERATION_BUDGET_MS')
    expect(linkSrc).toContain("resolvePendingRegenerationIntent(intent.unitId, 'DRAFT_CREATED')")
    expect(linkSrc).toContain("resolvePendingRegenerationIntent(intent.unitId, 'REFUSED_NO_HEALTHY_SOURCES')")
    expect(linkSrc).toContain('STILL_PENDING')
  })

  test('the extracted core never writes the Unit row', () => {
    expect(coreSrc).toContain('unitRegenerationDraft.create')
    expect(coreSrc).not.toContain('db.unit.update')
    expect(coreSrc).not.toContain('tx.unit.update')
  })

  test('the intent model, back-relation and migration exist and are additive-only', () => {
    expect(schemaSrc).toContain('model UnitRegenerationIntent')
    expect(schemaSrc).toContain('regenerationIntents UnitRegenerationIntent[]')
    expect(schemaSrc).toContain('@@unique([unitId, status])')
    expect(schemaSrc).toContain('@@index([bookId, status])')
    expect(migrationSql).toContain('CREATE TABLE "UnitRegenerationIntent"')
    expect(migrationSql).toContain('UnitRegenerationIntent_unitId_status_key')
    expect(migrationSql).not.toContain('DROP')
    expect(migrationSql).not.toContain('ALTER TABLE "Unit"')
  })
})
