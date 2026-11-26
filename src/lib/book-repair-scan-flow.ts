// Book distortion repair — two-mode scan driver.
//
// The «فحص وإصلاح تشوهات الكتاب» button offers two modes:
// - 'batch': one bounded step (4 chunks / 20 items), today's behaviour.
// - 'complete': keep stepping (1s pause between steps) until the server
//   says `done`, the admin stops, a read job takes the book (409), or an
//   error occurs.
//
// The driver is pure and testable: it only calls the `api` helper and the
// callbacks the component supplies. Per-step caps, the AI repair budget
// and mutual exclusion all stay server-side (one SCAN POST per step, same
// body). `done` is the server's definition (corrected + review-queued
// count as finished work), including the Task-1 reconciliation: a step
// that resolves stale remaining ids reports `done: true` and ends the loop.

import { api } from '@/lib/store'

export interface BookRepairScanCounters {
  chunksCorrected: number; chunksNeedsReview: number; chunksRemaining: number
  itemsCorrected: number; itemsNeedsReview: number; itemsRemaining: number
}

export interface BookRepairScanStepResult {
  job: { status?: string | null; [key: string]: unknown }
  counters: BookRepairScanCounters
  done: boolean
  processedChunks: number
  processedItems?: number
  // True when the step moved nothing while work remains (Task 1): the
  // client shows this honestly instead of repeating «بقي عمل» counters.
  noProgress?: boolean
}

export type BookRepairScanFlowOutcome = 'done' | 'more-work' | 'stopped' | 'error' | 'conflict'

export interface BookRepairScanFlowResult {
  outcome: BookRepairScanFlowOutcome
  steps: number
  lastStep?: BookRepairScanStepResult
  error?: unknown
}

// Pause between complete-mode steps so the UI (counters + stop button) stays
// responsive. The step itself is the slow part (OCR round-trips).
export const BOOK_REPAIR_COMPLETE_PAUSE_MS = 1000

export async function runBookRepairScanFlow(options: {
  mode: 'batch' | 'complete'
  bookId: string
  shouldStop: () => boolean
  onStep: (step: BookRepairScanStepResult) => void
  reassertStop: () => Promise<unknown>
  pauseMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<BookRepairScanFlowResult> {
  const pauseMs = options.pauseMs ?? BOOK_REPAIR_COMPLETE_PAUSE_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let steps = 0
  let lastStep: BookRepairScanStepResult | undefined
  for (;;) {
    if (options.shouldStop()) {
      // A STOP pressed mid-step is overwritten by the step's final status
      // write (book-repair-job.ts saveProgress); re-assert STOP after the
      // step lands so PAUSED is durable. The route treats a repeat STOP as
      // a no-op when already PAUSED. Swallowed: the loop already halted.
      if (steps > 0) await options.reassertStop().catch(() => {})
      return { outcome: 'stopped', steps, lastStep }
    }
    let step: BookRepairScanStepResult
    try {
      step = await api<BookRepairScanStepResult>(
        `/api/admin/books/${options.bookId}/repair-corrupt-pages`,
        { method: 'POST', body: JSON.stringify({ mode: 'SCAN' }) },
      )
    } catch (error: unknown) {
      if (String((error as { message?: unknown } | null)?.message || error).includes('BOOK_REPAIR_JOB_ACTIVE')) {
        return { outcome: 'conflict', steps, lastStep, error }
      }
      return { outcome: 'error', steps, lastStep, error }
    }
    steps += 1
    lastStep = step
    options.onStep(step)
    if (step.done) return { outcome: 'done', steps, lastStep }
    if (step.job?.status === 'PAUSED') {
      await options.reassertStop().catch(() => {})
      return { outcome: 'stopped', steps, lastStep }
    }
    if (options.mode === 'batch') return { outcome: 'more-work', steps, lastStep }
    if (options.shouldStop()) {
      await options.reassertStop().catch(() => {})
      return { outcome: 'stopped', steps, lastStep }
    }
    await sleep(pauseMs)
  }
}
