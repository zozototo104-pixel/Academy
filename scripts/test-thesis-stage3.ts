import { readFileSync } from 'node:fs'
import { strict as assert } from 'node:assert'
import { thesisDigestSchema } from '../src/lib/thesis-digest'
import { scoreDefenseBreakdown } from '../src/lib/thesis-defense-score'

function src(path: string) {
  return readFileSync(path, 'utf8')
}

function testWeightedDefenseScoreRedistributesMissingCriterion() {
  const result = scoreDefenseBreakdown([
    { criterion: 'methodology', score0to10: 8 },
    { criterion: 'results', score0to10: 6 },
  ])
  assert.equal(result.score, 70)
}

function testNullSecondDefenseQuestionKeepsThirdAsContribution() {
  const result = scoreDefenseBreakdown([
    { criterion: 'methodology', score0to10: 8 },
    { criterion: 'results', score0to10: null },
    { criterion: 'contribution', score0to10: 6 },
  ])
  assert.deepEqual(result.breakdown.map((item) => item.criterion), ['methodology', 'contribution'])
  assert.equal(result.score, 71)
}

function testFakePdfDocxRejectedByMagicBytes() {
  const route = src('src/app/api/thesis/upload-chunk/route.ts')
  assert(route.includes("buffer.subarray(0, 4).toString() === '%PDF'"), 'PDF magic bytes must be checked')
  assert(route.includes("buffer.subarray(0, 2).toString() === 'PK'"), 'DOCX zip magic bytes must be checked')
  assert(route.includes('يسمح فقط بملفات PDF أو DOCX صحيحة'), 'fake PDF/DOCX must be rejected')
}

function testRelevantArabicChunksUsesArabicNormalization() {
  const helper = src('src/lib/thesis-context.ts')
  assert(helper.includes("replace(/[إأآ]/g, 'ا')"), 'Arabic alef variants must be normalized')
  assert(helper.includes("replace(/ة/g, 'ه')"), 'Arabic taa marbuta must be normalized')
  assert(helper.includes('findRelevantThesisChunks'), 'relevant thesis chunk helper must exist')
}

function testDigestZodSchema() {
  const parsed = thesisDigestSchema.parse({
    problem: 'مشكلة البحث',
    objectives: ['هدف'],
    methodology: 'وصفي',
    sample: 'عينة',
    tools: ['استبانة'],
    keyFindings: ['نتيجة'],
    contributions: ['إسهام'],
    literatureCoverage: 'جيد',
    referencesCount: 12,
    weaknesses: ['ضعف'],
    sectionMap: [{ title: 'الفصل الأول', chunkFrom: 0, chunkTo: 2 }],
  })
  assert.equal(parsed.referencesCount, 12)
  assert.throws(() => thesisDigestSchema.parse({ referencesCount: -1 }), /too_small|Too small/)
}

for (const fn of [testWeightedDefenseScoreRedistributesMissingCriterion, testNullSecondDefenseQuestionKeepsThirdAsContribution, testFakePdfDocxRejectedByMagicBytes, testRelevantArabicChunksUsesArabicNormalization, testDigestZodSchema]) {
  fn()
  console.log(`✓ ${fn.name}`)
}
