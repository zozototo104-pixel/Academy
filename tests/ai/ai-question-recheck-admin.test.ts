import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

mock.module('@/lib/db', () => ({ db: {} }))

const admin = await import('@/lib/question-recheck-admin')

type Candidate = { id: string; qualityFlags: string | null; createdAt: Date; updatedAt: Date }
type RecentTask = Awaited<ReturnType<typeof admin.getQuestionRecheckOverview>>['recentTasks'][number]

const date = (value: string) => new Date(value)
let candidates: Candidate[] = []
let enqueueCalls: string[] = []
let enqueueBehavior: Record<string, () => Promise<{ enqueued: true; taskId: string } | { enqueued: false; reason: 'already-queued' | 'cap-reached' | 'not-eligible' | 'not-found' }>> = {}
let pendingCount = 0
let recentTasks: RecentTask[] = []

beforeEach(() => {
  candidates = []
  enqueueCalls = []
  enqueueBehavior = {}
  pendingCount = 0
  recentTasks = []
  admin.__setQuestionRecheckAdminDepsForTests({
    async listPendingReviewCandidates() { return candidates },
    async enqueue(input) {
      enqueueCalls.push(input.questionId)
      const behavior = enqueueBehavior[input.questionId]
      return behavior ? behavior() : { enqueued: true, taskId: `task-${input.questionId}` }
    },
    async pendingCount() { return pendingCount },
    async recentTasks() { return recentTasks },
  })
})

describe('R1 controlled REVIEW profile recheck enqueue policy', () => {
  test('the optional request is explicit, defaulted, and capped to the approved range', () => {
    expect(admin.parseReviewRecheckEnqueueRequest(undefined)).toEqual({ enabled: false, cap: 50 })
    expect(admin.parseReviewRecheckEnqueueRequest({ enabled: false, cap: 7 })).toEqual({ enabled: false, cap: 7 })
    expect(admin.parseReviewRecheckEnqueueRequest({ enabled: true, cap: 999 })).toEqual({ enabled: true, cap: 200 })
    expect(admin.parseReviewRecheckEnqueueRequest({ enabled: true, cap: -10 })).toEqual({ enabled: true, cap: 1 })
  })

  test('pending-review cohort prioritizes ungrounded questions and the cap counts successful enqueue only', async () => {
    candidates = [
      { id: 'grounded-old', qualityFlags: '["SOURCE_GROUNDED"]', createdAt: date('2026-01-01T00:00:00Z'), updatedAt: date('2026-01-01T00:00:00Z') },
      { id: 'needs-old', qualityFlags: null, createdAt: date('2026-01-02T00:00:00Z'), updatedAt: date('2026-01-02T00:00:00Z') },
      { id: 'needs-new', qualityFlags: '[]', createdAt: date('2026-01-03T00:00:00Z'), updatedAt: date('2026-01-03T00:00:00Z') },
    ]

    const report = await admin.enqueuePendingReviewQuestionsForProfileChange({ profileVersion: 12, cap: 1 })

    expect(enqueueCalls).toEqual(['needs-old'])
    expect(report).toMatchObject({
      requestedCap: 1,
      cohortTotal: 3,
      enqueued: 1,
      skippedCapReached: 2,
      skippedAlreadyQueued: 0,
      skippedIneligible: 0,
      failed: 0,
    })
  })

  test('skip reasons are reported precisely and enqueue failures do not throw away a saved profile result', async () => {
    candidates = [
      { id: 'q-enqueue', qualityFlags: null, createdAt: date('2026-01-01T00:00:00Z'), updatedAt: date('2026-01-01T00:00:00Z') },
      { id: 'q-existing', qualityFlags: null, createdAt: date('2026-01-02T00:00:00Z'), updatedAt: date('2026-01-02T00:00:00Z') },
      { id: 'q-cap', qualityFlags: null, createdAt: date('2026-01-03T00:00:00Z'), updatedAt: date('2026-01-03T00:00:00Z') },
      { id: 'q-ineligible', qualityFlags: null, createdAt: date('2026-01-04T00:00:00Z'), updatedAt: date('2026-01-04T00:00:00Z') },
      { id: 'q-error', qualityFlags: null, createdAt: date('2026-01-05T00:00:00Z'), updatedAt: date('2026-01-05T00:00:00Z') },
    ]
    enqueueBehavior = {
      'q-existing': async () => ({ enqueued: false, reason: 'already-queued' }),
      'q-cap': async () => ({ enqueued: false, reason: 'cap-reached' }),
      'q-ineligible': async () => ({ enqueued: false, reason: 'not-eligible' }),
      'q-error': async () => { throw new Error('db write unavailable') },
    }

    const report = await admin.enqueuePendingReviewQuestionsForProfileChange({ profileVersion: 13, cap: 10 })

    expect(enqueueCalls).toEqual(['q-enqueue', 'q-existing', 'q-cap', 'q-ineligible', 'q-error'])
    expect(report.enqueued).toBe(1)
    expect(report.skippedAlreadyQueued).toBe(1)
    expect(report.skippedCapReached).toBe(1)
    expect(report.skippedIneligible).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.errors[0]).toEqual({ questionId: 'q-error', error: 'db write unavailable' })
  })
})

describe('R2/R3 admin question recheck overview and route wiring', () => {
  test('overview returns pending count and recent recommendations for read-only display', async () => {
    pendingCount = 3
    recentTasks = [{
      id: 'task-1',
      questionId: 'question-1',
      reason: 'REVIEW_PROFILE_CHANGED',
      status: 'DONE',
      profileVersion: '12',
      recommendation: { valid: false, reason: 'الدليل لا يدعم الإجابة', checkedAt: '2026-10-22T00:00:00Z' },
      error: null,
      createdAt: date('2026-10-22T00:00:00Z'),
      claimedAt: date('2026-10-22T00:01:00Z'),
      finishedAt: date('2026-10-22T00:02:00Z'),
      question: { id: 'question-1', text: 'ما الفكرة الأساسية؟', status: 'PENDING_REVIEW' },
    }]

    const overview = await admin.getQuestionRecheckOverview()

    expect(overview.pendingCount).toBe(3)
    expect(overview.recentTasks[0].recommendation).toEqual({ valid: false, reason: 'الدليل لا يدعم الإجابة', checkedAt: '2026-10-22T00:00:00Z' })
    expect(overview.recentTasks[0].question?.status).toBe('PENDING_REVIEW')
  })

  test('the admin route is admin-only and runs one bounded manual batch without changing question status directly', () => {
    const route = readFileSync('src/app/api/admin/question-recheck/route.ts', 'utf8')
    const ui = readFileSync('src/components/aact/AdminAiStageProfiles.tsx', 'utf8')
    expect(route).toContain('await requireAdmin()')
    expect(route).toContain('runQuestionRecheckBatch({ limit: QUESTION_RECHECK_RUN_BATCH_SIZE })')
    expect(route).toContain('getQuestionRecheckOverview()')
    expect(route).not.toContain('questionBankItem.update')
    expect(ui).toContain('تشغيل دفعة إعادة تدقيق')
    expect(ui).toContain('بالانتظار: {questionRecheckOverview?.pendingCount ?? 0}')
    expect(ui).not.toContain('APPROVED')
  })
})
