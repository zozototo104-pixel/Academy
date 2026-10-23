import { db } from '@/lib/db'
import { enqueueQuestionRecheck, type EnqueueRecheckResult } from '@/lib/question-recheck-queue'

// سياسة الإدارة فوق ماكينة D3.2 الموجودة:
// - الإدخال يحدث فقط بقرار صريح عند حفظ REVIEW.
// - الحفظ لا يشغّل ذكاء اصطناعيًا؛ الإدخال للطابور فقط.
// - التشغيل يبقى عبر مشغّل مستقل وبحد دفعة ثابت في مسار إداري منفصل.

export const DEFAULT_REVIEW_RECHECK_ENQUEUE_CAP = 50
export const MAX_REVIEW_RECHECK_ENQUEUE_CAP = 200
export const QUESTION_RECHECK_RUN_BATCH_SIZE = 10

export type RecheckEnqueueSkipReason = 'already-queued' | 'cap-reached' | 'ineligible'

export interface ReviewRecheckEnqueueReport {
  requestedCap: number
  cohortTotal: number
  enqueued: number
  skippedAlreadyQueued: number
  skippedCapReached: number
  skippedIneligible: number
  failed: number
  errors: { questionId: string | null; error: string }[]
}

export interface QuestionRecheckRecentTask {
  id: string
  questionId: string
  reason: string
  status: string
  profileVersion: string | null
  recommendation: unknown
  error: string | null
  createdAt: Date
  claimedAt: Date | null
  finishedAt: Date | null
  question: { id: string; text: string; status: string } | null
}

export interface QuestionRecheckOverview {
  pendingCount: number
  recentTasks: QuestionRecheckRecentTask[]
}

interface RecheckCandidate {
  id: string
  qualityFlags: string | null
  createdAt: Date
  updatedAt: Date
}

interface QuestionRecheckAdminDeps {
  listPendingReviewCandidates(): Promise<RecheckCandidate[]>
  enqueue(input: { questionId: string; reason: 'REVIEW_PROFILE_CHANGED'; profileVersion: string }): Promise<EnqueueRecheckResult>
  pendingCount(): Promise<number>
  recentTasks(take: number): Promise<QuestionRecheckRecentTask[]>
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
}

function parseQualityFlags(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.map(String)
  } catch {
    // legacy/plain storage: fall back to substring checks below
  }
  return String(raw).split(/[,.\s]+/).map((item) => item.trim()).filter(Boolean)
}

function isUngroundedCandidate(candidate: RecheckCandidate): boolean {
  return !parseQualityFlags(candidate.qualityFlags).includes('SOURCE_GROUNDED')
}

function candidatePriority(a: RecheckCandidate, b: RecheckCandidate): number {
  const aUngrounded = isUngroundedCandidate(a)
  const bUngrounded = isUngroundedCandidate(b)
  if (aUngrounded !== bUngrounded) return aUngrounded ? -1 : 1
  return a.createdAt.getTime() - b.createdAt.getTime()
}

const prismaDeps: QuestionRecheckAdminDeps = {
  async listPendingReviewCandidates() {
    return db.questionBankItem.findMany({
      where: { status: 'PENDING_REVIEW' },
      select: { id: true, qualityFlags: true, createdAt: true, updatedAt: true },
      orderBy: { createdAt: 'asc' },
    })
  },
  enqueue: (input) => enqueueQuestionRecheck(input),
  async pendingCount() {
    return db.questionRecheckTask.count({ where: { status: 'PENDING' } })
  },
  async recentTasks(take) {
    const rows = await db.questionRecheckTask.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        questionId: true,
        reason: true,
        status: true,
        profileVersion: true,
        recommendation: true,
        error: true,
        createdAt: true,
        claimedAt: true,
        finishedAt: true,
        question: { select: { id: true, text: true, status: true } },
      },
    })
    return rows as unknown as QuestionRecheckRecentTask[]
  },
}

let deps: QuestionRecheckAdminDeps = prismaDeps

export function __setQuestionRecheckAdminDepsForTests(next: Partial<QuestionRecheckAdminDeps> | null) {
  deps = next ? { ...prismaDeps, ...next } : prismaDeps
}

export function normalizeReviewRecheckEnqueueCap(value: unknown): number {
  const parsed = Number(value ?? DEFAULT_REVIEW_RECHECK_ENQUEUE_CAP)
  if (!Number.isFinite(parsed)) return DEFAULT_REVIEW_RECHECK_ENQUEUE_CAP
  return Math.max(1, Math.min(MAX_REVIEW_RECHECK_ENQUEUE_CAP, Math.floor(parsed)))
}

export function parseReviewRecheckEnqueueRequest(value: unknown): { enabled: boolean; cap: number } {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    enabled: input.enabled === true,
    cap: normalizeReviewRecheckEnqueueCap(input.cap),
  }
}

export function failedReviewRecheckEnqueueReport(requestedCap: number, error: unknown): ReviewRecheckEnqueueReport {
  return {
    requestedCap,
    cohortTotal: 0,
    enqueued: 0,
    skippedAlreadyQueued: 0,
    skippedCapReached: 0,
    skippedIneligible: 0,
    failed: 1,
    errors: [{ questionId: null, error: safeError(error) }],
  }
}

export async function enqueuePendingReviewQuestionsForProfileChange(input: {
  profileVersion: number | string
  cap: number
}): Promise<ReviewRecheckEnqueueReport> {
  const requestedCap = normalizeReviewRecheckEnqueueCap(input.cap)
  const candidates = (await deps.listPendingReviewCandidates()).sort(candidatePriority)
  const report: ReviewRecheckEnqueueReport = {
    requestedCap,
    cohortTotal: candidates.length,
    enqueued: 0,
    skippedAlreadyQueued: 0,
    skippedCapReached: 0,
    skippedIneligible: 0,
    failed: 0,
    errors: [],
  }

  let processed = 0
  for (const candidate of candidates) {
    if (report.enqueued >= requestedCap) {
      report.skippedCapReached += candidates.length - processed
      break
    }
    processed++
    try {
      const result = await deps.enqueue({
        questionId: candidate.id,
        reason: 'REVIEW_PROFILE_CHANGED',
        profileVersion: String(input.profileVersion),
      })
      if (result.enqueued) {
        report.enqueued++
        continue
      }
      if (result.reason === 'already-queued') report.skippedAlreadyQueued++
      else if (result.reason === 'cap-reached') report.skippedCapReached++
      else report.skippedIneligible++
    } catch (error) {
      report.failed++
      report.errors.push({ questionId: candidate.id, error: safeError(error) })
    }
  }

  return report
}

export async function getQuestionRecheckOverview(input: { take?: number } = {}): Promise<QuestionRecheckOverview> {
  const take = Math.max(1, Math.min(50, Math.floor(input.take ?? 20) || 20))
  const [pendingCount, recentTasks] = await Promise.all([
    deps.pendingCount(),
    deps.recentTasks(take),
  ])
  return { pendingCount, recentTasks }
}
