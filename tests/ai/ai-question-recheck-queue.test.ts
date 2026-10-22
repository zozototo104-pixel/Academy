import { describe, expect, mock, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

mock.module('@/lib/db', () => ({ db: {} }))

const queue = await import('@/lib/question-recheck-queue')
type Row = import('@/lib/question-recheck-queue').RecheckTaskRow

const questions = new Map<string, { id: string; status: string }>([
  ['q-pending', { id: 'q-pending', status: 'PENDING_REVIEW' }],
  ['q-approved', { id: 'q-approved', status: 'APPROVED' }],
  ['q-rejected', { id: 'q-rejected', status: 'REJECTED' }],
])
const tasks: Row[] = []
let seq = 0
let throwP2002OnCreate = false

queue.__setRecheckQueueStoreForTests({
  async getQuestion(id) { return questions.get(id) ?? null },
  async countTasks(questionId) { return tasks.filter((t) => t.questionId === questionId).length },
  async findActiveTask(questionId, reason) {
    return tasks.find((t) => t.questionId === questionId && t.reason === reason && (t.status === 'PENDING' || t.status === 'RUNNING')) ?? null
  },
  async createTask(data) {
    if (throwP2002OnCreate) {
      throwP2002OnCreate = false
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    }
    const row: Row = {
      id: `task-${++seq}`,
      questionId: data.questionId,
      reason: data.reason,
      status: 'PENDING',
      activeDedupKey: data.activeDedupKey,
      profileVersion: data.profileVersion,
      recommendation: null,
      error: null,
      createdAt: new Date(),
      claimedAt: null,
      finishedAt: null,
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
    row.activeDedupKey = null
    row.finishedAt = now
    if (payload.recommendation) row.recommendation = payload.recommendation
    if (payload.error) row.error = payload.error
  },
})

function reset() {
  tasks.length = 0
  seq = 0
}

describe('D3.2a queue layer: enqueue rules (eligibility, idempotency, cap)', () => {
  test('an eligible pending-review question is enqueued with its reason recorded', async () => {
    reset()
    const out = await queue.enqueueQuestionRecheck({ questionId: 'q-pending', reason: 'REVIEW_PROFILE_CHANGED', profileVersion: '7' })
    expect(out.enqueued).toBe(true)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].reason).toBe('REVIEW_PROFILE_CHANGED')
    expect(tasks[0].profileVersion).toBe('7')
    expect(tasks[0].status).toBe('PENDING')
    expect(tasks[0].activeDedupKey).toBe('q-pending:REVIEW_PROFILE_CHANGED')
  })

  test('a duplicate active task for the same reason is refused (idempotent)', async () => {
    reset()
    await queue.enqueueQuestionRecheck({ questionId: 'q-pending', reason: 'NEW_EVIDENCE_AVAILABLE' })
    const dup = await queue.enqueueQuestionRecheck({ questionId: 'q-pending', reason: 'NEW_EVIDENCE_AVAILABLE' })
    expect(dup).toEqual({ enqueued: false, reason: 'already-queued' })
    expect(tasks).toHaveLength(1)
    // سبب مختلف = مهمة مختلفة، مسموحة
    const other = await queue.enqueueQuestionRecheck({ questionId: 'q-pending', reason: 'MANUAL_ADMIN_RECHECK' })
    expect(other.enqueued).toBe(true)
  })

  test('finally-decided questions are never eligible; missing ones are reported', async () => {
    reset()
    expect(await queue.enqueueQuestionRecheck({ questionId: 'q-approved', reason: 'REVIEW_PROFILE_CHANGED' }))
      .toEqual({ enqueued: false, reason: 'not-eligible' })
    expect(await queue.enqueueQuestionRecheck({ questionId: 'q-rejected', reason: 'REVIEW_PROFILE_CHANGED' }))
      .toEqual({ enqueued: false, reason: 'not-eligible' })
    expect(await queue.enqueueQuestionRecheck({ questionId: 'q-ghost', reason: 'REVIEW_PROFILE_CHANGED' }))
      .toEqual({ enqueued: false, reason: 'not-found' })
    expect(tasks).toHaveLength(0)
  })

  test('the attempt cap is hard: the 4th enqueue is refused even across reasons', async () => {
    reset()
    for (const reason of queue.RECHECK_REASONS) {
      const out = await queue.enqueueQuestionRecheck({ questionId: 'q-pending', reason })
      expect(out.enqueued).toBe(true)
      const claimed = await queue.claimNextRecheckTasks(1)
      await queue.completeRecheckTask(claimed[0].id, { valid: true, verifierProvider: 'OPENAI', verifierModel: 'v', reason: 'ok', checkedAt: new Date().toISOString() })
    }
    expect(tasks).toHaveLength(queue.MAX_AUTO_RECHECKS)
    const fourth = await queue.enqueueQuestionRecheck({ questionId: 'q-pending', reason: 'REVIEW_PROFILE_CHANGED' })
    expect(fourth).toEqual({ enqueued: false, reason: 'cap-reached' })
  })
})

describe('D3.2a queue layer: claim and completion are recommendation-only', () => {
  test('claiming moves PENDING to RUNNING exactly once; completion stores only a recommendation', async () => {
    reset()
    await queue.enqueueQuestionRecheck({ questionId: 'q-pending', reason: 'REVIEW_PROFILE_CHANGED' })
    const first = await queue.claimNextRecheckTasks(10)
    expect(first).toHaveLength(1)
    expect(first[0].status).toBe('RUNNING')
    expect(await queue.claimNextRecheckTasks(10)).toHaveLength(0)

    await queue.completeRecheckTask(first[0].id, {
      valid: false,
      verifierProvider: 'ANTHROPIC',
      verifierModel: 'claude-v',
      reason: 'الدليل لا يدعم الإجابة',
      checkedAt: '2026-10-22T16:00:00.000Z',
    })
    expect(tasks[0].status).toBe('DONE')
    expect(tasks[0].activeDedupKey).toBeNull()
    expect(tasks[0].recommendation?.valid).toBe(false)
    expect(tasks[0].finishedAt).not.toBeNull()
    // السؤال نفسه لم يُلمس: حالته كما هي وقراره بيد الإنسان
    expect(questions.get('q-pending')?.status).toBe('PENDING_REVIEW')
  })

  test('a failed run is recorded as FAILED with its error, never as a verdict on the question', async () => {
    reset()
    await queue.enqueueQuestionRecheck({ questionId: 'q-pending', reason: 'NEW_EVIDENCE_AVAILABLE' })
    const claimed = await queue.claimNextRecheckTasks(1)
    await queue.failRecheckTask(claimed[0].id, 'router unavailable')
    expect(tasks[0].status).toBe('FAILED')
    expect(tasks[0].error).toBe('router unavailable')
    expect(tasks[0].recommendation).toBeNull()
  })
})

describe('D3.2a scope guards: data layer only, no writers wired yet', () => {
  test('the queue library never writes to the question record', () => {
    const lib = readFileSync('src/lib/question-recheck-queue.ts', 'utf8')
    expect(lib).not.toContain('questionBankItem.update')
    expect(lib).not.toContain('questionBankItem.create')
    expect(lib).toContain('questionBankItem.findUnique')
  })

  test('only the bounded runner consumes the queue inside src', () => {
    const out = execSync("grep -rl 'question-recheck-queue' src --include='*.ts' || true", { encoding: 'utf8' })
    const files = out.split('\n').filter(Boolean)
    // المستهلك الوحيد المسموح هو مشغّل D3.2b — لا كاتب آخر في src
    expect(files).toEqual(['src/lib/question-recheck-runner.ts'])
  })
})

describe('D3.2b atomicity: the partial unique index conflict reads as already-queued', () => {
  test('a P2002 from create (a lost enqueue race) is translated, never thrown at the caller', async () => {
    reset()
    throwP2002OnCreate = true
    const out = await queue.enqueueQuestionRecheck({ questionId: 'q-pending', reason: 'REVIEW_PROFILE_CHANGED' })
    expect(out).toEqual({ enqueued: false, reason: 'already-queued' })
    expect(tasks).toHaveLength(0)
    // والفهرس وحده لا يكفي: ملف الـmigration موجود فعلًا بالقيد الجزئي
    const sql = readFileSync('prisma/migrations/20261022190000_question_recheck_active_unique/migration.sql', 'utf8')
    expect(sql).toContain('CREATE UNIQUE INDEX')
    expect(sql).toContain("WHERE \"status\" IN ('PENDING', 'RUNNING')")
  })
})
