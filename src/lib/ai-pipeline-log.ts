import { createHash } from 'node:crypto'
import { db } from '@/lib/db'
import { pipelineConfigSnapshot } from '@/lib/text-ai'

// D0 — تسجيل تشغيلات خط الكتاب→الأسئلة (قراءة/تحليل/توليد/تدقيق) فقط.
// قواعد صارمة:
// - التسجيل لا يغيّر أي سلوك: لا يرمي أبدًا، ولا يعدّل مدخلات أو مخرجات.
// - كل صف يختم بنسخة الإعدادات الفعلية (profileVersion) التي نُفّذت
//   التشغيلة تحتها، حتى يُفسَّر لاحقًا أي سؤال: تحت أي إعدادات تولّد؟
// - قبل D1 لا توجد بروفايلات مراحل؛ profileId = 'global' والنسخة هي
//   بصمة إعدادات الراوتر الفعلية (السياسة + قائمة الأكاديمي + مفضّلات
//   المدقق). أي تغيير إعدادات ينتج نسخة مختلفة تلقائيًا.

export type PipelineStageName = 'READING' | 'ANALYSIS' | 'GENERATION' | 'REVIEW'

export interface PipelineProfileStamp {
  profileId: string
  profileVersion: string
  policy?: string | null
  allowedModels?: string[]
}

export interface PipelineRunContext {
  stage: PipelineStageName
  // عند توصيل مرحلة ببروفايلها (D2+) يُختم الصف بهوية البروفايل الفعلي
  // بدل ختم الإعداد العام.
  profileStamp?: PipelineProfileStamp
  bookId?: string | null
  batchId?: string | null
  unitId?: string | null
  provider?: string | null
  model?: string | null
  inputText?: string | null
  inputData?: string | Buffer | null
  promptText?: string | null
  promptVersion?: string | null
  fallbackUsed?: boolean
  detail?: Record<string, unknown> | null
  // D2.1c: حالة حية يملكها المستدعي ويحدّثها أثناء التشغيل؛ تُقرأ وقت
  // التسجيل على مساري النجاح والفشل معًا، حتى يظهر قرار محاولة الرجوع
  // للعام في الصف حتى لو فشلت محاولة الرجوع نفسها.
  liveState?: { fallbackUsed?: boolean; fallbackReason?: string }
}

export interface PipelineRunOutcome {
  provider?: string | null
  model?: string | null
  outputId?: string | null
  outputCount?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  costCents?: number | null
  fallbackUsed?: boolean
  detail?: Record<string, unknown> | null
}

interface PipelineLogRow {
  stage: PipelineStageName
  profileId: string
  profileVersion: string
  provider: string | null
  model: string | null
  policy: string | null
  allowedModelsSnapshot: { allowedModels: string[]; verifierPreferred: string[] } | null
  bookId: string | null
  batchId: string | null
  unitId: string | null
  promptVersion: string | null
  promptHash: string | null
  inputHash: string
  outputId: string | null
  outputCount: number | null
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  costCents: number | null
  success: boolean
  failureCategory: string | null
  fallbackUsed: boolean
  detail: Record<string, unknown> | null
}

type PipelineLogWriter = (row: PipelineLogRow) => Promise<void>
type PipelineSnapshotProvider = () => Promise<{ policy: string; allowedModels: string[]; verifierPreferred: string[] }>

const defaultWriter: PipelineLogWriter = async (row) => {
  await db.aiPipelineOperationLog.create({ data: row as never })
}

let writer: PipelineLogWriter = defaultWriter
let snapshotProvider: PipelineSnapshotProvider = pipelineConfigSnapshot

export function __setPipelineLogDepsForTests(deps: { writer?: PipelineLogWriter; snapshot?: PipelineSnapshotProvider } | null) {
  writer = deps?.writer ?? defaultWriter
  snapshotProvider = deps?.snapshot ?? pipelineConfigSnapshot
}

export function hashPipelineData(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

export function classifyPipelineFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/deadline|timeout|timed out|time_budget|TIME_BUDGET/i.test(message)) return 'TIMEOUT'
  if (/rate.?limit|429|quota|too many requests/i.test(message)) return 'RATE_LIMIT'
  if (/empty|no[ _]candidates|no[ _]fresh|EMPTY_/i.test(message)) return 'EMPTY_OUTPUT'
  if (/valid|parse|json|schema|zod/i.test(message)) return 'VALIDATION'
  if (/router|provider|TEXT_AI|GEMINI|fetch failed|network|ECONN|socket/i.test(message)) return 'PROVIDER_ERROR'
  return 'UNKNOWN'
}

async function currentProfileStamp(): Promise<{ profileVersion: string; policy: string | null; snapshot: PipelineLogRow['allowedModelsSnapshot'] }> {
  try {
    const snap = await snapshotProvider()
    const snapshot = { allowedModels: [...snap.allowedModels], verifierPreferred: [...snap.verifierPreferred] }
    return {
      profileVersion: hashPipelineData(JSON.stringify({ policy: snap.policy, ...snapshot })),
      policy: snap.policy,
      snapshot,
    }
  } catch {
    return { profileVersion: 'unknown', policy: null, snapshot: null }
  }
}

export async function recordPipelineOperation(
  ctx: PipelineRunContext & { latencyMs: number; success: boolean; failureCategory?: string | null; outcome?: PipelineRunOutcome },
): Promise<void> {
  try {
    const outcome = ctx.outcome ?? {}
    const detail = { ...(ctx.detail ?? {}), ...(outcome.detail ?? {}) }
    if (ctx.liveState?.fallbackReason && detail.fallbackReason === undefined) detail.fallbackReason = ctx.liveState.fallbackReason
    // ختم البروفايل الفعلي إن وُجد (D2+)، وإلا ختم الإعداد العام الحي.
    const stamp = ctx.profileStamp
      ? {
          profileId: ctx.profileStamp.profileId,
          profileVersion: ctx.profileStamp.profileVersion,
          policy: ctx.profileStamp.policy ?? null,
          snapshot: ctx.profileStamp.allowedModels
            ? { allowedModels: ctx.profileStamp.allowedModels, verifierPreferred: [] as string[] }
            : null,
        }
      : { profileId: 'global', ...(await currentProfileStamp()) }
    const row: PipelineLogRow = {
      stage: ctx.stage,
      profileId: stamp.profileId,
      profileVersion: stamp.profileVersion,
      provider: outcome.provider ?? ctx.provider ?? null,
      model: outcome.model ?? ctx.model ?? null,
      policy: stamp.policy,
      allowedModelsSnapshot: stamp.snapshot,
      bookId: ctx.bookId ?? null,
      batchId: ctx.batchId ?? null,
      unitId: ctx.unitId ?? null,
      promptVersion: ctx.promptVersion ?? null,
      promptHash: ctx.promptText ? hashPipelineData(ctx.promptText) : null,
      inputHash: hashPipelineData(ctx.inputData ?? ctx.inputText ?? ''),
      outputId: outcome.outputId ?? null,
      outputCount: outcome.outputCount ?? null,
      latencyMs: Math.max(0, Math.round(ctx.latencyMs)),
      inputTokens: outcome.inputTokens ?? null,
      outputTokens: outcome.outputTokens ?? null,
      costCents: outcome.costCents ?? null,
      success: ctx.success,
      failureCategory: ctx.success ? null : (ctx.failureCategory ?? 'UNKNOWN'),
      fallbackUsed: outcome.fallbackUsed ?? ctx.liveState?.fallbackUsed ?? ctx.fallbackUsed ?? false,
      detail: Object.keys(detail).length ? detail : null,
    }
    await writer(row)
  } catch {
    // التسجيل لا يكسر التشغيل أبدًا: أي فشل هنا يُبتلع بصمت.
  }
}

// يغلّف تشغيلة مرحلة: يقيس زمنها ويسجل نتيجتها، ويعيد رمي الخطأ كما هو
// إن فشلت — المخرجات والقرارات لا تتغير إطلاقًا.
export async function withPipelineRun<T>(
  ctx: PipelineRunContext,
  fn: () => Promise<T>,
  mapOutcome?: (result: T) => PipelineRunOutcome,
): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await fn()
    await recordPipelineOperation({ ...ctx, latencyMs: Date.now() - startedAt, success: true, outcome: mapOutcome?.(result) })
    return result
  } catch (error) {
    await recordPipelineOperation({
      ...ctx,
      latencyMs: Date.now() - startedAt,
      success: false,
      failureCategory: classifyPipelineFailure(error),
    })
    throw error
  }
}
