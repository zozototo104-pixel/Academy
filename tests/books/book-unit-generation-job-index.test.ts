import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Fix 2 (PR #212): partial unique index on UnitGenerationJob (unitId,
// phase) WHERE status IN ('QUEUED', 'RUNNING'). Two concurrent same-phase
// first-calls must collide on the index so the second gets ALREADY_RUNNING
// through the P2002 catch in runUnitRegeneration; a RUNNING job of a
// DIFFERENT phase must not block regeneration. There is no Postgres in the
// sandbox, so the fake DB below enforces EXACTLY the predicate the new
// migration creates (see activeJobClash), and the source tests pin the
// migration SQL itself. The fake stands in for the index, never for the
// code: runUnitRegeneration runs for real and unmodified.

const cleanText = 'الأصول المتداولة هي الأصول التي يتوقع تحويلها إلى نقد خلال سنة مالية واحدة، وتشمل النقدية والمخزون والذمم المدينة التي تتحول إلى نقد خلال دورة التشغيل العادية للمنشأة. '.repeat(4)
const cleanChunk = (index: number) => ({ id: `chunk-${index}`, bookId: 'book-1', index, pageStart: index * 2 + 1, pageEnd: index * 2 + 2, headingPath: 'الباب الأول', text: cleanText, contentHash: `hash-${index}`, status: 'ANALYZED' })
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
let p2002Throws = 0
let units: any[]
let chunks: any[]
let knowledge: any[]
let generationJobs: any[]
let drafts: any[]
let seq = 0

function resetState() {
  geminiCalls = 0
  p2002Throws = 0
  seq = 0
  units = [{
    id: 'unit-1', programId: 'prog-1', title: 'وحدة الأصول', sourceBookId: 'book-1',
    chunkStartIndex: 0, chunkEndIndex: 1,
    program: { id: 'prog-1', titleAr: 'برنامج المحاسبة', titleEn: 'Accounting' },
  }]
  chunks = [cleanChunk(0), cleanChunk(1)]
  knowledge = [cleanItem('item-clean', 'chunk-0')]
  generationJobs = []
  drafts = []
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

// The index under test, simulated: at most one QUEUED/RUNNING job per
// (unitId, phase) — the exact predicate of
// "UnitGenerationJob_active_unit_phase_key". A create that would violate
// it throws P2002, exactly as Prisma does on the real Postgres index.
// MUTATION NOTE: dropping `phase` from this predicate simulates the old
// unitId-only index; the coexistence tests below must then fail.
function activeJobClash(data: any): boolean {
  if (data.status !== 'QUEUED' && data.status !== 'RUNNING') return false
  return generationJobs.some((j) => j.unitId === data.unitId && j.phase === data.phase && (j.status === 'QUEUED' || j.status === 'RUNNING'))
}

const fakeDb: any = {
  unit: {
    findUnique: async ({ where }: any) => {
      const row = units.find((u) => matches(u, where))
      return row ? { ...row, program: { ...row.program } } : null
    },
  },
  bookChunk: {
    findMany: async ({ where, orderBy }: any) =>
      sortRows(chunks.filter((c) => matches(c, where)).map((c) => ({ ...c })), orderBy ?? { index: 'asc' }),
  },
  bookKnowledgeItem: {
    findMany: async ({ where }: any) => knowledge.filter((k) => matches(k, where)).map((k) => ({ ...k })),
  },
  unitGenerationJob: {
    findFirst: async ({ where, orderBy }: any) => {
      const rows = sortRows(generationJobs.filter((j) => matches(j, where)), orderBy)
      return rows[0] ? { ...rows[0] } : null
    },
    create: async ({ data }: any) => {
      if (activeJobClash(data)) {
        p2002Throws++
        const error: any = new Error('Unique constraint failed on the fields: (`unitId`, `phase`)')
        error.code = 'P2002'
        throw error
      }
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
  $transaction: async (fn: (tx: any) => any) => fn(fakeDb),
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
const realGemini = await import('../../src/lib/gemini')
mock.module('@/lib/gemini', () => ({
  ...realGemini,
  geminiCompleteJson: async () => { geminiCalls++; return generatedJson() },
  isAuthError: () => false,
  isModelUnavailableError: () => false,
  isQuotaError: () => false,
  isTransientGeminiError: () => false,
}))
mock.module('@/lib/storage', () => ({ getFileBufferFromStorageOrBase64: async () => ({ buffer: Buffer.from('%PDF-1.4 fake') }) }))

const { runUnitRegeneration } = await import('../../src/lib/unit-regeneration')

const root = join(import.meta.dir, '..', '..')
const migrationSql = readFileSync(join(root, 'prisma/migrations/20261124133500_unit_generation_job_active_phase_unique/migration.sql'), 'utf8')
const oldIndexSql = readFileSync(join(root, 'prisma/migrations/20261009191000_add_unit_generation_active_unique_index/migration.sql'), 'utf8')
const schemaSrc = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8')
const coreSrc = readFileSync(join(root, 'src/lib/unit-regeneration.ts'), 'utf8')

function seedJob(id: string, status: string, phase: string) {
  generationJobs.push(stamp({
    id, unitId: 'unit-1', programId: 'prog-1', status, phase,
    unitsTotal: 1, unitsDone: 0, startedAt: new Date(), lockedUntil: new Date(Date.now() + 240_000),
    finishedAt: status === 'COMPLETED' ? new Date() : null, lastError: null, retryAt: null,
  }))
}

beforeEach(() => { resetState() })

describe('same-phase race: the P2002 catch is the live guard', () => {
  test('two concurrent REGENERATE first-calls: one DRAFT_CREATED, the other ALREADY_RUNNING on the same job, one generation only', async () => {
    // Both calls pass the findFirst gate (no job exists yet) and race the
    // create; the second create must collide on the (unitId, phase)
    // index and be answered ALREADY_RUNNING by the P2002 catch — not by
    // a second generation and not by a thrown error.
    const [first, second] = await Promise.all([
      runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 }),
      runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 }),
    ])
    const outcomes = [first.outcome, second.outcome].sort()
    expect(outcomes).toEqual(['ALREADY_RUNNING', 'DRAFT_CREATED'])
    const created = [first, second].find((r) => r.outcome === 'DRAFT_CREATED') as any
    const waiting = [first, second].find((r) => r.outcome === 'ALREADY_RUNNING') as any
    expect(waiting.job.id).toBe(created.job.id)
    expect(p2002Throws).toBe(1)
    expect(generationJobs).toHaveLength(1)
    expect(generationJobs[0].status).toBe('COMPLETED')
    expect(generationJobs[0].phase).toBe('REGENERATE')
    expect(drafts).toHaveLength(1)
    expect(geminiCalls).toBe(1)
  })

  test('two sequential regenerations after the first completes both succeed (repeat jobs allowed)', async () => {
    const first = await runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 })
    expect(first.outcome).toBe('DRAFT_CREATED')
    const second = await runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 })
    expect(second.outcome).toBe('DRAFT_CREATED')
    expect(generationJobs).toHaveLength(2)
    expect(generationJobs.every((j) => j.status === 'COMPLETED' && j.phase === 'REGENERATE')).toBe(true)
    expect(geminiCalls).toBe(2)
  })
})

describe('cross-phase coexistence: a RUNNING job of another phase does not block regeneration', () => {
  test('a RUNNING CONTENT job + regenerate request → regenerate proceeds with its own job (not resumed)', async () => {
    seedJob('job-content', 'RUNNING', 'CONTENT')
    const result = await runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 })
    expect(result.outcome).toBe('DRAFT_CREATED')
    expect(p2002Throws).toBe(0)
    expect(geminiCalls).toBe(1)
    expect(generationJobs).toHaveLength(2)
    expect(generationJobs[0].status).toBe('RUNNING')
    expect(generationJobs[0].phase).toBe('CONTENT')
    expect(generationJobs[1].status).toBe('COMPLETED')
    expect(generationJobs[1].phase).toBe('REGENERATE')
    expect(drafts).toHaveLength(1)
  })

  test('a RUNNING GUIDE job + regenerate request → regenerate proceeds with its own job', async () => {
    seedJob('job-guide', 'RUNNING', 'GUIDE')
    const result = await runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 })
    expect(result.outcome).toBe('DRAFT_CREATED')
    expect(geminiCalls).toBe(1)
    expect(generationJobs).toHaveLength(2)
    expect(generationJobs[0].phase).toBe('GUIDE')
    expect(generationJobs[1].phase).toBe('REGENERATE')
  })

  test('a COMPLETED REGENERATE job does not block a new regeneration', async () => {
    seedJob('job-old', 'COMPLETED', 'REGENERATE')
    const result = await runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 })
    expect(result.outcome).toBe('DRAFT_CREATED')
    expect(generationJobs).toHaveLength(2)
    expect(geminiCalls).toBe(1)
  })
})

describe('migration + schema pins (source)', () => {
  test('the migration drops the old unitId-only index and creates the phase-scoped partial unique index', () => {
    expect(oldIndexSql).toContain('CREATE UNIQUE INDEX "UnitGenerationJob_active_unitId_key"')
    expect(migrationSql).toContain('DROP INDEX IF EXISTS "UnitGenerationJob_active_unitId_key"')
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "UnitGenerationJob_active_unit_phase_key" ON "UnitGenerationJob" ("unitId", "phase") WHERE "status" IN (\'QUEUED\', \'RUNNING\')')
    expect(migrationSql).not.toContain('ON "UnitGenerationJob" ("unitId")')
    expect(migrationSql).not.toMatch(/DROP TABLE|DELETE FROM|DROP COLUMN|ALTER TABLE "UnitGenerationJob" ADD/)
  })

  test('the schema documents the SQL-only index and adds no plain @@unique', () => {
    expect(schemaSrc).toContain('UnitGenerationJob_active_unit_phase_key')
    expect(schemaSrc).toContain('20261124133500_unit_generation_job_active_phase_unique')
    expect(schemaSrc).toContain('MUST NOT be mirrored here as @@unique')
    const modelBlock = schemaSrc.split('model UnitGenerationJob {')[1].split('\n}\n')[0]
    expect(modelBlock).not.toContain('@@unique')
    expect(modelBlock).toContain('@@index([unitId, status])')
  })

  test('the P2002 catch resolves the collision to the same-phase job', () => {
    expect(coreSrc).toContain("error?.code === 'P2002'")
    expect(coreSrc).toContain("phase: 'REGENERATE'")
  })
})
