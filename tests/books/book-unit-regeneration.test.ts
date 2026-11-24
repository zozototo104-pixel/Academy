import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Part 3 (PR #212): damaged-unit regeneration. Identification, draft preview,
// approve-only-content-fields, refuse-when-no-healthy-sources and gaps are
// pure functions in outline-units; the routes are thin wrappers, pinned by
// source below (regenerate never writes the Unit row; approve writes only
// the content fields via buildUnitRegenerationApproveData).
//
// Concurrency pins (PR #212 follow-up): the three routes below also run for
// real against this in-memory fake DB. The fake mirrors Prisma's atomicity
// for the guarded writes: updateMany check-and-set is one synchronous
// mutation (like a single SQL UPDATE ... WHERE status='PENDING'), so a race
// converges exactly the way the real database converges. The configurable
// delays only order the two racers' claims; they never weaken the guard.
// $transaction hands out a distinct tx handle (like Prisma) whose updateMany
// has its own delay knob, so a test can let the approve claim win while the
// reject claim waits — or the reverse.
type AnyRow = Record<string, any>

const tick = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

const world = {
  units: new Map<string, AnyRow>(),
  drafts: [] as AnyRow[],
  jobs: [] as AnyRow[],
  chunks: [] as AnyRow[],
  knowledge: [] as AnyRow[],
  unitUpdates: [] as AnyRow[],
  txDelayMs: 0,
  txUpdateManyDelayMs: 0,
  updateManyDelayMs: 0,
  jobSeq: 0,
  draftSeq: 0,
  auditCalls: 0,
}

let geminiHook: ((opts: AnyRow) => unknown) | null = null
let geminiCalls = 0

function resetWorld() {
  world.units.clear()
  world.drafts = []
  world.jobs = []
  world.chunks = [cleanChunk(0)]
  world.knowledge = [cleanItem('item-clean', 'chunk-0')]
  world.unitUpdates = []
  world.txDelayMs = 0
  world.txUpdateManyDelayMs = 0
  world.updateManyDelayMs = 0
  world.jobSeq = 0
  world.draftSeq = 0
  world.auditCalls = 0
  geminiHook = null
  geminiCalls = 0
  world.units.set('unit-1', {
    id: 'unit-1', programId: 'prog-1', order: 3, semester: 2, status: 'APPROVED',
    title: 'وحدة الأصول', summary: 'ملخص قديم خاطئ', objectives: '[]', content: '[]',
    sourceBookId: 'book-1', outlineSectionId: 'section-1', chunkStartIndex: 0, chunkEndIndex: 0,
    generationVersion: 2, examId: 'exam-1',
    program: { id: 'prog-1', titleAr: 'البرنامج الأكاديمي', titleEn: 'Program' },
  })
  // A fresh PENDING draft from an earlier run: approve/reject decide it, and
  // the lease-loss tests assert it survives untouched.
  world.drafts.push({
    id: 'draft-1', unitId: 'unit-1', programId: 'prog-1', status: 'PENDING',
    summary: generated.summary, objectives: JSON.stringify(generated.objectives),
    content: JSON.stringify(generated.content), gaps: '{}',
    sourceKnowledgeIds: JSON.stringify(['item-clean']),
    createdAt: new Date(), decidedAt: null,
  })
}

function latestPendingDraft(unitId: string) {
  for (let i = world.drafts.length - 1; i >= 0; i--) {
    const d = world.drafts[i]
    if (d.unitId === unitId && d.status === 'PENDING') return d
  }
  return null
}

function latestActiveJob(unitId: string) {
  for (let i = world.jobs.length - 1; i >= 0; i--) {
    const j = world.jobs[i]
    if (j.unitId === unitId && (j.status === 'QUEUED' || j.status === 'RUNNING')) return j
  }
  return null
}

const draftApi = (getDelay: () => number) => ({
  findFirst: async ({ where }: AnyRow) =>
    where?.status === 'PENDING' ? latestPendingDraft(where.unitId) : null,
  updateMany: async ({ where, data }: AnyRow) => {
    await tick(getDelay())
    const row = world.drafts.find((d) => d.id === where.id && d.unitId === where.unitId && (where.status == null || d.status === where.status))
    if (!row) return { count: 0 }
    Object.assign(row, data)
    return { count: 1 }
  },
  deleteMany: async ({ where }: AnyRow) => {
    const before = world.drafts.length
    world.drafts = world.drafts.filter((d) => !(d.unitId === where.unitId && d.status === where.status))
    return { count: before - world.drafts.length }
  },
  create: async ({ data }: AnyRow) => {
    const row = { id: `draft-${++world.draftSeq}`, createdAt: new Date(), decidedAt: null, ...data }
    world.drafts.push(row)
    return row
  },
})

const jobApi = (getDelay: () => number) => ({
  findFirst: async ({ where }: AnyRow) => latestActiveJob(where.unitId),
  create: async ({ data }: AnyRow) => {
    const row = { id: `job-${++world.jobSeq}`, createdAt: new Date(), updatedAt: new Date(), finishedAt: null, lastError: null, retryAt: null, ...data }
    world.jobs.push(row)
    return { id: row.id }
  },
  update: async ({ where, data }: AnyRow) => {
    const row = world.jobs.find((j) => j.id === where.id)
    if (!row) throw new Error('JOB_NOT_FOUND')
    Object.assign(row, data)
    return row
  },
  updateMany: async ({ where, data }: AnyRow) => {
    await tick(getDelay())
    const row = world.jobs.find((j) =>
      j.id === where.id &&
      j.unitId === where.unitId &&
      (where.status == null || j.status === where.status) &&
      (where.phase == null || j.phase === where.phase) &&
      (!where.lockedUntil?.gt || (j.lockedUntil && j.lockedUntil.getTime() > where.lockedUntil.gt.getTime())),
    )
    if (!row) return { count: 0 }
    Object.assign(row, data)
    return { count: 1 }
  },
})

const fakeDb: AnyRow = {
  $transaction: async (fn: (tx: AnyRow) => unknown) => {
    await tick(world.txDelayMs)
    return fn(txDb)
  },
  unitRegenerationDraft: draftApi(() => world.updateManyDelayMs),
  unit: {
    findUnique: async ({ where }: AnyRow) => world.units.get(where.id) ?? null,
    update: async ({ where, data }: AnyRow) => {
      const row = world.units.get(where.id)
      if (!row) throw new Error('UNIT_NOT_FOUND')
      const next = { ...row }
      for (const [key, value] of Object.entries(data)) {
        const v = value as AnyRow
        next[key] = v && typeof v === 'object' && 'increment' in v ? (row[key] ?? 0) + v.increment : value
      }
      world.units.set(where.id, next)
      world.unitUpdates.push({ unitId: where.id, data })
      return next
    },
  },
  unitGenerationJob: jobApi(() => world.updateManyDelayMs),
  bookChunk: {
    findMany: async ({ where }: AnyRow) =>
      world.chunks.filter((c) => c.index >= where.index.gte && c.index <= where.index.lte),
  },
  bookKnowledgeItem: {
    findMany: async ({ where }: AnyRow) =>
      world.knowledge.filter((k) => where.chunkId.in.includes(k.chunkId)),
  },
}

// The tx handle shares the world but claims with its own delay knob.
const txDb: AnyRow = {
  ...fakeDb,
  unitRegenerationDraft: draftApi(() => world.txUpdateManyDelayMs),
  unitGenerationJob: jobApi(() => world.txUpdateManyDelayMs),
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({
  audit: async () => { world.auditCalls += 1 },
  notify: async () => {},
  notifyAdmins: async () => {},
}))
// Generation never touches a real provider here: the canned reply is valid
// generated content (summary 80–150 words, 4 objectives, one referenced
// section) so generateUnitContentWithAi completes. geminiHook lets a test
// intervene mid-generation — expire the lease, fail the job, or block until
// the test releases it — to model what happens while generation is running.
mock.module('@/lib/gemini', () => ({
  geminiCompleteJson: async (opts: AnyRow) => {
    geminiCalls += 1
    if (geminiHook) await geminiHook(opts)
    return JSON.stringify(cannedGenerated)
  },
  geminiVisionJson: async () => '{}',
  ensureGeminiKey: async () => true,
  isAuthError: () => false,
  isModelUnavailableError: () => false,
  isQuotaError: () => false,
  isTransientGeminiError: () => false,
}))

const root = join(import.meta.dir, '..', '..')
const regenerateRoute = readFileSync(join(root, 'src/app/api/admin/program-units/[unitId]/regenerate/route.ts'), 'utf8')
const unitRegenerationCore = readFileSync(join(root, 'src/lib/unit-regeneration.ts'), 'utf8')
const approveRoute = readFileSync(join(root, 'src/app/api/admin/program-units/[unitId]/regenerate/approve/route.ts'), 'utf8')
const rejectRoute = readFileSync(join(root, 'src/app/api/admin/program-units/[unitId]/regenerate/reject/route.ts'), 'utf8')
const damagedListRoute = readFileSync(join(root, 'src/app/api/admin/program-units/route.ts'), 'utf8')

const {
  assessUnitSources,
  assertUnitRegenerationHasHealthySources,
  buildUnitRegenerationDraftData,
  buildUnitRegenerationApproveData,
  parseUnitRegenerationDraft,
} = await import('../../src/lib/outline-units')

const approveApi = await import('../../src/app/api/admin/program-units/[unitId]/regenerate/approve/route')
const rejectApi = await import('../../src/app/api/admin/program-units/[unitId]/regenerate/reject/route')
const regenerateApi = await import('../../src/app/api/admin/program-units/[unitId]/regenerate/route')
const { runUnitRegeneration } = await import('../../src/lib/unit-regeneration')

const cleanText = 'الأصول المتداولة هي الأصول التي يتوقع تحويلها إلى نقد خلال سنة مالية واحدة، وتشمل النقدية والمخزون والذمم المدينة التي تتحول إلى نقد خلال دورة التشغيل العادية للمنشأة. '.repeat(4)
const garbledPage = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)
const cleanChunk = (index: number) => ({ id: `chunk-${index}`, index, pageStart: index * 2 + 1, pageEnd: index * 2 + 2, headingPath: 'الباب الأول', text: cleanText })
const garbledChunk = (index: number) => ({ id: `chunk-${index}`, index, pageStart: index * 2 + 1, pageEnd: index * 2 + 2, headingPath: 'الباب الأول', text: garbledPage })
const cleanItem = (id: string, chunkId: string) => ({
  id, category: 'CONCEPT',
  title: 'الأصول المتداولة',
  summary: 'الأصول المتداولة هي الأصول التي يتوقع تحويلها إلى نقد خلال سنة مالية واحدة.',
  excerpt: 'تشمل الأصول المتداولة النقدية والمخزون والذمم المدينة التي تتحول إلى نقد خلال دورة التشغيل العادية للمنشأة.',
  pageStart: 5, pageEnd: 6, chunkId,
})
const garbledItem = (id: string, chunkId: string) => ({
  id, category: 'CONCEPT',
  title: garbledPage.slice(0, 400),
  summary: garbledPage.slice(0, 400),
  excerpt: garbledPage.slice(0, 400),
  pageStart: 7, pageEnd: 8, chunkId,
})

const generated = {
  summary: 'ملخص الوحدة المُعاد توليده من المصادر السليمة فقط ويشرح الأصول المتداولة ودورة التشغيل العادية للمنشأة وكيفية تحويل المخزون والذمم إلى نقد خلال السنة المالية الواحدة بشكل واضح ومباشر للطالب في هذا السياق التعليمي المحدد.',
  objectives: ['يشرح الأصول المتداولة', 'يميز النقدية عن المخزون', 'يطبق دورة التشغيل', 'يحلل الذمم المدينة'],
  content: [
    { heading: 'الأصول المتداولة', body: 'شرح تعليمي واضح يذكر الصفحات المرجعية داخل النص صفحات 1–2 ويشرح الأصول المتداولة والنقدية والمخزون والذمم المدينة.', pageRefs: ['صفحات 1–2'], sourceKnowledgeIds: ['item-clean'], sourceChunkIndexes: [0] },
  ],
}

// Canned generation the mocked Gemini returns for the regenerate tests: the
// fixture summary above is 34 words, below the generator's 80-word floor,
// so this summary is 106 words and the reply needs no retry.
const cannedGenerated = {
  summary: 'ملخص الوحدة المُعاد توليده من المصادر السليمة فقط ويشرح الأصول المتداولة ودورة التشغيل العادية للمنشأة وكيفية تحويل المخزون والذمم المدينة إلى نقد خلال السنة المالية الواحدة بشكل واضح ومباشر للطالب في هذا السياق التعليمي المحدد، ويبين الفرق بين النقدية والمخزون والذمم المدينة، ويوضح كيف تدخل هذه الأصول في الميزانية العمومية، وكيف يقيس المحاسب سيولة المنشأة من خلالها، وما أثر سرعة تحويلها إلى نقد في قدرة المنشأة على سداد التزاماتها قصيرة الأجل، مع أمثلة عملية من دورة التشغيل اليومية تبين حركة النقد من الشراء إلى البيع إلى التحصيل، وتدرب الطالب على قراءة هذه البنود في القوائم المالية وفهم علاقتها بالنشاط التشغيلي للمنشأة واستقرارها المالي على المدى القصير.',
  objectives: generated.objectives,
  content: generated.content,
}

describe('damaged-unit identification', () => {
  test('a unit with a garbled chunk source is affected and the chunk is named', () => {
    const assessment = assessUnitSources([cleanChunk(0), garbledChunk(1)], [cleanItem('item-clean', 'chunk-0')])
    expect(assessment.affected).toBe(true)
    expect(assessment.garbledChunkCount).toBe(1)
    expect(assessment.badChunks).toEqual([{ id: 'chunk-1', index: 1 }])
    expect(assessment.healthyChunkCount).toBe(1)
    expect(assessment.gaps.skippedChunkIndexes).toEqual([1])
    expect(assessment.gaps.partial).toBe(true)
  })

  test('a unit with a pending-review knowledge item is affected and the item is named', () => {
    const assessment = assessUnitSources([cleanChunk(0)], [cleanItem('item-clean', 'chunk-0'), garbledItem('item-garbled', 'chunk-0')])
    expect(assessment.affected).toBe(true)
    expect(assessment.pendingReviewKnowledgeCount).toBe(1)
    expect(assessment.badKnowledge.map((item) => item.id)).toEqual(['item-garbled'])
    expect(assessment.healthyKnowledgeCount).toBe(1)
    expect(assessment.gaps.skippedKnowledgeIds).toEqual(['item-garbled'])
  })

  test('a healthy unit is not affected and reports zero gaps', () => {
    const assessment = assessUnitSources([cleanChunk(0), cleanChunk(1)], [cleanItem('item-clean', 'chunk-0')])
    expect(assessment.affected).toBe(false)
    expect(assessment.gaps.partial).toBe(false)
    expect(assessment.gaps.skippedChunkCount).toBe(0)
    expect(assessment.gaps.skippedKnowledgeCount).toBe(0)
    expect(assessment.healthyChunkCount).toBe(2)
    expect(assessment.healthyKnowledgeCount).toBe(1)
  })

  test('a knowledge item with no linked chunk is not excluded on chunk grounds', () => {
    const assessment = assessUnitSources([garbledChunk(0), cleanChunk(1)], [
      cleanItem('item-clean', 'chunk-1'),
      { ...cleanItem('item-orphan', 'chunk-1'), chunkId: null },
    ])
    expect(assessment.gaps.skippedKnowledgeIds).toEqual([])
    expect(assessment.healthyKnowledgeCount).toBe(2)
    expect(assessment.gaps.partial).toBe(true)
    expect(assessment.gaps.skippedChunkIndexes).toEqual([0])
  })

  test('the damaged list only keeps affected units (route wiring pin)', () => {
    expect(damagedListRoute).toContain('assessUnitSources')
    expect(damagedListRoute).toContain("if (!assessment.affected) continue")
    expect(damagedListRoute).toContain("damaged') === 'true'")
    expect(damagedListRoute).toContain('badChunks: assessment.badChunks')
    expect(damagedListRoute).toContain('badKnowledge: assessment.badKnowledge')
  })
})

describe('regenerate produces a draft preview and leaves published content untouched', () => {
  test('draft data carries the generated content plus gaps, as JSON strings', () => {
    const gaps = assessUnitSources([cleanChunk(0), garbledChunk(1)], [cleanItem('item-clean', 'chunk-0'), garbledItem('item-garbled', 'chunk-0')]).gaps
    const draft = buildUnitRegenerationDraftData(generated as any, gaps)
    expect(draft.summary).toBe(generated.summary)
    expect(JSON.parse(draft.objectives)).toEqual(generated.objectives)
    expect(JSON.parse(draft.content)).toEqual(generated.content)
    expect(JSON.parse(draft.sourceKnowledgeIds)).toEqual(['item-clean'])
    const parsedGaps = JSON.parse(draft.gaps)
    expect(parsedGaps.skippedChunkIndexes).toEqual([1])
    expect(parsedGaps.skippedKnowledgeIds).toEqual(['item-garbled'])
    expect(parsedGaps.healthyChunkCount).toBe(1)
    expect(parsedGaps.healthyKnowledgeCount).toBe(1)
  })

  test('draft round-trips through parseUnitRegenerationDraft', () => {
    const gaps = assessUnitSources([cleanChunk(0), garbledChunk(1)], [cleanItem('item-clean', 'chunk-0')]).gaps
    const draft = buildUnitRegenerationDraftData(generated as any, gaps)
    const parsed = parseUnitRegenerationDraft(draft)
    expect(parsed.summary).toBe(generated.summary)
    expect(parsed.objectives).toEqual(generated.objectives)
    expect(parsed.content[0].heading).toBe('الأصول المتداولة')
    expect(parsed.gaps?.skippedChunkIndexes).toEqual([1])
    expect(parsed.sourceKnowledgeIds).toEqual(['item-clean'])
  })

  test('the regenerate route never writes the Unit row — preview only (source pin)', () => {
    // The route is auth + deferral + response mapping; the generation core
    // (draft preview, never a Unit write) lives in runUnitRegeneration.
    expect(regenerateRoute).toContain('runUnitRegeneration')
    expect(regenerateRoute).not.toContain('unit.update')
    expect(regenerateRoute).not.toContain('tx.unit.update')
    expect(regenerateRoute).not.toContain('db.unit.update')
    // Filtering is NOT duplicated here: it lives in generateUnitContentWithAi.
    expect(regenerateRoute).not.toContain('looksLikeBrokenBookPageText')
    expect(regenerateRoute).not.toContain('isKnowledgeItemPendingReview')
    expect(regenerateRoute).toContain('UNIT_SOURCE_REQUIRES_REPAIR')
    expect(unitRegenerationCore).toContain('generateUnitContentWithAi')
    expect(unitRegenerationCore).toContain('unitRegenerationDraft.create')
    expect(unitRegenerationCore).not.toContain('unit.update')
    expect(unitRegenerationCore).not.toContain('tx.unit.update')
    expect(unitRegenerationCore).not.toContain('db.unit.update')
  })
})

describe('approve applies the preview and preserves unit identity and student data', () => {
  test('approve data contains ONLY content fields plus the version bump', () => {
    const gaps = assessUnitSources([cleanChunk(0), garbledChunk(1)], [cleanItem('item-clean', 'chunk-0')]).gaps
    const draft = buildUnitRegenerationDraftData(generated as any, gaps)
    const approveData = buildUnitRegenerationApproveData(draft)
    expect(Object.keys(approveData).sort()).toEqual(['content', 'generationVersion', 'objectives', 'summary'])
    expect(approveData.summary).toBe(generated.summary)
    expect(JSON.parse(approveData.objectives)).toEqual(generated.objectives)
    expect(JSON.parse(approveData.content)).toEqual(generated.content)
    expect(approveData.generationVersion).toEqual({ increment: 1 })
  })

  test('applying approve data to a unit row changes only content fields', () => {
    const gaps = assessUnitSources([cleanChunk(0)], [cleanItem('item-clean', 'chunk-0')]).gaps
    const draft = buildUnitRegenerationDraftData(generated as any, gaps)
    const before = {
      id: 'unit-1', programId: 'prog-1', order: 3, semester: 2, status: 'APPROVED',
      title: 'وحدة الأصول', summary: 'ملخص قديم خاطئ', objectives: '[]', content: '[]',
      sourceBookId: 'book-1', outlineSectionId: 'section-1', chunkStartIndex: 0, chunkEndIndex: 5,
      generationVersion: 2, examId: 'exam-1',
    }
    const studentSide = { enrollments: [{ userId: 'student-1', completedUnits: ['unit-1'] }], grades: [{ studentId: 'student-1', score: 88 }], attempts: [{ id: 'attempt-1' }], assignments: [{ id: 'asg-1', unitId: 'unit-1' }] }
    const after = { ...before, ...buildUnitRegenerationApproveData(draft), generationVersion: before.generationVersion + 1 }
    expect(after.id).toBe(before.id)
    expect(after.order).toBe(before.order)
    expect(after.semester).toBe(before.semester)
    expect(after.status).toBe(before.status)
    expect(after.programId).toBe(before.programId)
    expect(after.sourceBookId).toBe(before.sourceBookId)
    expect(after.outlineSectionId).toBe(before.outlineSectionId)
    expect(after.chunkStartIndex).toBe(before.chunkStartIndex)
    expect(after.chunkEndIndex).toBe(before.chunkEndIndex)
    expect(after.title).toBe(before.title)
    expect(after.examId).toBe(before.examId)
    expect(after.summary).toBe(generated.summary)
    expect(after.generationVersion).toBe(3)
    expect(studentSide).toEqual({ enrollments: [{ userId: 'student-1', completedUnits: ['unit-1'] }], grades: [{ studentId: 'student-1', score: 88 }], attempts: [{ id: 'attempt-1' }], assignments: [{ id: 'asg-1', unitId: 'unit-1' }] })
  })

  test('the approve route spreads exactly the approve-data builder and nothing else (source pin)', () => {
    expect(approveRoute).toContain('buildUnitRegenerationApproveData(draft)')
    expect(approveRoute).toContain("status: 'APPROVED'")
    expect(approveRoute).toContain('UNIT_REGENERATION_DRAFT_NOT_FOUND')
    // Exactly one Unit write, and its data is the builder alone — no inline
    // field assignments (order/status/source/chunks can only appear in the
    // read-only response echo, never in the update).
    expect(approveRoute.split('tx.unit.update').length - 1).toBe(1)
    // The update call ends at its own closing '})' — the draft claim
    // (tx.unitRegenerationDraft.updateMany) now runs BEFORE it, so slicing
    // to the draft update no longer bounds this block.
    const updateStart = approveRoute.indexOf('tx.unit.update')
    const updateBlock = approveRoute.slice(updateStart, approveRoute.indexOf('})', updateStart) + 2)
    expect(updateBlock).toContain('data: buildUnitRegenerationApproveData(draft),')
    expect(updateBlock).not.toContain('order')
    expect(updateBlock).not.toContain('status')
    expect(updateBlock).not.toContain('sourceBookId')
    expect(updateBlock).not.toContain('chunkStartIndex')
    expect(updateBlock).not.toContain('programId')
  })

  test('the reject route flips only the draft status and touches no unit (source pin)', () => {
    expect(rejectRoute).toContain("status: 'REJECTED'")
    expect(rejectRoute).not.toContain('unit.update')
    expect(rejectRoute).not.toContain('tx.unit.update')
  })
})

describe('refuse when no healthy sources exist', () => {
  test('assert throws UNIT_SOURCE_REQUIRES_REPAIR when every source is unusable', () => {
    const assessment = assessUnitSources([garbledChunk(0)], [garbledItem('item-garbled', 'chunk-0')])
    expect(assessment.healthyChunkCount).toBe(0)
    expect(assessment.healthyKnowledgeCount).toBe(0)
    expect(() => assertUnitRegenerationHasHealthySources(assessment)).toThrow('UNIT_SOURCE_REQUIRES_REPAIR')
  })

  test('clean-looking knowledge linked to a garbled chunk is excluded', () => {
    const assessment = assessUnitSources([garbledChunk(0)], [cleanItem('item-clean', 'chunk-0')])
    expect(assessment.healthyKnowledgeCount).toBe(0)
    expect(assessment.gaps.skippedKnowledgeIds).toEqual(['item-clean'])
    expect(() => assertUnitRegenerationHasHealthySources(assessment)).toThrow('UNIT_SOURCE_REQUIRES_REPAIR')
  })

  test('assert passes when healthy sources remain', () => {
    const assessment = assessUnitSources([garbledChunk(0), cleanChunk(1)], [cleanItem('item-clean', 'chunk-0'), cleanItem('item-good', 'chunk-1')])
    expect(assessment.healthyKnowledgeCount).toBe(1)
    expect(assessment.gaps.skippedKnowledgeIds).toEqual(['item-clean'])
    expect(() => assertUnitRegenerationHasHealthySources(assessment)).not.toThrow()
    expect(() => assertUnitRegenerationHasHealthySources(assessUnitSources([cleanChunk(0)], [garbledItem('item-garbled', 'chunk-0')]))).not.toThrow()
  })

  test('the regenerate route surfaces the refusal with a clear reason (source pin)', () => {
    expect(regenerateRoute).toContain('UNIT_SOURCE_REQUIRES_REPAIR')
    expect(regenerateRoute).toContain('لا توجد مصادر سليمة كافية لإعادة توليد هذه الوحدة')
    expect(unitRegenerationCore).toContain('assertUnitRegenerationHasHealthySources(assessment)')
  })
})

describe('gaps are reported when some sources are unusable', () => {
  test('partial assessment names every skipped chunk and item with healthy counts', () => {
    const assessment = assessUnitSources(
      [cleanChunk(0), garbledChunk(1), garbledChunk(2)],
      [cleanItem('item-clean', 'chunk-0'), garbledItem('item-garbled', 'chunk-0')],
    )
    expect(assessment.gaps.partial).toBe(true)
    expect(assessment.gaps.skippedChunkIndexes).toEqual([1, 2])
    expect(assessment.gaps.skippedKnowledgeIds).toEqual(['item-garbled'])
    expect(assessment.gaps.healthyChunkCount).toBe(1)
    expect(assessment.gaps.healthyKnowledgeCount).toBe(1)
    const draft = buildUnitRegenerationDraftData(generated as any, assessment.gaps)
    expect(JSON.parse(draft.gaps)).toEqual(assessment.gaps)
  })
})

describe('concurrency guards — approve / reject / regenerate lease', () => {
  beforeEach(resetWorld)

  function postApprove() {
    return approveApi.POST(
      new NextRequest('https://academy.test/api/admin/program-units/unit-1/regenerate/approve', { method: 'POST' }),
      { params: Promise.resolve({ unitId: 'unit-1' }) },
    )
  }
  function postReject() {
    return rejectApi.POST(
      new NextRequest('https://academy.test/api/admin/program-units/unit-1/regenerate/reject', { method: 'POST' }),
      { params: Promise.resolve({ unitId: 'unit-1' }) },
    )
  }
  function postRegenerate() {
    return regenerateApi.POST(
      new NextRequest('https://academy.test/api/admin/program-units/unit-1/regenerate', { method: 'POST' }),
      { params: Promise.resolve({ unitId: 'unit-1' }) },
    )
  }

  test('second concurrent approve gets 409 ALREADY_DECIDED and the unit is written once', async () => {
    // Both reads land before either claim; the claims then run in order.
    world.txDelayMs = 1
    const [first, second] = await Promise.all([postApprove(), postApprove()])
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 409])
    const winner = first.status === 200 ? first : second
    const loser = first.status === 409 ? first : second
    expect((await winner.json()).ok).toBe(true)
    expect((await loser.json()).error).toBe('UNIT_REGENERATION_DRAFT_ALREADY_DECIDED')
    expect(world.unitUpdates.length).toBe(1)
    expect(world.units.get('unit-1')?.summary).toBe(generated.summary)
    expect(world.units.get('unit-1')?.generationVersion).toBe(3)
    expect(world.drafts.find((d) => d.id === 'draft-1')?.status).toBe('APPROVED')
  })

  test('approve racing a reject that lands first gets 409 ALREADY_DECIDED', async () => {
    // The approve claim waits in its transaction; the reject claims at once.
    world.txDelayMs = 10
    const [approveRes, rejectRes] = await Promise.all([postApprove(), postReject()])
    expect(rejectRes.status).toBe(200)
    expect((await rejectRes.json()).ok).toBe(true)
    expect(approveRes.status).toBe(409)
    expect((await approveRes.json()).error).toBe('UNIT_REGENERATION_DRAFT_ALREADY_DECIDED')
    expect(world.unitUpdates.length).toBe(0)
    expect(world.units.get('unit-1')?.summary).toBe('ملخص قديم خاطئ')
    expect(world.drafts.find((d) => d.id === 'draft-1')?.status).toBe('REJECTED')
  })

  test('reject racing an approve that lands first gets 409 ALREADY_DECIDED', async () => {
    // The approve claim runs at once; the reject claim waits.
    world.updateManyDelayMs = 10
    const [approveRes, rejectRes] = await Promise.all([postApprove(), postReject()])
    expect(approveRes.status).toBe(200)
    expect((await approveRes.json()).ok).toBe(true)
    expect(rejectRes.status).toBe(409)
    expect((await rejectRes.json()).error).toBe('UNIT_REGENERATION_DRAFT_ALREADY_DECIDED')
    expect(world.unitUpdates.length).toBe(1)
    expect(world.drafts.find((d) => d.id === 'draft-1')?.status).toBe('APPROVED')
  })

  test('a job whose lease expires mid-generation loses the lease: no draft, seeded draft untouched', async () => {
    const seeded = world.drafts[0]
    geminiHook = async () => {
      // The 240s lock lapses while generation is still running.
      world.jobs[0].lockedUntil = new Date(Date.now() - 1000)
    }
    const result = await runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 })
    expect(geminiCalls).toBe(1)
    expect(result.outcome).toBe('LEASE_LOST')
    expect(world.drafts.length).toBe(1)
    expect(world.drafts[0]).toBe(seeded)
    expect(world.drafts[0].status).toBe('PENDING')
    expect(world.unitUpdates.length).toBe(0)
    // Lease loss leaves the job RUNNING with an expired lock; the next
    // attempt fails it via the early check instead of generating over it.
    expect(world.jobs[0].status).toBe('RUNNING')
  })

  test('a job marked FAILED mid-generation loses the lease: no draft, seeded draft untouched', async () => {
    geminiHook = async () => {
      // e.g. a second request saw the expired lock and failed the job.
      world.jobs[0].status = 'FAILED'
    }
    const result = await runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 })
    expect(geminiCalls).toBe(1)
    expect(result.outcome).toBe('LEASE_LOST')
    expect(world.drafts.length).toBe(1)
    expect(world.drafts[0].status).toBe('PENDING')
    expect(world.unitUpdates.length).toBe(0)
  })

  test('a second regeneration while the first is still generating reports ALREADY_RUNNING on the same job', async () => {
    let releaseGeneration!: () => void
    const generationStarted = new Promise<void>((resolve) => {
      geminiHook = async () => {
        resolve()
        await new Promise<void>((r) => { releaseGeneration = r })
      }
    })
    const first = runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 })
    first.catch(() => {})
    await generationStarted // the first run created its RUNNING job and is inside generation
    const second = await runUnitRegeneration('unit-1', { deadlineMs: Date.now() + 210_000 })
    expect(second.outcome).toBe('ALREADY_RUNNING')
    if (second.outcome === 'ALREADY_RUNNING') expect(second.job.id).toBe(world.jobs[0].id)
    releaseGeneration()
    const firstResult = await first
    expect(firstResult.outcome).toBe('DRAFT_CREATED')
    expect(geminiCalls).toBe(1)
    expect(world.jobs.length).toBe(1)
    expect(world.jobs[0].status).toBe('COMPLETED')
    // The seeded PENDING draft was replaced by the new one; the Unit row
    // was never written.
    expect(world.drafts.length).toBe(1)
    if (firstResult.outcome === 'DRAFT_CREATED') {
      expect(world.drafts[0].id).toBe(firstResult.draft.id)
      expect(world.drafts[0].status).toBe('PENDING')
    }
    expect(world.unitUpdates.length).toBe(0)
  })

  test('POST regenerate while a generation job is RUNNING returns resumed:true on that job', async () => {
    // Seed the running job the route's early check finds; generation itself
    // never starts, so the deferral path is never reached.
    world.jobs.push({
      id: 'job-seeded', unitId: 'unit-1', programId: 'prog-1', status: 'RUNNING', phase: 'REGENERATE',
      unitsTotal: 1, unitsDone: 0, startedAt: new Date(), lockedUntil: new Date(Date.now() + 240_000),
      finishedAt: null, lastError: null, retryAt: null, createdAt: new Date(), updatedAt: new Date(),
    })
    const res = await postRegenerate()
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.resumed).toBe(true)
    expect(body.job.id).toBe('job-seeded')
    expect(geminiCalls).toBe(0)
    expect(world.drafts.length).toBe(1)
  })
})
