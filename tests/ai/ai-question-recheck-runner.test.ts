import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

mock.module('@/lib/db', () => ({ db: {} }))

const queue = await import('@/lib/question-recheck-queue')
const runner = await import('@/lib/question-recheck-runner')
type Row = import('@/lib/question-recheck-queue').RecheckTaskRow
type Rec = import('@/lib/question-recheck-runner').RecheckQuestionRecord

// --- طبقة الطابور الحقيقية فوق مخزن ذاكرة (نفس نمط باقة الطابور) ---
const eligibility = new Map<string, { id: string; status: string }>()
const tasks: Row[] = []
let seq = 0
queue.__setRecheckQueueStoreForTests({
  async getQuestion(id) { return eligibility.get(id) ?? null },
  async countTasks(questionId) { return tasks.filter((t) => t.questionId === questionId).length },
  async findActiveTask(questionId, reason) {
    return tasks.find((t) => t.questionId === questionId && t.reason === reason && (t.status === 'PENDING' || t.status === 'RUNNING')) ?? null
  },
  async createTask(data) {
    const row: Row = {
      id: `task-${++seq}`, questionId: data.questionId, reason: data.reason, status: 'PENDING',
      profileVersion: data.profileVersion, recommendation: null, error: null,
      createdAt: new Date(), claimedAt: null, finishedAt: null,
    }
    tasks.push(row)
    return { id: row.id }
  },
  async listPending(limit) { return tasks.filter((t) => t.status === 'PENDING').slice(0, limit) },
  async markRunning(id, now) {
    const row = tasks.find((t) => t.id === id)
    if (!row || row.status !== 'PENDING') return false
    row.status = 'RUNNING'
    row.claimedAt = now
    return true
  },
  async finishTask(id, status, payload, now) {
    const row = tasks.find((t) => t.id === id)
    if (!row || row.status !== 'RUNNING') return
    row.status = status
    row.finishedAt = now
    if (payload.recommendation) row.recommendation = payload.recommendation
    if (payload.error) row.error = payload.error
  },
})

// --- تبعيات المشغّل المحقونة ---
const records = new Map<string, Rec>()
const Q_TIME = new Date('2026-10-20T10:00:00.000Z')
const BEFORE_Q = new Date('2026-10-19T10:00:00.000Z')
const AFTER_Q = new Date('2026-10-21T10:00:00.000Z')
const generationRows: { bookId: string; provider: string; model: string; createdAt: Date }[] = []
function addGeneration(provider: string, model: string, createdAt: Date, bookId = 'book-1') {
  generationRows.push({ bookId, provider, model, createdAt })
}
const verifyCalls: Record<string, unknown>[] = []
let verifyImpl: (input: Record<string, unknown>) => Promise<Record<string, unknown>> = async () => ({
  verifierProvider: 'ANTHROPIC', verifierModel: 'claude-v', verifierReason: 'مدعوم بالمصدر',
})
const SEEDED_ROUTING = { preferredModels: [{ provider: 'ANTHROPIC', model: 'claude-v' }], preferredProviders: ['ANTHROPIC'], policy: null, allowGlobalFallback: false }

runner.__setRecheckRunnerDepsForTests({
  async loadQuestion(id) { return records.get(id) ?? null },
  async findLatestGeneration(bookId, _unitId, cutoff) {
    const eligible = generationRows
      .filter((r) => r.bookId === bookId && r.createdAt.getTime() <= cutoff.getTime())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    return eligible[0] ? { provider: eligible[0].provider, model: eligible[0].model } : null
  },
  async prepareReviewRouting() { return SEEDED_ROUTING },
  async verify(input) {
    verifyCalls.push(input as Record<string, unknown>)
    return verifyImpl(input as Record<string, unknown>) as never
  },
})

function seedQuestion(id: string, overrides: Partial<Rec> = {}) {
  eligibility.set(id, { id, status: 'PENDING_REVIEW' })
  records.set(id, {
    id,
    text: 'ما عاصمة فرنسا؟',
    type: 'MCQ',
    options: '["باريس","لندن"]',
    correctAnswer: 'باريس',
    modelAnswer: null,
    sourceEvidence: 'باريس هي عاصمة فرنسا وأكبر مدنها.',
    bookId: 'book-1',
    unitId: 'unit-1',
    createdAt: Q_TIME,
    ...overrides,
  })
}

async function reset() {
  tasks.length = 0
  seq = 0
  records.clear()
  generationRows.length = 0
  verifyCalls.length = 0
  verifyImpl = async () => ({ verifierProvider: 'ANTHROPIC', verifierModel: 'claude-v', verifierReason: 'مدعوم بالمصدر' })
}

describe('D3.2b runner: bounded batch, identity from the D0 log, recommendation only', () => {
  test('a queued task is rechecked under the current REVIEW profile with the recovered generator identity', async () => {
    await reset()
    seedQuestion('q1')
    addGeneration('GEMINI', 'gem-1', BEFORE_Q)
    await queue.enqueueQuestionRecheck({ questionId: 'q1', reason: 'REVIEW_PROFILE_CHANGED' })

    const summary = await runner.runQuestionRecheckBatch({ limit: 10 })
    expect(summary).toEqual({ claimed: 1, done: 1, failed: 0 })
    expect(verifyCalls).toHaveLength(1)
    expect((verifyCalls[0] as { generatorProvider: string }).generatorProvider).toBe('GEMINI')
    expect((verifyCalls[0] as { generatorModel: string }).generatorModel).toBe('gem-1')
    expect((verifyCalls[0] as { routing: unknown }).routing).toEqual(SEEDED_ROUTING)
    expect(tasks[0].status).toBe('DONE')
    expect(tasks[0].recommendation).toMatchObject({ valid: true, verifierProvider: 'ANTHROPIC', verifierModel: 'claude-v' })
    // حالة السؤال لم تُلمس — القرار بيد الإنسان
    expect(eligibility.get('q1')?.status).toBe('PENDING_REVIEW')
  })

  test('no trustworthy generator identity means a clear failure and no verifier call at all', async () => {
    await reset()
    seedQuestion('q2')
    await queue.enqueueQuestionRecheck({ questionId: 'q2', reason: 'NEW_EVIDENCE_AVAILABLE' })

    const summary = await runner.runQuestionRecheckBatch({ limit: 10 })
    expect(summary).toEqual({ claimed: 1, done: 0, failed: 1 })
    expect(verifyCalls).toHaveLength(0)
    expect(tasks[0].status).toBe('FAILED')
    expect(tasks[0].error).toBe('GENERATOR_IDENTITY_UNKNOWN')
    expect(tasks[0].recommendation).toBeNull()
  })

  test('missing source evidence and a vanished question fail clearly, per task', async () => {
    await reset()
    seedQuestion('q3', { sourceEvidence: '   ' })
    addGeneration('GEMINI', 'gem-1', BEFORE_Q)
    eligibility.set('q4', { id: 'q4', status: 'PENDING_REVIEW' }) // بلا سجل سؤال
    await queue.enqueueQuestionRecheck({ questionId: 'q3', reason: 'REVIEW_PROFILE_CHANGED' })
    await queue.enqueueQuestionRecheck({ questionId: 'q4', reason: 'REVIEW_PROFILE_CHANGED' })

    const summary = await runner.runQuestionRecheckBatch({ limit: 10 })
    expect(summary).toEqual({ claimed: 2, done: 0, failed: 2 })
    expect(tasks.find((t) => t.questionId === 'q3')?.error).toBe('RECHECK_SOURCE_EVIDENCE_MISSING')
    expect(tasks.find((t) => t.questionId === 'q4')?.error).toBe('RECHECK_QUESTION_NOT_FOUND')
    expect(verifyCalls).toHaveLength(0)
  })

  test('a pending verifier outcome becomes a not-valid recommendation carrying its reason', async () => {
    await reset()
    seedQuestion('q5')
    addGeneration('GEMINI', 'gem-1', BEFORE_Q)
    verifyImpl = async () => ({ verificationPending: true, verificationReason: 'VERIFIER_EQUALS_GENERATOR' })
    await queue.enqueueQuestionRecheck({ questionId: 'q5', reason: 'REVIEW_PROFILE_CHANGED' })

    const summary = await runner.runQuestionRecheckBatch({ limit: 10 })
    expect(summary.done).toBe(1)
    expect(tasks[0].status).toBe('DONE')
    expect(tasks[0].recommendation).toMatchObject({ valid: false, reason: 'VERIFIER_EQUALS_GENERATOR', verifierProvider: null })
  })

  test('one exploding task never kills the batch, and the limit is respected', async () => {
    await reset()
    seedQuestion('q6')
    seedQuestion('q7')
    seedQuestion('q8')
    addGeneration('GEMINI', 'gem-1', BEFORE_Q)
    let calls = 0
    verifyImpl = async () => {
      calls++
      if (calls === 1) throw new Error('router exploded')
      return { verifierProvider: 'ANTHROPIC', verifierModel: 'claude-v', verifierReason: 'ok' }
    }
    for (const q of ['q6', 'q7', 'q8']) {
      await queue.enqueueQuestionRecheck({ questionId: q, reason: 'MANUAL_ADMIN_RECHECK' })
    }
    const summary = await runner.runQuestionRecheckBatch({ limit: 2 })
    expect(summary).toEqual({ claimed: 2, done: 1, failed: 1 })
    expect(tasks.filter((t) => t.status === 'FAILED')[0].error).toBe('router exploded')
    expect(tasks.filter((t) => t.status === 'PENDING')).toHaveLength(1)
  })
})

describe('D3.2b scope guards', () => {
  test('the runner writes through the queue only — no question-record writes anywhere', () => {
    const runnerSrc = readFileSync('src/lib/question-recheck-runner.ts', 'utf8')
    expect(runnerSrc).not.toContain('questionBankItem.update')
    expect(runnerSrc).toContain('completeRecheckTask')
    expect(runnerSrc).toContain("stage: 'GENERATION'")
  })
})

describe('D3.2c: generator identity never comes from a generation newer than the question', () => {
  test('with an old and a new generation around the question, the OLD one is the identity', async () => {
    await reset()
    seedQuestion('q-old')
    addGeneration('GEMINI', 'gem-old', BEFORE_Q)
    addGeneration('OPENAI', 'gpt-new', AFTER_Q)
    await queue.enqueueQuestionRecheck({ questionId: 'q-old', reason: 'REVIEW_PROFILE_CHANGED' })

    const summary = await runner.runQuestionRecheckBatch({ limit: 10 })
    expect(summary).toEqual({ claimed: 1, done: 1, failed: 0 })
    expect(verifyCalls).toHaveLength(1)
    expect((verifyCalls[0] as { generatorProvider: string }).generatorProvider).toBe('GEMINI')
    expect((verifyCalls[0] as { generatorModel: string }).generatorModel).toBe('gem-old')
    expect(tasks[0].status).toBe('DONE')
  })

  test('with only a generation NEWER than the question, identity is unknown and the verifier is never called', async () => {
    await reset()
    seedQuestion('q-new')
    addGeneration('OPENAI', 'gpt-new', AFTER_Q)
    await queue.enqueueQuestionRecheck({ questionId: 'q-new', reason: 'REVIEW_PROFILE_CHANGED' })

    const summary = await runner.runQuestionRecheckBatch({ limit: 10 })
    expect(summary).toEqual({ claimed: 1, done: 0, failed: 1 })
    expect(verifyCalls).toHaveLength(0)
    expect(tasks[0].status).toBe('FAILED')
    expect(tasks[0].error).toBe('GENERATOR_IDENTITY_UNKNOWN')
  })

  test('the production lookup itself carries the time cutoff', () => {
    const runnerSrc = readFileSync('src/lib/question-recheck-runner.ts', 'utf8')
    expect(runnerSrc).toContain('createdAt: { lte: createdBeforeOrAt }')
    expect(runnerSrc).toContain('question.createdAt')
  })
})
