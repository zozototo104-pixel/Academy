import assert from 'node:assert/strict'
import { assertQuestionBatchAcceptable, validateQuestionAgainstKnowledge, validateQuestionBatchAgainstKnowledge } from '../src/lib/question-bank-evidence'

const first = 'الإدارة الفعالة تعتمد على التخطيط والتنظيم والمتابعة المستمرة لتحقيق الأهداف المؤسسية بكفاءة عالية ومستدامة.'
const second = 'التسويق الاستراتيجي يبدأ بتحليل السوق والعملاء والمنافسين ثم اختيار القيمة المناسبة وبناء خطة قابلة للقياس والمتابعة.'
const knowledge = [{ text: first }, { text: second }]

function question(sourceIndex: number | string, sourceEvidence: string) {
  return { sourceIndex, sourceEvidence }
}

function main() {
  console.log('▶ question bank evidence: sourceIndex must match the quoted knowledge item')
  assert.deepEqual(validateQuestionAgainstKnowledge(question(1, second), knowledge), { ok: false, reason: 'NOT_FOUND' })
  assert.deepEqual(validateQuestionAgainstKnowledge(question(0, first), knowledge), { ok: false, reason: 'BAD_INDEX' })
  assert.deepEqual(validateQuestionAgainstKnowledge(question(3, first), knowledge), { ok: false, reason: 'BAD_INDEX' })

  console.log('▶ question bank evidence: more than half rejected triggers router validation rejection')
  const mostlyRejected = validateQuestionBatchAgainstKnowledge([
    question(1, first),
    question(1, second),
    question(0, first),
    question(2, 'دليل قصير'),
  ], knowledge, { provider: 'MOCK', model: 'mock-free' })
  assert.equal(mostlyRejected.accepted.length, 1)
  assert.equal(mostlyRejected.rejected.length, 3)
  assert.throws(() => assertQuestionBatchAcceptable(4, 3), (error: any) => error?.code === 'VALIDATION_REJECTED')
  assert.equal(mostlyRejected.rejected[0]?.model, 'mock-free')

  console.log('▶ question bank evidence: one rejected question does not reject the batch')
  const mostlyAccepted = validateQuestionBatchAgainstKnowledge([
    question(1, first),
    question(2, second),
    question('1', first),
    question(1, second),
  ], knowledge, { provider: 'MOCK', model: 'mock-free' })
  assert.equal(mostlyAccepted.accepted.length, 3)
  assert.equal(mostlyAccepted.rejected.length, 1)
  assert.doesNotThrow(() => assertQuestionBatchAcceptable(4, 1))
  assert.equal(mostlyAccepted.rejected[0]?.reason, 'NOT_FOUND')

  console.log('▶ question bank evidence: accepted questions carry no SOURCE_GROUNDED state')
  assert.equal('qualityFlags' in mostlyAccepted.accepted[0], false)

  console.log('question bank evidence guardrails: ok')
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
