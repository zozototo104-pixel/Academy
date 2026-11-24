import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Part 1: two-level enrichment. Base pass ends at 10 items per chunk; the
// optional extra pass continues the SAME items to 20 — no re-extraction, no
// deletion. The target lives on the BookReadJob and survives stop/resume/
// retry. Only 10 and 20 are legal targets; anything else resolves to 10.
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN' }) }))
mock.module('@/lib/storage', () => ({ getFileBufferFromStorageOrBase64: async () => null }))
mock.module('@/lib/notify', () => ({ audit: async () => undefined }))

// In-memory fake DB for the read-job route (same pattern as the repair
// route tests): real route code, no production records.
let jobs: any[] = []
let chunks: any[] = []
let items: any[] = []
let repairJobs: any[] = []

function matches(row: any, where: any): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    const value = row[key]
    if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('in' in cond) return (cond.in as unknown[]).includes(value)
      if ('not' in cond) return cond.not === null ? value !== null : value !== cond.not
      if ('gte' in cond) return typeof value === 'number' && value >= cond.gte
      if ('lte' in cond) return typeof value === 'number' && value <= cond.lte
      if ('gt' in cond) return typeof value === 'number' && value > cond.gt
      return false
    }
    return value === cond
  })
}

function latestFirst(rows: any[]) {
  return [...rows].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

const readJobDb: any = {
  book: { findUnique: async () => ({ id: 'book-1', programId: 'program-1' }) },
  bookReadJob: {
    findFirst: async ({ where }: any) => latestFirst(jobs.filter((job) => matches(job, where)))[0] || null,
    findUnique: async ({ where }: any) => jobs.find((job) => job.id === where.id) || null,
    findUniqueOrThrow: async ({ where }: any) => {
      const job = jobs.find((item) => item.id === where.id)
      if (!job) throw new Error('JOB_NOT_FOUND')
      return { ...job }
    },
    create: async ({ data }: any) => {
      const job = { id: `job-${jobs.length + 1}`, createdAt: new Date(), totalPages: 0, chunksFailed: 0, retryAt: null, lockedUntil: null, finishedAt: null, lastError: null, ...data }
      jobs.push(job)
      return { ...job }
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const job of jobs) {
        if (!matches(job, where)) continue
        Object.assign(job, data)
        count++
      }
      return { count }
    },
    update: async ({ where, data }: any) => {
      const job = jobs.find((item) => item.id === where.id)
      if (!job) throw new Error('JOB_NOT_FOUND')
      Object.assign(job, data)
      return { ...job }
    },
  },
  bookChunk: {
    count: async ({ where }: any) => chunks.filter((chunk) => matches(chunk, where)).length,
    findMany: async ({ where }: any) => chunks.filter((chunk) => matches(chunk, where)).map((chunk) => ({ ...chunk })),
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const chunk of chunks) {
        if (!matches(chunk, where)) continue
        Object.assign(chunk, data)
        count++
      }
      return { count }
    },
  },
  bookKnowledgeItem: {
    count: async ({ where }: any) => items.filter((item) => matches(item, where)).length,
    groupBy: async ({ where }: any) => {
      const counts = new Map<string, number>()
      for (const item of items) {
        if (!matches(item, where)) continue
        counts.set(item.chunkId, (counts.get(item.chunkId) || 0) + 1)
      }
      return [...counts.entries()].map(([chunkId, total]) => ({ chunkId, _count: { _all: total } }))
    },
  },
  bookRepairJob: {
    findFirst: async ({ where }: any) => repairJobs.find((job) => matches(job, where)) || null,
  },
  $transaction: async (callback: (tx: any) => Promise<unknown>) => callback(readJobDb),
}
mock.module('@/lib/db', () => ({ db: readJobDb }))

const readJobApi = await import('@/app/api/admin/books/[id]/read-job/route')

function postReadJob(body: any) {
  return readJobApi.POST(
    new NextRequest('https://academy.test/api/admin/books/book-1/read-job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'book-1' }) },
  )
}

function seedJob(overrides: any) {
  const job = {
    id: `job-${jobs.length + 1}`, bookId: 'book-1', programId: 'program-1',
    phase: 'ENRICH', status: 'COMPLETED', totalPages: 0, chunksFailed: 0,
    retryAt: null, lockedUntil: null, finishedAt: new Date(), lastError: null,
    enrichmentTarget: 10, createdAt: new Date(),
  }
  jobs.push({ ...job, ...overrides })
  return jobs[jobs.length - 1]
}

function seedChunk(overrides: any) {
  const chunk = {
    id: `chunk-${chunks.length + 1}`, bookId: 'book-1', status: 'ANALYZED',
    saturatedAt: null, analysisPasses: 0, index: chunks.length,
  }
  chunks.push({ ...chunk, ...overrides })
  return chunks[chunks.length - 1]
}

const analyzer = await import('../../src/lib/book-chunk-analyzer')
const { enrichStepWithStore, resolveEnrichmentTarget, enrichChunkSaturates, enrichmentCompletionKind } = analyzer

const excerptA = 'الأصول المتداولة هي الأصول التي يتوقع تحويلها إلى نقد خلال سنة مالية واحدة من تاريخ القوائم المالية للمنشأة.'
const excerptB = 'الخصوم المتداولة هي الالتزامات التي تستحق السداد خلال سنة مالية واحدة وتشمل الذمم الدائنة والمصروفات المستحقة.'
const chunkText = `يتناول هذا المقطع أسس المحاسبة المالية. ${excerptA} كما يشرح طبيعة الالتزامات قصيرة الأجل. ${excerptB} ويبين الفرق بين الأصول والخصوم في قائمة المركز المالي للمنشأة التجارية.`

function candidate(title: string, summary: string, excerpt: string) {
  return { category: 'CONCEPT', title, summary, excerpt, importance: 50 }
}

function makeStore(target: number | null | undefined, ownCount: number, analyzerReturns: any[]) {
  const items: { title: string; summary: string }[] = Array.from(
    { length: ownCount },
    (_, i) => ({ title: `عنصر موجود فريد تماما رقم ${i}`, summary: `ملخص موجود مختلف تماما عن غيره رقم ${i} يشرح جانبا آخر` }),
  )
  const saves: { capacity?: number; target?: number; count: number }[] = []
  let finishCalls = 0
  let analyzeCalls = 0
  const store = {
    getJob: async () => ({ id: 'job-1', bookId: 'book-1', phase: 'ENRICH', enrichmentTarget: target }),
    nextChunk: async () => ({
      id: 'chunk-1', bookId: 'book-1', programId: 'program-1', index: 0,
      text: chunkText, pageStart: 1, pageEnd: 2, textProvenance: 'NATIVE_TEXT', analysisPasses: 0,
    }),
    existing: async () => ({ local: [...items], own: [...items] }),
    save: async (_chunk: any, newItems: any[], capacity?: number, target?: number) => {
      saves.push({ capacity, target, count: newItems.length })
      items.push(...newItems.map((item: any) => ({ title: item.title, summary: item.summary })))
    },
    finish: async () => { finishCalls++ },
  }
  const analyze = async () => { analyzeCalls++; return [...analyzerReturns] }
  return { items, saves, store, analyze, get finishCalls() { return finishCalls }, get analyzeCalls() { return analyzeCalls } }
}

// A store with no chunks left: the step finishes the job immediately.
function makeFinishingStore(target: number | null | undefined) {
  let finishCalls = 0
  const store = {
    getJob: async () => ({ id: 'job-1', bookId: 'book-1', phase: 'ENRICH', enrichmentTarget: target }),
    nextChunk: async () => null,
    existing: async () => ({ local: [], own: [] }),
    save: async () => {},
    finish: async () => { finishCalls++ },
  }
  const analyze = async () => []
  return { store, analyze, get finishCalls() { return finishCalls } }
}

const twoNew = [
  candidate('الأصول المتداولة', 'تعريف الأصول المتداولة وطبيعتها في القوائم المالية.', excerptA),
  candidate('الخصوم المتداولة', 'تعريف الخصوم المتداولة وطبيعتها في القوائم المالية.', excerptB),
]

describe('enrichment target resolution', () => {
  test('only 10 and 20 are legal targets; anything else resolves to the base 10', () => {
    expect(resolveEnrichmentTarget(null)).toBe(10)
    expect(resolveEnrichmentTarget(undefined)).toBe(10)
    expect(resolveEnrichmentTarget(10)).toBe(10)
    expect(resolveEnrichmentTarget(20)).toBe(20)
    expect(resolveEnrichmentTarget(15)).toBe(10)
    expect(resolveEnrichmentTarget(0)).toBe(10)
    expect(resolveEnrichmentTarget(25)).toBe(10)
  })

  test('saturation is target-driven: 10 is not final saturation under a 20 target', () => {
    expect(enrichChunkSaturates({ capacity: 0, available: 0, rowsBefore: 10, accepted: 0, target: 10 })).toBe(true)
    expect(enrichChunkSaturates({ capacity: 10, available: 10, rowsBefore: 10, accepted: 0, target: 20 })).toBe(false)
    expect(enrichChunkSaturates({ capacity: 1, available: 1, rowsBefore: 19, accepted: 1, target: 20 })).toBe(true)
    expect(enrichChunkSaturates({ capacity: 1, available: 1, rowsBefore: 19, accepted: 0, target: 20 })).toBe(false)
    expect(enrichChunkSaturates({ capacity: 0, available: 0, rowsBefore: 20, accepted: 0, target: 20 })).toBe(true)
  })
})

describe('base completion vs final saturation', () => {
  // Claim 9: the job status must TELL base completion (10) apart from final
  // saturation (20) — the target number alone is only implicit.
  test('the completion kind names the job target: 10 is base-complete, 20 is finally saturated', () => {
    expect(enrichmentCompletionKind(null)).toBe('BASE_COMPLETE')
    expect(enrichmentCompletionKind(undefined)).toBe('BASE_COMPLETE')
    expect(enrichmentCompletionKind(10)).toBe('BASE_COMPLETE')
    expect(enrichmentCompletionKind(15)).toBe('BASE_COMPLETE')
    expect(enrichmentCompletionKind(20)).toBe('FINAL_SATURATED')
  })

  test('a finishing base step reports BASE_COMPLETE', async () => {
    const finishing = makeFinishingStore(null)
    const result = await enrichStepWithStore('job-1', Date.now() + 120_000, finishing.store as any, finishing.analyze as any)
    expect(result.completed).toBe(true)
    expect(result.enrichmentCompletion).toBe('BASE_COMPLETE')
    expect(finishing.finishCalls).toBe(1)
  })

  test('a finishing extra step reports FINAL_SATURATED', async () => {
    const finishing = makeFinishingStore(20)
    const result = await enrichStepWithStore('job-1', Date.now() + 120_000, finishing.store as any, finishing.analyze as any)
    expect(result.completed).toBe(true)
    expect(result.enrichmentCompletion).toBe('FINAL_SATURATED')
  })

  test('the read-step enrichment payload names the same kind (inline, same 20-only decision as the helper)', () => {
    // The read-step route intentionally does NOT import the analyzer helper
    // (its mock in the mutual-exclusion tests carries only the step
    // functions); this pin keeps its inline ternary identical to the helper.
    const root = join(import.meta.dir, '..', '..')
    const readStep = readFileSync(join(root, 'src/app/api/admin/books/[id]/read-step/route.ts'), 'utf8')
    expect(readStep).toContain("completionKind: job.enrichmentTarget === 20 ? 'FINAL_SATURATED' : 'BASE_COMPLETE'")
    expect(readStep).not.toContain('runEnrichStep, enrichmentCompletionKind')
  })
})

describe('two-level enrichment step', () => {
  test('base target: a chunk at 10 items is done — no AI call, capacity 0', async () => {
    const { store, analyze, saves } = makeStore(null, 10, twoNew)
    const result = await enrichStepWithStore('job-1', Date.now() + 120_000, store as any, analyze as any)
    expect(result.added).toBe(0)
    expect(saves).toHaveLength(1)
    expect(saves[0].capacity).toBe(0)
    expect(saves[0].target).toBe(10)
  })

  test('extra target: a chunk at 10 items continues to 20 without touching the existing items', async () => {
    const { items, store, analyze, saves } = makeStore(20, 10, twoNew)
    const before = items.map((item) => item.title)
    const result = await enrichStepWithStore('job-1', Date.now() + 120_000, store as any, analyze as any)
    expect(result.added).toBe(2)
    expect(saves).toHaveLength(1)
    expect(saves[0].capacity).toBe(10)
    expect(saves[0].target).toBe(20)
    expect(items).toHaveLength(12)
    expect(items.slice(0, 10).map((item) => item.title)).toEqual(before)
  })

  test('extra target: a chunk already at 20 items is finally saturated — no AI call', async () => {
    const { store, analyze, saves } = makeStore(20, 20, twoNew)
    const result = await enrichStepWithStore('job-1', Date.now() + 120_000, store as any, analyze as any)
    expect(result.added).toBe(0)
    expect(saves).toHaveLength(1)
    expect(saves[0].capacity).toBe(0)
    expect(saves[0].target).toBe(20)
  })

  test('base target: capacity caps the accepted items at the target', async () => {
    const { store, analyze, saves } = makeStore(10, 8, [...twoNew, ...twoNew, ...twoNew])
    const result = await enrichStepWithStore('job-1', Date.now() + 120_000, store as any, analyze as any)
    expect(result.added).toBe(2)
    expect(saves[0].capacity).toBe(2)
    expect(saves[0].count).toBe(2)
  })

  test('zero yield never invents items: the chunk stays open for its next pass', async () => {
    const { store, analyze, saves } = makeStore(null, 8, [])
    const result = await enrichStepWithStore('job-1', Date.now() + 120_000, store as any, analyze as any)
    expect(result.added).toBe(0)
    expect(result.completed).toBe(false)
    expect(saves).toHaveLength(1)
    expect(saves[0].count).toBe(0)
  })
})

describe('read-job route: enrichment target on the job row', () => {
  beforeEach(() => {
    jobs = []
    chunks = []
    items = []
    repairJobs = []
    // One analyzed chunk so ENRICH creation passes its readability check.
    seedChunk({ id: 'chunk-base', status: 'ANALYZED' })
  })

  test('a base enrichment job stores target 10 and reopens exhausted chunks', async () => {
    seedChunk({ id: 'chunk-tired', status: 'ANALYZED', saturatedAt: null, analysisPasses: 3 })
    const response = await postReadJob({ mode: 'ENRICH' })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.job.phase).toBe('ENRICH')
    expect(body.job.enrichmentTarget).toBe(10)
    expect(chunks.find((chunk) => chunk.id === 'chunk-tired')?.analysisPasses).toBe(0)
  })

  test('an extra enrichment job stores target 20 and reopens only chunks below 20 items', async () => {
    const atTen = seedChunk({ id: 'chunk-ten', status: 'ANALYZED', saturatedAt: new Date('2026-11-24T08:00:00Z'), analysisPasses: 0 })
    const atTwenty = seedChunk({ id: 'chunk-twenty', status: 'ANALYZED', saturatedAt: new Date('2026-11-24T08:00:00Z'), analysisPasses: 0 })
    for (let i = 0; i < 10; i++) items.push({ bookId: 'book-1', chunkId: 'chunk-ten', kbVersion: 2 })
    for (let i = 0; i < 20; i++) items.push({ bookId: 'book-1', chunkId: 'chunk-twenty', kbVersion: 2 })
    const response = await postReadJob({ mode: 'ENRICH', enrichmentTarget: 20 })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.job.enrichmentTarget).toBe(20)
    expect(atTen.saturatedAt).toBeNull()
    expect(atTen.analysisPasses).toBe(0)
    expect(atTwenty.saturatedAt).not.toBeNull()
  })

  test('any target other than 20 resolves to the base 10', async () => {
    const response = await postReadJob({ mode: 'ENRICH', enrichmentTarget: 15 })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.job.enrichmentTarget).toBe(10)
  })

  test('a running repair job blocks new enrichment (criterion 4)', async () => {
    repairJobs.push({ id: 'repair-1', bookId: 'book-1', status: 'RUNNING' })
    const response = await postReadJob({ mode: 'ENRICH' })
    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe('BOOK_REPAIR_JOB_ACTIVE')
    expect(jobs).toHaveLength(0)
  })

  test('a completed repair job does not block new enrichment', async () => {
    repairJobs.push({ id: 'repair-1', bookId: 'book-1', status: 'COMPLETED' })
    const response = await postReadJob({ mode: 'ENRICH' })
    expect(response.status).toBe(200)
    expect(jobs).toHaveLength(1)
  })

  test('the target survives STOP and RESUME on the same job row', async () => {
    const job = seedJob({ phase: 'ENRICH', status: 'RUNNING', enrichmentTarget: 20, createdAt: new Date('2026-11-24T09:00:00Z') })
    const stopped = await postReadJob({ action: 'STOP' })
    expect(stopped.status).toBe(200)
    expect((await stopped.json()).job.enrichmentTarget).toBe(20)
    expect(job.status).toBe('PAUSED')
    const resumed = await postReadJob({ action: 'RESUME' })
    expect(resumed.status).toBe(200)
    expect((await resumed.json()).job.enrichmentTarget).toBe(20)
    expect(job.status).toBe('QUEUED')
    expect(job.id).toBe(job.id)
  })

  test('a failed extra-enrichment job resumes in place with its target intact', async () => {
    const job = seedJob({ phase: 'ENRICH', status: 'FAILED', enrichmentTarget: 20, createdAt: new Date('2026-11-24T09:00:00Z') })
    const response = await postReadJob({ mode: 'ENRICH' })
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.resumed).toBe(true)
    expect(body.job.id).toBe(job.id)
    expect(body.job.enrichmentTarget).toBe(20)
    expect(body.job.status).toBe('QUEUED')
  })
})

describe('read-job GET: enrichment completion kind', () => {
  beforeEach(() => {
    jobs = []
    chunks = []
    items = []
    repairJobs = []
    seedChunk({ id: 'chunk-base', status: 'ANALYZED' })
  })

  async function getReadJob() {
    return readJobApi.GET(
      new NextRequest('https://academy.test/api/admin/books/book-1/read-job'),
      { params: Promise.resolve({ id: 'book-1' }) },
    )
  }

  test('a completed base job reports BASE_COMPLETE', async () => {
    seedJob({ phase: 'DONE', status: 'COMPLETED', enrichmentTarget: 10 })
    const body = await (await getReadJob()).json()
    expect(body.enrichment.completionKind).toBe('BASE_COMPLETE')
    expect(body.enrichment.enrichmentTarget).toBe(10)
  })

  test('a completed extra job reports FINAL_SATURATED', async () => {
    seedJob({ phase: 'DONE', status: 'COMPLETED', enrichmentTarget: 20 })
    const body = await (await getReadJob()).json()
    expect(body.enrichment.completionKind).toBe('FINAL_SATURATED')
  })

  test('a non-enrich job reports no completion kind', async () => {
    seedJob({ phase: 'DONE', status: 'COMPLETED', enrichmentTarget: null })
    const body = await (await getReadJob()).json()
    expect(body.enrichment.completionKind).toBeUndefined()
  })
})
