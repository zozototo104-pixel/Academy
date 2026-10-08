export type GeneratedQuestionCandidate = {
  type?: string | null
  text?: string | null
  correctAnswer?: string | number | null
  correct?: string | number | null
  options?: unknown
  sourceRef?: string | null
  [key: string]: unknown
}

export type ProgressiveBatchResult<T extends GeneratedQuestionCandidate> = {
  requested: number
  saved: number
  remaining: number
  failedBatches: number
  accepted: T[]
  batchSizes: number[]
  done: boolean
  partial: boolean
  lastError: string | null
  message: string | null
  timedOut: boolean
}

export function isGeneratedQuestionStructurallyUsable(question: GeneratedQuestionCandidate): boolean {
  const text = String(question.text || '').trim()
  if (text.length < 8) return false
  const type = String(question.type || 'MCQ').toUpperCase()
  if (type === 'MCQ' || type === 'TF' || type === 'TRUE_FALSE') {
    const answer = question.correctAnswer ?? question.correct
    if (answer == null || String(answer).trim() === '') return false
  }
  return true
}

export async function runProgressiveGenerationBatches<T extends GeneratedQuestionCandidate>(opts: {
  requested: number
  alreadySaved?: number
  maxBatchSize?: number
  deadlineMs?: number
  now?: () => number
  generate: (count: number) => Promise<T[]>
  save: (items: T[]) => Promise<number>
  accept?: (item: T) => boolean
}): Promise<ProgressiveBatchResult<T>> {
  const requested = Math.max(0, Math.floor(opts.requested || 0))
  let saved = Math.max(0, Math.floor(opts.alreadySaved || 0))
  const maxBatchSize = Math.max(1, Math.min(4, Math.floor(opts.maxBatchSize || 4)))
  const now = opts.now || (() => Date.now())
  const accepted: T[] = []
  const batchSizes: number[] = []
  let failedBatches = 0
  let lastError: string | null = null
  let timedOut = false

  while (saved < requested) {
    if (opts.deadlineMs && now() >= opts.deadlineMs) {
      timedOut = true
      lastError = 'AI_REQUEST_DEADLINE_REACHED'
      break
    }
    const count = Math.min(maxBatchSize, requested - saved)
    batchSizes.push(count)
    let raw: T[] = []
    try {
      raw = await opts.generate(count)
    } catch (error: any) {
      failedBatches += 1
      lastError = String(error?.message || error || 'AI_BATCH_FAILED').slice(0, 500)
      break
    }
    const usable = raw.filter((item) => (opts.accept ? opts.accept(item) : isGeneratedQuestionStructurallyUsable(item)))
    if (!usable.length) {
      failedBatches += 1
      lastError = 'AI_BATCH_EMPTY_AFTER_VALIDATION'
      break
    }
    const inserted = await opts.save(usable)
    if (inserted <= 0) {
      failedBatches += 1
      lastError = 'AI_BATCH_SAVED_ZERO'
      break
    }
    saved += inserted
    accepted.push(...usable.slice(0, inserted))
  }

  const remaining = Math.max(0, requested - saved)
  const done = remaining === 0
  const partial = !done && saved > 0
  return {
    requested,
    saved,
    remaining,
    failedBatches,
    accepted,
    batchSizes,
    done,
    partial,
    lastError,
    timedOut,
    message: done ? null : `تم حفظ ${saved} من ${requested}. اضغط مرة أخرى لإكمال الباقي.`,
  }
}
