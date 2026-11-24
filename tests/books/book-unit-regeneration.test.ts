import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Part 3 (PR #212): damaged-unit regeneration. Identification, draft preview,
// approve-only-content-fields, refuse-when-no-healthy-sources and gaps are
// pure functions in outline-units; the routes are thin wrappers, pinned by
// source below (regenerate never writes the Unit row; approve writes only
// the content fields via buildUnitRegenerationApproveData).
mock.module('@/lib/db', () => ({ db: {} }))

const root = join(import.meta.dir, '..', '..')
const regenerateRoute = readFileSync(join(root, 'src/app/api/admin/program-units/[unitId]/regenerate/route.ts'), 'utf8')
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
    expect(regenerateRoute).toContain('generateUnitContentWithAi')
    expect(regenerateRoute).toContain('unitRegenerationDraft.create')
    expect(regenerateRoute).not.toContain('unit.update')
    expect(regenerateRoute).not.toContain('tx.unit.update')
    expect(regenerateRoute).not.toContain('db.unit.update')
    // Filtering is NOT duplicated here: it lives in generateUnitContentWithAi.
    expect(regenerateRoute).not.toContain('looksLikeBrokenBookPageText')
    expect(regenerateRoute).not.toContain('isKnowledgeItemPendingReview')
    expect(regenerateRoute).toContain('UNIT_SOURCE_REQUIRES_REPAIR')
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
    const updateBlock = approveRoute.slice(approveRoute.indexOf('tx.unit.update'), approveRoute.indexOf('tx.unitRegenerationDraft.update'))
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
    expect(regenerateRoute).toContain('assertUnitRegenerationHasHealthySources(assessment)')
    expect(regenerateRoute).toContain('لا توجد مصادر سليمة كافية لإعادة توليد هذه الوحدة')
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
