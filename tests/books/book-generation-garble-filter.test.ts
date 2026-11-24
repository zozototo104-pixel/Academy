import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Criterion 3: garbled items awaiting review must NOT enter unit-guide
// generation or question generation. The filter is the shared predicate
// isKnowledgeItemPendingReview (the same definition as the manual review
// queue) applied at generation time: buildUnitStudyGuideDraft (both guide
// paths) and generateBatch (both question jobs). The question-job wiring is
// a one-line filter over the same predicate; its end-to-end run needs a live
// AI call, so it is pinned by source below while the predicate and the guide
// draft are exercised for real.
mock.module('@/lib/db', () => ({ db: {} }))

const root = join(import.meta.dir, '..', '..')
const questionBankJob = readFileSync(join(root, 'src/lib/question-bank-job.ts'), 'utf8')

const { buildUnitStudyGuideDraft } = await import('../../src/lib/outline-units')
const { isKnowledgeItemPendingReview } = await import('../../src/lib/knowledge-bank')

const cleanItem = {
  id: 'item-clean', category: 'CONCEPT',
  title: 'الأصول المتداولة',
  summary: 'الأصول المتداولة هي الأصول التي يتوقع تحويلها إلى نقد خلال سنة مالية واحدة.',
  excerpt: 'تشمل الأصول المتداولة النقدية والمخزون والذمم المدينة التي تتحول إلى نقد خلال دورة التشغيل العادية للمنشأة.',
  pageStart: 5, pageEnd: 6, chunkId: 'chunk-1',
}
const garbledPage = ('□ '.repeat(300) + 'א ב ג K W J □ '.repeat(60)).repeat(2)
const garbledItem = {
  id: 'item-garbled', category: 'CONCEPT',
  title: garbledPage.slice(0, 400),
  summary: garbledPage.slice(0, 400),
  excerpt: garbledPage.slice(0, 400),
  pageStart: 7, pageEnd: 8, chunkId: 'chunk-2',
}

describe('generation-time garble filter (criterion 3)', () => {
  test('the predicate matches the review queue: garbled is pending, clean is not', () => {
    expect(isKnowledgeItemPendingReview(garbledItem)).toBe(true)
    expect(isKnowledgeItemPendingReview(cleanItem)).toBe(false)
    expect(isKnowledgeItemPendingReview({ title: '', summary: '', excerpt: '' })).toBe(true)
  })

  test('a guide draft skips the garbled item and keeps only the clean one', () => {
    const draft = buildUnitStudyGuideDraft({
      programTitle: 'برنامج الاختبار', unitTitle: 'وحدة الاختبار', semester: 1,
      knowledge: [cleanItem, garbledItem],
    })
    expect(draft.sourceKnowledgeIds).toEqual(['item-clean'])
    expect(draft.keyTerms).toHaveLength(1)
    expect(draft.keyTerms[0]).toContain('الأصول المتداولة')
    expect(draft.keyTerms.join('\n')).not.toContain('□')
    expect(draft.sections).toHaveLength(1)
    expect(draft.sections[0].sourceKnowledgeIds).toEqual(['item-clean'])
    expect(draft.sections[0].summary).not.toContain('□')
  })

  test('a rule-fixable item bakes its cleaned text, never the raw garble', () => {
    // A known OCR-word error the display cleaner repairs: the bank shows the
    // cleaned form, so the guide must bake the same cleaned form.
    const fixable = {
      ...cleanItem,
      id: 'item-fixable',
      title: 'الأصول المتداولة',
      summary: 'الأصول المتداولة هي الأصول التي يتوقع تحويلها إلى نقد خلال سنة مالية واحدة. المحاسبه المالية تشرح ذلك.',
    }
    const draft = buildUnitStudyGuideDraft({
      programTitle: 'برنامج الاختبار', unitTitle: 'وحدة الاختبار', semester: 1,
      knowledge: [fixable],
    })
    expect(draft.sourceKnowledgeIds).toEqual(['item-fixable'])
    expect(draft.keyTerms[0]).toContain('الأصول المتداولة')
  })

  test('when every source is garbled the draft fails honestly instead of baking an empty guide', () => {
    expect(() => buildUnitStudyGuideDraft({
      programTitle: 'برنامج الاختبار', unitTitle: 'وحدة الاختبار', semester: 1,
      knowledge: [garbledItem],
    })).toThrow('STUDY_GUIDE_REQUIRES_SOURCE_KNOWLEDGE_IDS')
  })

  test('question generation filters pending-review items at selection (source pin)', () => {
    expect(questionBankJob).toContain('.filter((item) => !isKnowledgeItemPendingReview(item))')
    expect(questionBankJob).toContain("import { isKnowledgeItemPendingReview } from '@/lib/knowledge-bank'")
  })
})
