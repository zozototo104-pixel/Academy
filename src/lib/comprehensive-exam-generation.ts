// Comprehensive exam — shared question-generation core (phase 1).
// The custom-book and internet sources both generate MCQ/TF questions
// from a set of selected source chunks through the GENERATION stage
// profile, under the same evidence gate. This module holds the part
// that is identical for every source: the stage-run completion, the
// evidence validation, the single comprehensive gate, the dedupe, and
// the rejected-reason rebuilding. Sources differ only in how they get
// their chunks and in their prompt text.
// Closed questions ONLY (MCQ | TF) — the single gate refuses anything
// else, and an all-rejected batch fails outright, never silently.
import { normalizeArabic } from './arabic-normalize'
import {
  MAX_QUESTIONS_PER_SOURCE_CHUNK,
  throwComprehensiveExamInsufficientSource,
  validateGeneratedExamQuestionsAgainstSelectedChunks,
  type GeneratedComprehensiveExamQuestion,
} from './comprehensive-exam-evidence'
import { validateComprehensiveQuestion, type ComprehensiveQuestionInput } from './comprehensive-exam'
import { validateQuestionBatchAgainstKnowledge } from './question-bank-evidence'
import { geminiCompleteJson } from './gemini'
import { prepareStageRun, runStageAttempt, type StageUsage } from './ai-stage-runner'
import { withPipelineRun } from './ai-pipeline-log'
import type { ExamSourceChunk } from './exam-source-chunks'
import type { TextAiPreferredModel, TextAiProvider, TextAiRouterPolicy } from './text-ai'

export type ExamGenerationRejected = { index: number; reason: string }

export type ExamGenerationItem = {
  question: ComprehensiveQuestionInput
  sourceIndex: number | string
  sourceEvidence: string
}

export type ExamGenerationResult = {
  items: ExamGenerationItem[]
  requested: number
  accepted: number
  rejected: ExamGenerationRejected[]
  rejectedCount: number
  provider?: string
  model?: string
}

// Parses the model's JSON array (bare or wrapped in prose). The
// evidence validator reports rejections only when it throws, so the
// caller reuses this parse to attach a reason to each dropped draft.
export function parseRawQuestionItems(raw: string): Array<Record<string, unknown>> {
  const trimmed = String(raw || '').trim()
  const tryParse = (text: string): Array<Record<string, unknown>> | null => {
    try {
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null
    } catch {
      return null
    }
  }
  const direct = tryParse(trimmed)
  if (direct) return direct
  const start = trimmed.indexOf('[')
  const end = trimmed.lastIndexOf(']')
  if (start >= 0 && end > start) return tryParse(trimmed.slice(start, end + 1)) ?? []
  return []
}

export function countRawQuestionItems(raw: string): number {
  return parseRawQuestionItems(raw).length
}

export type CompleteJsonFn = (args: {
  system: string
  prompt: string
  validate: (text: string, context?: { provider: string; model: string }) => void
}) => Promise<{ text: string; provider?: string; model?: string }>

// The default completion path: the GENERATION stage profile (the
// admin's chosen models, or the auto ranking when auto is on) with the
// same ACADEMIC_CRITICAL strictness as the existing exam generation —
// a failed validation rethrows, so the allowlist cannot be escaped.
async function defaultCompleteJsonWithStage(args: {
  system: string
  prompt: string
  batchId: string
  stickyScope: string
  detailSource: string
  deadlineMs: number
  validate: (text: string, context?: { provider: string; model: string }) => void
}): Promise<{ text: string; provider?: string; model?: string }> {
  const genPlan = await prepareStageRun('GENERATION')
  const genUsage: StageUsage = { fallbackUsed: false }
  let context: { provider?: string; model?: string } = {}
  const text = await withPipelineRun(
    {
      stage: 'GENERATION',
      bookId: null,
      batchId: args.batchId,
      inputText: args.prompt,
      promptText: args.system,
      profileStamp: genPlan.profileStamp,
      fallbackUsed: !genPlan.isStage,
      liveState: genUsage,
      detail: { ...genPlan.detail, source: args.detailSource },
    },
    () =>
      runStageAttempt(genPlan, genUsage, (routing) => {
        const routingModels = routing
          ? routing.preferredModels.map((m) => ({ provider: m.provider as TextAiPreferredModel['provider'], model: m.model }))
          : []
        return geminiCompleteJson({
          system: args.system,
          history: [{ role: 'user', text: args.prompt }],
          temperature: 0.25,
          maxOutputTokens: 8192,
          taskLevel: 'ACADEMIC_CRITICAL',
          deadlineMs: args.deadlineMs,
          stickyScope: args.stickyScope,
          validate: (t, c) => {
            context = c || {}
            args.validate(t, c)
          },
          ...(routing
            ? {
                preferredModels: routingModels,
                restrictToModels: routingModels,
                preferredProviders: [...new Set([...routing.preferredProviders, ...routing.preferredModels.map((m) => m.provider)])] as TextAiProvider[],
                ...(routing.policy ? { routerPolicy: routing.policy as TextAiRouterPolicy } : {}),
              }
            : {}),
        })
      }),
    () => ({ provider: context.provider ?? null, model: context.model ?? null }),
  )
  return { text, provider: context.provider, model: context.model }
}

function mapValidatedToExamItems(
  validated: readonly GeneratedComprehensiveExamQuestion[],
  previousTexts: readonly string[],
): { items: ExamGenerationItem[]; rejected: ExamGenerationRejected[] } {
  const items: ExamGenerationItem[] = []
  const rejected: ExamGenerationRejected[] = []
  const seen = new Set(previousTexts.map((t) => normalizeArabic(t)))
  validated.forEach((q, index) => {
    const key = normalizeArabic(q.text)
    if (seen.has(key)) {
      rejected.push({ index, reason: 'DUPLICATE_OF_EXISTING_QUESTION' })
      return
    }
    const checked = validateComprehensiveQuestion({
      type: q.type,
      text: q.text,
      options: q.type === 'TF' ? ['صح', 'خطأ'] : q.options,
      correctAnswer: q.correct,
      correctAnswerIndexBase: 0,
      sourceEvidence: q.sourceEvidence,
    })
    if (!checked.ok) {
      rejected.push({ index, reason: checked.errors.join('؛ ') })
      return
    }
    seen.add(key)
    items.push({
      question: checked.question,
      sourceIndex: q.sourceIndex ?? '',
      sourceEvidence: q.sourceEvidence || checked.question.sourceEvidence || '',
    })
  })
  return { items, rejected }
}

// Generates MCQ/TF questions from already-selected source chunks. The
// evidence validator is the same gate the program-exam generation
// uses: every accepted question carries a verbatim span from one
// selected chunk, at most 3 questions per chunk. The requested count
// is clamped to what the evidence allows (chunks × 3) and reported.
export async function generateExamQuestionsFromChunks(
  args: {
    selected: readonly ExamSourceChunk[]
    requested: number
    prompt: string
    system?: string
    previousTexts?: readonly string[]
    batchId: string
    stickyScope: string
    detailSource: string
    deadlineMs?: number
  },
  deps: { completeJson?: CompleteJsonFn } = {},
): Promise<ExamGenerationResult> {
  const { selected } = args
  const requested = Math.max(1, Math.floor(args.requested || 1))
  const previousTexts = args.previousTexts || []
  const maxByEvidence = selected.length * MAX_QUESTIONS_PER_SOURCE_CHUNK
  const count = Math.min(requested, maxByEvidence)
  const system = args.system || 'أنت لجنة امتحانات عليا ترجع JSON صالحاً فقط دون أي نص إضافي أو تعليقات.'
  const deadlineMs = args.deadlineMs || Date.now() + 240_000
  let generationContext: { provider?: string; model?: string } = {}
  // The router's retry signal is the evidence validation itself: an
  // empty batch or a mostly-rejected batch throws VALIDATION_REJECTED
  // and the router tries another model. A short-but-nonempty batch is
  // NOT a failure here — the surviving questions are saved and the
  // shortfall is reported, so the admin can press again.
  const validate = (text: string, context?: { provider: string; model: string }) => {
    generationContext = context || {}
    validateGeneratedExamQuestionsAgainstSelectedChunks(text, selected, 'MIX_CORE', generationContext)
  }
  const complete: CompleteJsonFn =
    deps.completeJson ||
    (async (callArgs) =>
      defaultCompleteJsonWithStage({
        ...callArgs,
        batchId: args.batchId,
        stickyScope: args.stickyScope,
        detailSource: args.detailSource,
        deadlineMs,
      }))
  const { text: raw } = await complete({ system, prompt: args.prompt, validate })
  const validated = validateGeneratedExamQuestionsAgainstSelectedChunks(raw, selected, 'MIX_CORE', generationContext)
  const mapped = mapValidatedToExamItems(validated, previousTexts)
  // The evidence validator guarantees at least one accepted question;
  // the single gate can still reject all of them (e.g. a text shorter
  // than its 10-character floor). That is a wholly empty batch: fail
  // outright rather than saving nothing silently.
  if (!mapped.items.length) {
    throwComprehensiveExamInsufficientSource({
      availableChunks: selected.length,
      requestedQuestions: count,
      acceptedQuestions: 0,
    })
  }
  // The validator returns only the survivors, so the reasons for the
  // dropped drafts are rebuilt here from the same pure evidence check
  // it runs internally: evidence rejections carry their reason
  // (NOT_FOUND / BAD_INDEX / TOO_SHORT), shape rejections get a generic
  // reason, and mapping rejections keep theirs — all keyed by the raw
  // position in the model's array.
  const rawItems = parseRawQuestionItems(raw)
  const validatedTexts = new Set(validated.map((q) => normalizeArabic(q.text)))
  const rejected: ExamGenerationRejected[] = []
  const evidenceRejectedIndexes = new Set<number>()
  const knowledge = validateQuestionBatchAgainstKnowledge(
    rawItems.map((r) => ({
      sourceIndex: (r as any)?.sourceIndex ?? '',
      sourceEvidence: String((r as any)?.sourceEvidence ?? ''),
    })),
    selected,
  )
  for (const r of knowledge.rejected) {
    if (validatedTexts.has(normalizeArabic(String((rawItems[r.index] as any)?.text ?? '')))) continue
    evidenceRejectedIndexes.add(r.index)
    rejected.push({ index: r.index, reason: r.reason })
  }
  rawItems.forEach((_item, i) => {
    if (validatedTexts.has(normalizeArabic(String((_item as any)?.text ?? '')))) return
    if (evidenceRejectedIndexes.has(i)) return
    rejected.push({ index: i, reason: 'VALIDATION_REJECTED' })
  })
  for (const m of mapped.rejected) {
    const text = normalizeArabic(validated[m.index]?.text ?? '')
    const rawIndex = rawItems.findIndex((r) => normalizeArabic(String((r as any)?.text ?? '')) === text)
    rejected.push({ index: rawIndex >= 0 ? rawIndex : m.index, reason: m.reason })
  }
  rejected.sort((a, b) => a.index - b.index)
  const rejectedCount = Math.max(0, rawItems.length - validated.length) + mapped.rejected.length
  return {
    items: mapped.items,
    requested,
    accepted: mapped.items.length,
    rejected,
    rejectedCount,
    provider: generationContext.provider,
    model: generationContext.model,
  }
}
