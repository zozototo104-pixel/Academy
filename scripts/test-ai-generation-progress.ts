import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { aiGenerationProgressKey, questionDuplicateKey, resolveGenerationJob, type AiGenerationProgress } from '../src/lib/ai-generation-progress'
import { runProgressiveGenerationBatches, type GeneratedQuestionCandidate } from '../src/lib/ai-generation-batches'
import { parseGeneratedQuestionCandidates, parseQuestionBatchEnvelope } from '../src/lib/question-bank-generation'
import { isDuplicateQuestionIdea, selectQuestionKnowledgeSources } from '../src/lib/question-bank-diversity'

function questionBankDiversityRegressions() {
  const sources = [{ id: 'used-twice' }, { id: 'unused' }, { id: 'used-once' }]
  const selected = selectQuestionKnowledgeSources(sources, new Map([['used-twice', 2], ['used-once', 1]]))
  assert.equal(selected.some((source) => source.id === 'used-twice'), false)
  assert.equal(selected[0]?.id, 'unused')
  const previous = [{ text: 'اشرح أهمية التخطيط والتنظيم في إدارة المؤسسات', knowledgeItemId: 'same-source' }]
  assert.equal(isDuplicateQuestionIdea('وضح أهمية التخطيط والتنظيم في إدارة المؤسسات', 'same-source', previous), true)
  assert.equal(isDuplicateQuestionIdea('وضح أهمية التخطيط والتنظيم في إدارة المؤسسات', 'different-source', previous), false)
  const progress: AiGenerationProgress = { jobId: 'resume-usage', status: 'PARTIAL', requested: 10, saved: 2, failedBatches: 0, lastError: null, updatedAt: '', usedSourceIndexes: [3], knowledgeItemIds: ['used-once'] }
  const resumed = resolveGenerationJob(progress, 10)
  assert.deepEqual(resumed.usedSourceIndexes, [3])
  assert.deepEqual(resumed.knowledgeItemIds, ['used-once'])
}

questionBankDiversityRegressions()

function jobLifecycleAndDedupe() {
  const completed: AiGenerationProgress = { jobId: 'old-job', status: 'COMPLETED', requested: 12, saved: 12, failedBatches: 0, lastError: null, updatedAt: '' }
  const fresh = resolveGenerationJob(completed, 10)
  assert.notEqual(fresh.jobId, completed.jobId)
  assert.equal(fresh.requested, 10)
  assert.equal(fresh.saved, 0)
  assert.equal(fresh.failedBatches, 0)
  const partial: AiGenerationProgress = { ...completed, jobId: 'partial-job', status: 'PARTIAL', saved: 4 }
  assert.equal(resolveGenerationJob(partial, 10).jobId, partial.jobId)
  assert.equal(resolveGenerationJob(partial, 10).saved, 4)
  assert.equal(resolveGenerationJob({ ...partial, status: 'RUNNING' }, 10, true).jobId, partial.jobId)
  assert.notEqual(resolveGenerationJob(partial, 10, false, true).jobId, partial.jobId)
  const existing = new Set([questionDuplicateKey('سؤال محفوظ مسبقاً', 'source-1')])
  assert.equal(existing.has(questionDuplicateKey('سؤال محفوظ مسبقاً', 'source-1')), true)
  assert.equal(existing.has(questionDuplicateKey('سؤال جديد', 'source-1')), false)
}

jobLifecycleAndDedupe()

function question(n: number, sourceRef = 'source-1'): GeneratedQuestionCandidate {
  return {
    type: 'MCQ',
    text: `ما السؤال السلوكي رقم ${n} حول الدليل؟`,
    options: ['الأول', 'الثاني', 'الثالث'],
    correctAnswer: '0',
    sourceRef,
  }
}

function generatedQuestion(n: number, overrides: Record<string, unknown> = {}) {
  return {
    type: 'MCQ',
    text: `ما السؤال الأكاديمي رقم ${n} حول الدليل والسياق المؤسسي؟`,
    options: ['الأول', 'الثاني', 'الثالث', 'الرابع'],
    correctAnswer: '0',
    sourceEvidence: 'هذا دليل حرفي طويل بما يكفي لاختبار شكل السؤال داخل بنك الأسئلة.',
    difficulty: 'MEDIUM',
    sourceIndex: 1,
    correctRationale: 'لأن الدليل يدعم الإجابة مباشرة.',
    ...overrides,
  }
}

function arrayEnvelopeIsAcceptedAndInvalidQuestionsAreDropped() {
  const raw = JSON.stringify([
    generatedQuestion(1),
    generatedQuestion(2, { correctAnswer: '' }),
    generatedQuestion(3),
  ])
  const envelope = parseQuestionBatchEnvelope(raw)
  assert.equal(envelope.questions.length, 3)
  const parsed = parseGeneratedQuestionCandidates(raw)
  assert.equal(parsed.accepted.length, 2)
  assert.equal(parsed.rejected, 1)
}

function generatedQuestionDifficultyAliasesAreNormalized() {
  const raw = JSON.stringify([
    generatedQuestion(1, { difficulty: 'متوسط' }),
    generatedQuestion(2, { difficulty: 'سهل' }),
    generatedQuestion(3, { difficulty: 'ADVANCED_LEVEL' }),
  ])
  const parsed = parseGeneratedQuestionCandidates(raw)
  assert.equal(parsed.accepted.length, 3)
  assert.equal(parsed.rejected, 0)
}

function questionBankPauseCleanupUsesDeleteMany() {
  const route = readFileSync('src/app/api/admin/question-bank/route.ts', 'utf8')
  assert.ok(route.includes('db.setting.deleteMany'), 'question bank route must use deleteMany when clearing pause keys')
  assert.ok(!route.includes('db.setting.delete({ where: { key: `AI_TASK_PAUSE:QUESTION_BANK'), 'question bank route must not use delete for optional pause keys')
}

async function partialFailureKeepsSavedBatches() {
  const saved: GeneratedQuestionCandidate[] = []
  let calls = 0
  const result = await runProgressiveGenerationBatches({
    requested: 10,
    generate: async (count) => {
      calls += 1
      assert.ok(count <= 4, 'generation calls must never request more than four questions')
      if (calls === 3) throw new Error('ALL_PROVIDERS_FAILED')
      return Array.from({ length: count }, (_, index) => question(saved.length + index + 1))
    },
    save: async (items) => {
      saved.push(...items)
      return items.length
    },
  })
  assert.equal(calls, 3)
  assert.equal(saved.length, 8)
  assert.equal(result.saved, 8)
  assert.equal(result.remaining, 2)
  assert.equal(result.message, 'تم حفظ 8 من 10. اضغط مرة أخرى لإكمال الباقي.')
  assert.deepEqual(result.batchSizes, [4, 4, 2])
  const progressStore = new Map<string, string>()
  progressStore.set(aiGenerationProgressKey('QUESTION_BANK', 'program-1', 'ALL'), JSON.stringify({ requested: result.requested, saved: result.saved, failedBatches: result.failedBatches, lastError: result.lastError, updatedAt: new Date(0).toISOString() }))
  assert.equal(JSON.parse(progressStore.get('AI_GEN_PROGRESS:QUESTION_BANK:program-1:ALL') || '{}').saved, 8)
}

async function resumeRequestsOnlyRemainingWithoutDuplicates() {
  const saved: GeneratedQuestionCandidate[] = Array.from({ length: 8 }, (_, index) => question(index + 1))
  const seen = new Set(saved.map((item) => questionDuplicateKey(item.text, item.sourceRef)))
  const requestedCounts: number[] = []
  const result = await runProgressiveGenerationBatches({
    requested: 10,
    alreadySaved: 8,
    generate: async (count) => {
      requestedCounts.push(count)
      return [question(9), question(10)]
    },
    save: async (items) => {
      const unique = items.filter((item) => {
        const key = questionDuplicateKey(item.text, item.sourceRef)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      saved.push(...unique)
      return unique.length
    },
  })
  assert.deepEqual(requestedCounts, [2])
  assert.equal(result.saved, 10)
  assert.equal(result.remaining, 0)
  assert.equal(saved.length, 10)
}

async function invalidQuestionIsDroppedButRestAccepted() {
  const saved: GeneratedQuestionCandidate[] = []
  const result = await runProgressiveGenerationBatches({
    requested: 2,
    generate: async () => [
      question(1),
      { ...question(2), correctAnswer: '' },
      question(3),
    ],
    save: async (items) => {
      saved.push(...items)
      return items.length
    },
  })
  assert.equal(saved.length, 2)
  assert.equal(result.saved, 2)
  assert.equal(result.remaining, 0)
  assert.equal(result.lastError, null)
}

async function fakeDeadlineReturnsAcceptedSoFar() {
  let now = 0
  const saved: GeneratedQuestionCandidate[] = []
  const result = await runProgressiveGenerationBatches({
    requested: 10,
    deadlineMs: 240_000,
    now: () => now,
    generate: async (count) => Array.from({ length: count }, (_, index) => question(saved.length + index + 1)),
    save: async (items) => {
      saved.push(...items)
      now += 120_000
      return items.length
    },
  })
  assert.equal(saved.length, 8)
  assert.equal(result.saved, 8)
  assert.equal(result.remaining, 2)
  assert.equal(result.timedOut, true)
  assert.equal(result.lastError, 'AI_REQUEST_DEADLINE_REACHED')
  assert.equal(result.message, 'تم حفظ 8 من 10. اضغط مرة أخرى لإكمال الباقي.')
}

async function main() {
  console.log('▶ AI generation progress helper keys and dedupe')
  assert.equal(aiGenerationProgressKey('QUESTION_BANK', 'program-1', 'ALL'), 'AI_GEN_PROGRESS:QUESTION_BANK:program-1:ALL')
  assert.equal(aiGenerationProgressKey('PROGRAM_EXAM', 'program-1', 2), 'AI_GEN_PROGRESS:PROGRAM_EXAM:program-1:2')

  const a = questionDuplicateKey('ما هو مفهومُ الدليل؟', 'source-1')
  const b = questionDuplicateKey('ما هو مفهوم الدليل', 'source-1')
  const c = questionDuplicateKey('ما هو مفهوم الدليل', 'source-2')
  assert.equal(a, b, 'Arabic normalization should deduplicate equivalent question text for the same source')
  assert.notEqual(a, c, 'same text with a different source remains a different generation target')

  console.log('▶ question bank parser accepts array envelopes and drops invalid question only')
  arrayEnvelopeIsAcceptedAndInvalidQuestionsAreDropped()
  console.log('▶ question bank parser normalizes generated difficulty aliases')
  generatedQuestionDifficultyAliasesAreNormalized()
  console.log('▶ question bank pause cleanup uses deleteMany')
  questionBankPauseCleanupUsesDeleteMany()
  console.log('▶ progressive generation keeps saved batches on third failure')
  await partialFailureKeepsSavedBatches()
  console.log('▶ progressive generation resumes only remaining without duplicates')
  await resumeRequestsOnlyRemainingWithoutDuplicates()
  console.log('▶ progressive generation drops invalid question only')
  await invalidQuestionIsDroppedButRestAccepted()
  console.log('▶ progressive generation deadline returns accepted so far')
  await fakeDeadlineReturnsAcceptedSoFar()

  console.log('AI generation progress helpers: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
