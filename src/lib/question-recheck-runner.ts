import { db } from '@/lib/db'
import {
  claimNextRecheckTasks,
  completeRecheckTask,
  failRecheckTask,
  type RecheckRecommendation,
  type RecheckTaskRow,
} from '@/lib/question-recheck-queue'
import { prepareStageRun, type StageRouting } from '@/lib/ai-stage-runner'
import type { TextAiProvider } from '@/lib/text-ai'
import { verifyQuestionsWithCrossProvider, type VerifiableQuestion } from '@/lib/question-verifier'

// D3.2b: مشغّل إعادة التدقيق المحدود والمعزول. يطالب بمهام الطابور
// المعلّقة (بسقف عددي)، يعيد تدقيق كل سؤال تحت بروفايل REVIEW الحالي،
// ويكتب النتيجة توصيةً على المهمة فقط — لا يلمس حالة السؤال ولا
// ينشر ولا يعتمد شيئًا. فشل مهمة لا يقتل الدفعة.
// هوية المولّد تُسترجع من سجل D0 (أحدث صف توليد ناجح لنفس الكتاب/
// الوحدة)؛ غياب هوية موثوقة = فشل واضح GENERATOR_IDENTITY_UNKNOWN
// بدل أي حكم مخترع.

export interface RecheckQuestionRecord {
  id: string
  text: string
  type: string | null
  options: string | string[] | null
  correctAnswer: string | null
  modelAnswer: string | null
  sourceEvidence: string | null
  bookId: string | null
  unitId: string | null
}

interface RecheckRunnerDeps {
  claim(limit: number): Promise<RecheckTaskRow[]>
  complete(taskId: string, recommendation: RecheckRecommendation): Promise<void>
  fail(taskId: string, error: string): Promise<void>
  loadQuestion(id: string): Promise<RecheckQuestionRecord | null>
  findLatestGeneration(bookId: string, unitId: string | null): Promise<{ provider: string; model: string } | null>
  prepareReviewRouting(): Promise<StageRouting | null>
  verify(input: {
    question: VerifiableQuestion
    sourceText: string
    generatorProvider: string
    generatorModel: string
    routing: StageRouting | null
  }): Promise<VerifiableQuestion>
}

const defaultDeps: RecheckRunnerDeps = {
  claim: (limit) => claimNextRecheckTasks(limit),
  complete: (taskId, recommendation) => completeRecheckTask(taskId, recommendation),
  fail: (taskId, error) => failRecheckTask(taskId, error),
  async loadQuestion(id) {
    const row = await db.questionBankItem.findUnique({
      where: { id },
      select: {
        id: true, text: true, type: true, options: true, correctAnswer: true,
        modelAnswer: true, sourceEvidence: true, bookId: true, unitId: true,
      },
    })
    return row as RecheckQuestionRecord | null
  },
  async findLatestGeneration(bookId, unitId) {
    const row = await db.aiPipelineOperationLog.findFirst({
      where: {
        stage: 'GENERATION',
        success: true,
        bookId,
        ...(unitId ? { unitId } : {}),
        provider: { not: null },
        model: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { provider: true, model: true },
    })
    if (!row?.provider || !row?.model) return null
    return { provider: row.provider, model: row.model }
  },
  async prepareReviewRouting() {
    const plan = await prepareStageRun('REVIEW')
    return plan.routing
  },
  async verify(input) {
    const out = await verifyQuestionsWithCrossProvider({
      questions: [input.question],
      sources: [{ text: input.sourceText }],
      generatorProvider: input.generatorProvider as TextAiProvider,
      generatorModel: input.generatorModel,
      routing: input.routing,
    })
    return out[0]
  },
}

let deps: RecheckRunnerDeps = defaultDeps

export function __setRecheckRunnerDepsForTests(next: Partial<RecheckRunnerDeps> | null) {
  deps = next ? { ...defaultDeps, ...next } : defaultDeps
}

function parseOptions(options: string | string[] | null): string[] | null {
  if (Array.isArray(options)) return options
  if (!options) return null
  try {
    const parsed = JSON.parse(options) as unknown
    return Array.isArray(parsed) ? parsed.map(String) : null
  } catch {
    return null
  }
}

function toRecommendation(verified: VerifiableQuestion): RecheckRecommendation {
  const checkedAt = new Date().toISOString()
  if (verified.verificationPending) {
    return {
      valid: false,
      verifierProvider: null,
      verifierModel: null,
      reason: verified.verificationReason || 'VERIFICATION_PENDING',
      checkedAt,
    }
  }
  if (verified.verifierProvider) {
    return {
      valid: true,
      verifierProvider: verified.verifierProvider,
      verifierModel: verified.verifierModel ?? null,
      reason: verified.verifierReason || 'VERIFIED',
      checkedAt,
    }
  }
  return {
    valid: false,
    verifierProvider: null,
    verifierModel: null,
    reason: verified.verifierReason || 'VERIFIER_REJECTED',
    checkedAt,
  }
}

async function runOneTask(task: RecheckTaskRow): Promise<'done' | 'failed'> {
  const question = await deps.loadQuestion(task.questionId)
  if (!question) {
    await deps.fail(task.id, 'RECHECK_QUESTION_NOT_FOUND')
    return 'failed'
  }
  const sourceText = String(question.sourceEvidence || '').trim()
  if (!sourceText) {
    await deps.fail(task.id, 'RECHECK_SOURCE_EVIDENCE_MISSING')
    return 'failed'
  }
  const identity = question.bookId ? await deps.findLatestGeneration(question.bookId, question.unitId) : null
  if (!identity?.provider || !identity?.model) {
    await deps.fail(task.id, 'GENERATOR_IDENTITY_UNKNOWN')
    return 'failed'
  }
  const routing = await deps.prepareReviewRouting()
  const verified = await deps.verify({
    question: {
      type: question.type ?? undefined,
      text: question.text,
      options: parseOptions(question.options),
      correctAnswer: question.correctAnswer,
      modelAnswer: question.modelAnswer,
      sourceEvidence: question.sourceEvidence,
    },
    sourceText,
    generatorProvider: identity.provider,
    generatorModel: identity.model,
    routing,
  })
  await deps.complete(task.id, toRecommendation(verified))
  return 'done'
}

export async function runQuestionRecheckBatch(input: { limit?: number } = {}): Promise<{ claimed: number; done: number; failed: number }> {
  const limit = Math.max(1, Math.min(50, Math.floor(input.limit ?? 10) || 1))
  const tasks = await deps.claim(limit)
  let done = 0
  let failed = 0
  for (const task of tasks) {
    try {
      const outcome = await runOneTask(task)
      if (outcome === 'done') done++
      else failed++
    } catch (err) {
      failed++
      try {
        await deps.fail(task.id, err instanceof Error ? err.message : String(err))
      } catch {
        // حتى فشل تسجيل الفشل لا يقتل بقية الدفعة
      }
    }
  }
  return { claimed: tasks.length, done, failed }
}
