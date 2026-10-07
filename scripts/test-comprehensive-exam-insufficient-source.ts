import assert from 'node:assert/strict'
import { buildExamSourceChunks, selectExamSourceChunks } from '../src/lib/exam-source-chunks'
import {
  assertComprehensiveExamSourceSufficient,
  formatComprehensiveExamInsufficientSourceMessage,
  minimumSourceChunksForComprehensiveExam,
  type ComprehensiveExamInsufficientSourceError,
} from '../src/lib/comprehensive-exam-evidence'

const sourceText = 'هذا مقطع أصلي طويل بما يكفي من كتاب مرفوع عن إدارة المخاطر، يشرح أن القرار المهني الجيد يعتمد على الدليل والسياق المؤسسي والتحقق قبل التنفيذ، وأن تجاهل المصدر يؤدي إلى نتائج ضعيفة في التقييم الأكاديمي والمهني.'

function selectedChunks(count: number) {
  return selectExamSourceChunks(buildExamSourceChunks(Array.from({ length: count }, (_, index) => ({
    bookId: `book-${index + 1}`,
    bookTitle: `كتاب ${index + 1}`,
    text: `${sourceText} رقم المقطع الأصلي ${index + 1} يضيف زاوية مستقلة حتى يبقى المصدر قابلاً للتمييز في الاختبار.`,
    contentQuality: 'UPLOADED_FILE',
  }))))
}

function main() {
  console.log('▶ comprehensive exam insufficient source: one chunk cannot generate ten grounded questions')

  assert.equal(minimumSourceChunksForComprehensiveExam(10), 4)

  const fourSelected = selectedChunks(4)
  assert.equal(fourSelected.length, 4)
  assert.doesNotThrow(() => assertComprehensiveExamSourceSufficient({
    availableChunks: fourSelected.length,
    requestedQuestions: 10,
    acceptedQuestions: 10,
  }), 'four source chunks may support ten grounded questions when each chunk is used at most three times')

  const selected = selectedChunks(1)
  assert.equal(selected.length, 1)

  let generatedQuestions: unknown[] | null = null
  let thrown: ComprehensiveExamInsufficientSourceError | null = null
  try {
    assertComprehensiveExamSourceSufficient({
      availableChunks: selected.length,
      requestedQuestions: 10,
      acceptedQuestions: 0,
    })
    generatedQuestions = []
  } catch (error) {
    thrown = error as ComprehensiveExamInsufficientSourceError
  }

  assert.ok(thrown)
  assert.equal(thrown.code, 'INSUFFICIENT_SOURCE')
  assert.equal(thrown.availableChunks, 1)
  assert.equal(thrown.requestedQuestions, 10)
  assert.equal(thrown.acceptedQuestions, 0)
  assert.equal(thrown.message, formatComprehensiveExamInsufficientSourceMessage({
    availableChunks: 1,
    requestedQuestions: 10,
    acceptedQuestions: 0,
  }))
  assert.equal(generatedQuestions, null, 'insufficient source must stop before producing fallback questions')

  console.log('comprehensive exam insufficient source: ok')
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
