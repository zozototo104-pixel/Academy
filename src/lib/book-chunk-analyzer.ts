import { geminiCompleteJson } from '@/lib/gemini'
import { hashPipelineData, withPipelineRun } from '@/lib/ai-pipeline-log'
import { buildStageRoutingOverrides, resolveEffectiveStageProfile, type StageRoutingOverrides } from '@/lib/ai-stage-profiles'
import { pipelineConfigSnapshot, type TextAiPreferredModel, type TextAiProvider, type TextAiRouterPolicy } from '@/lib/text-ai'
import { db } from '@/lib/db'
import { normalizeArabic } from '@/lib/arabic-normalize'
import { textContainsEvidenceAfterNormalization } from '@/lib/text-provenance'
import { formatNumberedBookLines, resolveBookLineEvidence } from '@/lib/book-line-evidence'
import { assertBookReadLease, preserveBookPageReadIssues } from '@/lib/book-read-job-control'
import { looksLikeBrokenBookPageText } from '@/lib/academic-output-quality'

// Pure saturation decision, shared by the commit-time save below and its
// tests: a chunk saturates only when the JOB target is reached (capacity or
// available exhausted, or rows + newly accepted reach the target). A chunk
// at the base target (10) under an extra-target job (20) does NOT saturate.
export function enrichChunkSaturates(args: { capacity: number; available: number; rowsBefore: number; accepted: number; target: number }): boolean {
  return args.capacity === 0 || args.available === 0 || args.rowsBefore + args.accepted >= args.target
}

// Two-level enrichment: the base pass ends at 10 items per chunk; the optional
// extra pass continues the SAME items to 20. 10 is NOT final saturation —
// final saturation is at 20. A chunk saturates honestly at its real count when
// the model finds nothing new (the existing pass/duplicate logic stays the
// authority on "no more items"). Only 10 and 20 are legal targets; anything
// else (including NULL from old jobs) resolves to the base 10.
export const BOOK_ENRICH_BASE_TARGET = 10
export const BOOK_ENRICH_EXTRA_TARGET = 20
export function resolveEnrichmentTarget(enrichmentTarget: number | null | undefined): number {
  return enrichmentTarget === BOOK_ENRICH_EXTRA_TARGET ? BOOK_ENRICH_EXTRA_TARGET : BOOK_ENRICH_BASE_TARGET
}

export const BOOK_KNOWLEDGE_CATEGORIES = ['CONCEPT', 'DEFINITION', 'THEORY', 'METHOD', 'CASE', 'PRINCIPLE', 'FACT'] as const
export type BookKnowledgeCandidate = { category: typeof BOOK_KNOWLEDGE_CATEGORIES[number]; title: string; summary: string; excerpt: string; importance: number; sourceLineRangeVerified?: true }

const stopWords = new Set(['في', 'من', 'على', 'عن', 'الى', 'إلى', 'هذا', 'هذه', 'هو', 'هي', 'ان', 'أن', 'و', 'او', 'أو', 'مع', 'التي', 'الذي'])
export function conceptTokens(value: string): Set<string> {
  return new Set(String(normalizeArabic(value)).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((word) => word.length > 1 && !stopWords.has(word)))
}
export function isRepeatedBookConcept(candidate: Pick<BookKnowledgeCandidate, 'title' | 'summary'>, prior: readonly Pick<BookKnowledgeCandidate, 'title' | 'summary'>[]): boolean {
  const a = conceptTokens(`${candidate.title} ${candidate.summary}`)
  if (!a.size) return false
  return prior.some((item) => {
    const b = conceptTokens(`${item.title} ${item.summary}`)
    let intersection = 0
    for (const word of a) if (b.has(word)) intersection++
    return b.size > 0 && intersection / (a.size + b.size - intersection) >= 0.75
  })
}
export function validateBookKnowledgeCandidate(raw: unknown, chunkText: string, options: { fromVerifiedLineRange?: boolean } = {}): BookKnowledgeCandidate | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const category = String(item.category || '')
  const title = String(item.title || '').trim()
  const summary = String(item.summary || '').trim()
  const excerpt = String(item.excerpt || '').trim()
  const importance = Number(item.importance)
  if (!BOOK_KNOWLEDGE_CATEGORIES.includes(category as BookKnowledgeCandidate['category'])) return null
  if (!title || !summary || excerpt.length < 60 || (!options.fromVerifiedLineRange && excerpt.length > 600)) return null
  if (/[؟?]\s*$/.test(excerpt) || /^(?:ما|ماذا|كيف|لماذا|هل|أين|متى)\s/.test(excerpt)) return null
  if (!textContainsEvidenceAfterNormalization(chunkText, excerpt)) return null
  if (!Number.isFinite(importance) || importance < 0 || importance > 100) return null
  return { category: category as BookKnowledgeCandidate['category'], title, summary, excerpt, importance: Math.round(importance) }
}

// A model chooses 1-based source line numbers; only the server constructs
// and stores the resulting literal quote. Legacy exact-quote output is retained.
export type BookLineCandidateResult =
  | { candidate: BookKnowledgeCandidate; reason: null }
  | { candidate: null; reason: 'INVALID_LINE_RANGE' | 'EVIDENCE_TOO_SHORT' | 'EXCERPT_OR_FIELDS' }

export function resolveBookKnowledgeCandidateFromLines(raw: unknown, chunkText: string): BookLineCandidateResult {
  if (!raw || typeof raw !== 'object') return { candidate: null, reason: 'EXCERPT_OR_FIELDS' }
  const item = raw as Record<string, unknown>
  const first = item.lineStart ?? item.startLine ?? item.line_start
  const last = item.lineEnd ?? item.endLine ?? item.line_end
  if (first === undefined && last === undefined) {
    if (typeof item.excerpt !== 'string' || !item.excerpt.trim()) return { candidate: null, reason: 'INVALID_LINE_RANGE' }
    const candidate = validateBookKnowledgeCandidate(raw, chunkText)
    return candidate ? { candidate, reason: null } : { candidate: null, reason: 'EXCERPT_OR_FIELDS' }
  }
  const evidence = resolveBookLineEvidence(chunkText, first, last)
  if (!evidence.ok) return { candidate: null, reason: evidence.reason }
  const candidate = validateBookKnowledgeCandidate(
    { ...item, excerpt: evidence.excerpt }, chunkText, { fromVerifiedLineRange: true },
  )
  return candidate ? { candidate: { ...candidate, sourceLineRangeVerified: true }, reason: null } : { candidate: null, reason: 'EXCERPT_OR_FIELDS' }
}

// A response with no source-backed new knowledge is a model-validation failure,
// so the configured router can try the next model instead of saving zero items.
// The suffix records WHY nothing verified: NO_ITEMS (the model found nothing)
// and ALL_DUPLICATE (it found only already-known knowledge) both mean the
// chunk is exhausted, while NO_VERIFIED_ITEMS means every item failed
// validation and the models — not the chunk — are at fault.
export function validateSourceBackedBookBatch(
  raw: string, chunkText: string, prior: readonly Pick<BookKnowledgeCandidate, 'title' | 'summary'>[],
): void {
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed?.items)) throw new Error('INVALID_BOOK_KNOWLEDGE_ENVELOPE')
  if (chunkText.trim().length < 60) return
  if (parsed.items.length === 0) {
    throw Object.assign(new Error('EMPTY_BATCH_AFTER_STRUCTURAL_VALIDATION:BOOK_KNOWLEDGE_NO_ITEMS'), { code: 'VALIDATION_REJECTED' })
  }
  let sawInvalid = false
  const hasVerifiedNovelItem = parsed.items.some((item: unknown) => {
    const candidate = resolveBookKnowledgeCandidateFromLines(item, chunkText).candidate
    if (!candidate) { sawInvalid = true; return false }
    return !isRepeatedBookConcept(candidate, prior)
  })
  if (!hasVerifiedNovelItem) {
    const suffix = sawInvalid ? 'BOOK_KNOWLEDGE_NO_VERIFIED_ITEMS' : 'BOOK_KNOWLEDGE_ALL_DUPLICATE'
    throw Object.assign(new Error(`EMPTY_BATCH_AFTER_STRUCTURAL_VALIDATION:${suffix}`), { code: 'VALIDATION_REJECTED' })
  }
}

// Exhausted-chunk markers: every model tried agreed the chunk holds no NEW
// source-backed knowledge (an empty list, or only already-known items). Any
// other attempt error (rate limit, timeout, invalid output, …) means the
// models failed, not the chunk, and must keep the existing defer/fail path.
// The router joins per-model errors with ' | '; the enrich wrapper nests
// those lists inside STAGE=[...] / GLOBAL=[...] (or ROUTER=[...] /
// NATIVE=[...]), so the seams between the lists are flattened into the same
// separator first. A message without every attempt marked exhausted
// defaults to NOT exhausted.
const EXHAUSTED_BOOK_BATCH_MARKERS = ['BOOK_KNOWLEDGE_NO_ITEMS', 'BOOK_KNOWLEDGE_ALL_DUPLICATE'] as const
export function isExhaustedBookBatchError(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '')
  if (!message.includes('EMPTY_BATCH_AFTER_STRUCTURAL_VALIDATION')) return false
  const flattened = message.replace(/\]\s*(STAGE|GLOBAL|ROUTER|NATIVE)=\[/g, ' | ')
  const attempts = flattened.split(' | ').map((part) => part.trim()).filter(Boolean)
  if (!attempts.length) return false
  return attempts.every((attempt) => EXHAUSTED_BOOK_BATCH_MARKERS.some((marker) => attempt.includes(marker)))
}

// D2.2: توصيل التحليل — نفس النمط الصارم للقراءة (D2.1b/D2.1c).
// بروفايل التحليل الفعّال يقيد النداء بقائمته (الراوتر عبر
// restrictToModels، والسلسلة الأصلية عبر ترشيح gemini.ts)، وفشل الكل
// يرجع للعام مرة واحدة فقط إن سمح البروفايل، مع وسم قرار الرجوع لحظته.
type AnalysisRouting = { preferredModels: { provider: string; model: string }[]; preferredProviders: string[]; policy: string | null; allowGlobalFallback: boolean } | null
interface AnalysisUsage { provider: string | null; model: string | null; fallbackUsed: boolean; fallbackReason?: string }

type AnalysisCallOpts = Parameters<typeof geminiCompleteJson>[0]

function withUsageCapture(opts: AnalysisCallOpts, usage: AnalysisUsage): AnalysisCallOpts {
  return {
    ...opts,
    validate: (text, ctx) => {
      if (ctx?.provider) { usage.provider = ctx.provider; usage.model = ctx.model ?? usage.model }
      opts.validate?.(text, ctx)
    },
  }
}

function withStageRouting(opts: AnalysisCallOpts, routing: NonNullable<AnalysisRouting>): AnalysisCallOpts {
  const models = routing.preferredModels.map((m) => ({ provider: m.provider as TextAiPreferredModel['provider'], model: m.model }))
  return {
    ...opts,
    preferredModels: models,
    restrictToModels: models,
    ...(routing.preferredProviders.length ? { preferredProviders: routing.preferredProviders as TextAiProvider[] } : {}),
    ...(routing.policy ? { routerPolicy: routing.policy as TextAiRouterPolicy } : {}),
  }
}

export function preferSuccessfulBookAnalysisModel<T extends { provider: string; model: string }>(
  models: readonly T[], favorite: { provider: string; model: string } | null,
): T[] {
  if (!favorite) return [...models]
  const index = models.findIndex((item) => item.provider === favorite.provider && item.model === favorite.model)
  if (index <= 0) return [...models]
  return [models[index], ...models.filter((_, i) => i !== index)]
}

async function callAnalysisAi(
  baseOpts: AnalysisCallOpts, routing: AnalysisRouting, usage: AnalysisUsage,
  favorite: TextAiPreferredModel | null = null,
): Promise<string> {
  if (!routing) {
    const opts = favorite
      ? { ...baseOpts, preferredModels: [favorite], preferredProviders: [favorite.provider] }
      : baseOpts
    return geminiCompleteJson(withUsageCapture(opts, usage))
  }
  const eligible = favorite && routing.preferredModels.some((m) => m.provider === favorite.provider && m.model === favorite.model)
  const favoredRouting = eligible && favorite
    ? {
        ...routing,
        preferredModels: preferSuccessfulBookAnalysisModel(routing.preferredModels, favorite),
        preferredProviders: [favorite.provider, ...routing.preferredProviders.filter((p) => p !== favorite.provider)],
      }
    : routing
  try {
    return await geminiCompleteJson(withStageRouting(withUsageCapture(baseOpts, usage), favoredRouting))
  } catch (error) {
    if (!routing.allowGlobalFallback) throw error
    usage.fallbackUsed = true
    usage.fallbackReason = 'all-stage-models-failed'
    try {
      return await geminiCompleteJson(withUsageCapture(baseOpts, usage))
    } catch (fallbackError) {
      if (baseOpts.taskType !== 'BOOK_ENRICH') throw fallbackError
      const summary = (value: unknown) => String((value as Error)?.message || value || 'unknown')
        .replace(/(?:sk-|AIza)[A-Za-z0-9_\-]{8,}/g, '[REDACTED]')
        .slice(0, 2200)
      throw new Error(`BOOK_AI_PROVIDER_EXHAUSTED: STAGE=[${summary(error)}] GLOBAL=[${summary(fallbackError)}]`)
    }
  }
}

// When every model tried agreed the chunk holds no new source-backed
// knowledge, the AI call resolves to an empty batch instead of a provider
// failure, so the chunk counts as zero accepted (saved in analysis, one
// pass counted in enrich) instead of failing or deferring forever. Any
// mixed or real provider error still throws and keeps its old path.
export async function callAnalysisAiWithExhaustedAsEmpty(
  baseOpts: AnalysisCallOpts, routing: AnalysisRouting, usage: AnalysisUsage,
  favorite: TextAiPreferredModel | null = null,
): Promise<string> {
  try {
    return await callAnalysisAi(baseOpts, routing, usage, favorite)
  } catch (error) {
    if (isExhaustedBookBatchError(error)) return JSON.stringify({ items: [] })
    throw error
  }
}

async function prepareAnalysisRun(): Promise<{ routing: AnalysisRouting; profileStamp?: { profileId: string; profileVersion: string; policy: string | null; allowedModels: string[] }; isStage: boolean; detail: Record<string, unknown> }> {
  let overrides: StageRoutingOverrides | { kind: 'resolution-error' }
  try {
    overrides = buildStageRoutingOverrides(await resolveEffectiveStageProfile('ANALYSIS'))
  } catch {
    overrides = { kind: 'resolution-error' }
  }
  const detail: Record<string, unknown> = { profileKind: overrides.kind }
  if (overrides.kind === 'global') detail.fallbackReason = overrides.reason
  if (overrides.kind === 'invalid') { detail.profileInvalid = true; detail.invalidReason = overrides.reason }
  if (overrides.kind !== 'stage') return { routing: null, isStage: false, detail }
  return {
    routing: { preferredModels: overrides.preferredModels, preferredProviders: overrides.preferredProviders, policy: overrides.policy, allowGlobalFallback: overrides.allowGlobalFallback },
    profileStamp: { profileId: overrides.profileId, profileVersion: String(overrides.version), policy: overrides.policy, allowedModels: overrides.preferredModels.map((m) => `${m.provider}:${m.model}`) },
    isStage: true,
    detail,
  }
}

// Keep the successful model only within the same book-read job and the same
// effective profile version. Operation logs already survive separate workers;
// missing telemetry must never block analysis or alter configured fallbacks.
async function lastSuccessfulBookTaskModel(
  jobId: string | undefined, bookId: string, run: Awaited<ReturnType<typeof prepareAnalysisRun>>,
): Promise<TextAiPreferredModel | null> {
  if (!jobId) return null
  try {
    const stamp = run.profileStamp ?? await (async () => {
      const snapshot = await pipelineConfigSnapshot()
      return { profileId: 'global', profileVersion: hashPipelineData(JSON.stringify(snapshot)) }
    })()
    const last = await db.aiPipelineOperationLog.findFirst({
      where: {
        stage: 'ANALYSIS', batchId: jobId, bookId, success: true,
        outputCount: { gt: 0 }, profileId: stamp.profileId, profileVersion: stamp.profileVersion,
        provider: { not: null }, model: { not: null },
      },
      orderBy: { createdAt: 'desc' },
      select: { provider: true, model: true },
    })
    if (!last?.provider || !last.model) return null
    if (run.routing && !run.routing.preferredModels.some((m) => m.provider === last.provider && m.model === last.model)) return null
    return { provider: last.provider as TextAiPreferredModel['provider'], model: last.model }
  } catch {
    // Performance hint only: data/telemetry outages preserve normal routing.
    return null
  }
}

async function analyzeBookChunkInner(input: { bookId: string; jobId?: string; chunkText: string; deadlineMs: number; prior: readonly Pick<BookKnowledgeCandidate, 'title' | 'summary'>[]; routing?: AnalysisRouting; aiUsage?: AnalysisUsage; favorite?: TextAiPreferredModel | null }): Promise<BookKnowledgeCandidate[]> {
  const remaining = input.deadlineMs - Date.now()
  if (remaining < 25_000) throw new Error('BOOK_READ_TIME_BUDGET_EXHAUSTED')
  const numberedLines = formatNumberedBookLines(input.chunkText)
  const result = await callAnalysisAiWithExhaustedAsEmpty({
    system: 'أنت محلل كتب أكاديمية. استخرج المعرفة من النص الحرفي فقط. أرجع JSON فقط.',
    history: [{ role: 'user', text: `الأسطر التالية مرقمة من نص الكتاب الأصلي. استخرج 3 إلى 12 عنصراً بحسب كثافة النص، مع عنوان وملخص يؤيدهما مدى من 1 إلى 6 أسطر متتابعة. اختر lineStart وlineEnd كرقمين صحيحين من أرقام الأسطر؛ يمكن أن يكونا متساويين، والسطر الطويل مقبول كما هو. يجب أن يكون الاقتباس المختار 60 حرفاً على الأقل. الخادم يأخذ النص الحرفي من تلك الأسطر فلا تُرسل excerpt ولا تعيد صياغة الدليل. لا تخترع معلومات ولا تنشئ QUESTION_SEED ولا تختار سؤالاً بديلاً عن شرح. الأصناف: CONCEPT, DEFINITION, THEORY, METHOD, CASE, PRINCIPLE, FACT. لكل عنصر category,title,summary,lineStart,lineEnd,importance (رقم 0-100). أرجع JSON على شكل {"items":[...]}. أسطر المصدر:\n${numberedLines}` }],
    taskLevel: 'ACADEMIC_DRAFT',
    stickyScope: input.jobId ? `BOOK_READ_TASK:${input.jobId}` : `BOOK_READ:${input.bookId}`,
    deadlineMs: Math.min(input.deadlineMs, Date.now() + Math.min(120_000, remaining - 10_000)),
    temperature: 0.2, timeoutMs: 35_000,
    validate: (raw) => validateSourceBackedBookBatch(raw, input.chunkText, input.prior),
  }, input.routing ?? null, input.aiUsage ?? { provider: null, model: null, fallbackUsed: false }, input.favorite ?? null)
  const parsed = JSON.parse(result)
  const accepted: BookKnowledgeCandidate[] = []
  const rejected = { category: 0, invalidLineRange: 0, shortEvidence: 0, excerptOrFields: 0, duplicate: 0 }
  let candidates = 0
  for (const raw of parsed.items || []) {
    candidates++
    if (!raw || typeof raw !== 'object' || !BOOK_KNOWLEDGE_CATEGORIES.includes(String((raw as Record<string, unknown>).category) as BookKnowledgeCandidate['category'])) { rejected.category++; continue }
    const resolved = resolveBookKnowledgeCandidateFromLines(raw, input.chunkText)
    if (!resolved.candidate) {
      if (resolved.reason === 'INVALID_LINE_RANGE') rejected.invalidLineRange++
      else if (resolved.reason === 'EVIDENCE_TOO_SHORT') rejected.shortEvidence++
      else rejected.excerptOrFields++
      continue
    }
    if (isRepeatedBookConcept(resolved.candidate, [...input.prior, ...accepted])) { rejected.duplicate++; continue }
    accepted.push(resolved.candidate)
    if (accepted.length === 12) break
  }
  console.info('[book-analysis] model-validation', { bookId: input.bookId, candidates, accepted: accepted.length, rejected })
  return accepted
}

async function enrichBookChunkInner(input: { bookId: string; jobId?: string; chunkText: string; deadlineMs: number; existing: readonly Pick<BookKnowledgeCandidate, 'title' | 'summary'>[]; routing?: AnalysisRouting; aiUsage?: AnalysisUsage; favorite?: TextAiPreferredModel | null }): Promise<BookKnowledgeCandidate[]> {
  const remaining = input.deadlineMs - Date.now()
  if (remaining < 25_000) throw new Error('BOOK_READ_TIME_BUDGET_EXHAUSTED')
  const numberedLines = formatNumberedBookLines(input.chunkText)
  const result = await callAnalysisAiWithExhaustedAsEmpty({
    system: 'أنت محلل كتب أكاديمية. استخرج معرفة جديدة من النص الحرفي فقط. أرجع JSON فقط.',
    history: [{ role: 'user', text: `استخرج حتى 8 عناصر جديدة غير موجودة في القائمة، اعتماداً على أسطر المصدر المرقمة أدناه حصراً. لكل عنصر حدّد lineStart وlineEnd كرقمين صحيحين لنطاق متصل من 1 إلى 6 أسطر يدعم عنوانه وملخصه، بطول 60 حرفاً على الأقل. السطر الطويل مقبول كما هو. الخادم ينسخ الاقتباس الأصلي من الأسطر، لذلك لا تكتب excerpt ولا تخترع معلومات أو أسئلة. الأصناف: CONCEPT, DEFINITION, THEORY, METHOD, CASE, PRINCIPLE, FACT. الحقول: category,title,summary,lineStart,lineEnd,importance (رقم 0-100). أرجع JSON على شكل {"items":[...]}. العناصر الموجودة:\n${input.existing.map((item) => `${item.title}: ${item.summary}`).join('\n')}\nأسطر المصدر:\n${numberedLines}` }],
    taskLevel: 'ACADEMIC_DRAFT', taskType: 'BOOK_ENRICH', maxOutputTokens: 8192,
    stickyScope: input.jobId ? `BOOK_READ_TASK:${input.jobId}` : `BOOK_READ:${input.bookId}`, deadlineMs: Math.min(input.deadlineMs, Date.now() + Math.min(120_000, remaining - 10_000)), temperature: 0.2, timeoutMs: 35_000,
    validate: (raw) => validateSourceBackedBookBatch(raw, input.chunkText, input.existing),
  }, input.routing ?? null, input.aiUsage ?? { provider: null, model: null, fallbackUsed: false }, input.favorite ?? null)
  const accepted: BookKnowledgeCandidate[] = []
  const rejected = { category: 0, invalidLineRange: 0, shortEvidence: 0, excerptOrFields: 0, duplicate: 0 }
  let candidates = 0
  for (const raw of JSON.parse(result).items) {
    candidates++
    if (!raw || typeof raw !== 'object' || !BOOK_KNOWLEDGE_CATEGORIES.includes(String((raw as Record<string, unknown>).category) as BookKnowledgeCandidate['category'])) { rejected.category++; continue }
    const resolved = resolveBookKnowledgeCandidateFromLines(raw, input.chunkText)
    if (!resolved.candidate) {
      if (resolved.reason === 'INVALID_LINE_RANGE') rejected.invalidLineRange++
      else if (resolved.reason === 'EVIDENCE_TOO_SHORT') rejected.shortEvidence++
      else rejected.excerptOrFields++
      continue
    }
    if (isRepeatedBookConcept(resolved.candidate, [...input.existing, ...accepted])) { rejected.duplicate++; continue }
    accepted.push(resolved.candidate)
    if (accepted.length >= 8) break
  }
  console.info('[book-enrich] model-validation', { bookId: input.bookId, candidates, accepted: accepted.length, rejected })
  return accepted
}

export type EnrichStepStore = {
  getJob: (id: string) => Promise<{ id: string; bookId: string; phase: string; enrichmentTarget?: number | null } | null>
  nextChunk: (bookId: string) => Promise<{ id: string; bookId: string; programId: string; index: number; text: string; pageStart: number; pageEnd: number; textProvenance: string; analysisPasses: number } | null>
  // Failed providers are deferred per chunk, not treated as successful analysis.
  defer?: (chunkId: string, reason: string) => Promise<void>
  existing: (bookId: string, chunkId: string, index: number) => Promise<{ local: Pick<BookKnowledgeCandidate, 'title' | 'summary'>[]; own: Pick<BookKnowledgeCandidate, 'title' | 'summary'>[] }>
  save: (chunk: { id: string; bookId: string; programId: string; pageStart: number; pageEnd: number; textProvenance: string }, items: BookKnowledgeCandidate[], capacity?: number, target?: number) => Promise<void>
  finish: (jobId: string) => Promise<void>
}

// D0+D2.2: تحليل/إثراء كل مقطع يُسجَّل كتشغيلة تحليل تحت بروفايل
// التحليل الفعّال إن وُجد (ختم + حصر صارم)، وإلا بالإعداد العام كما
// كان قبل D2.2 بالضبط. المزوّد/الموديل الحقيقيان يُلتقطان عبر خطاف
// التحقق الذي يمرره geminiCompleteJson على مساريه كليهما.
export async function analyzeBookChunk(input: Parameters<typeof analyzeBookChunkInner>[0]): ReturnType<typeof analyzeBookChunkInner> {
  const run = await prepareAnalysisRun()
  const favorite = await lastSuccessfulBookTaskModel(input.jobId, input.bookId, run)
  const usage: AnalysisUsage = { provider: null, model: null, fallbackUsed: false }
  return withPipelineRun(
    { stage: 'ANALYSIS', bookId: input.bookId, batchId: input.jobId, inputText: input.chunkText, profileStamp: run.profileStamp, fallbackUsed: !run.isStage, liveState: usage, detail: run.detail },
    () => analyzeBookChunkInner({ ...input, routing: run.routing, aiUsage: usage, favorite }),
    (r) => ({ provider: usage.provider, model: usage.model, outputCount: r.length, fallbackUsed: usage.fallbackUsed || undefined }),
  )
}

export async function enrichBookChunk(input: Parameters<typeof enrichBookChunkInner>[0]): ReturnType<typeof enrichBookChunkInner> {
  const run = await prepareAnalysisRun()
  const favorite = await lastSuccessfulBookTaskModel(input.jobId, input.bookId, run)
  const usage: AnalysisUsage = { provider: null, model: null, fallbackUsed: false }
  return withPipelineRun(
    { stage: 'ANALYSIS', bookId: input.bookId, batchId: input.jobId, inputText: input.chunkText, profileStamp: run.profileStamp, fallbackUsed: !run.isStage, liveState: usage, detail: { ...run.detail, enrich: true } },
    () => enrichBookChunkInner({ ...input, routing: run.routing, aiUsage: usage, favorite }),
    (r) => ({ provider: usage.provider, model: usage.model, outputCount: r.length, fallbackUsed: usage.fallbackUsed || undefined }),
  )
}

export async function enrichStepWithStore(jobId: string, deadlineMs: number, store: EnrichStepStore, analyze: typeof enrichBookChunk = enrichBookChunk) {
  const job = await store.getJob(jobId)
  if (!job) throw new Error('BOOK_READ_JOB_NOT_FOUND')
  if (job.phase !== 'ENRICH') return { completed: job.phase === 'DONE', added: 0 }
  const target = resolveEnrichmentTarget(job.enrichmentTarget)
  const chunk = await store.nextChunk(job.bookId)
  if (!chunk) { await store.finish(jobId); return { completed: true, added: 0 } }
  const existing = await store.existing(job.bookId, chunk.id, chunk.index)
  const capacity = Math.max(0, target - existing.own.length)
  if (capacity && deadlineMs - Date.now() < 25_000) return { completed: false, added: 0 }
  let candidates: BookKnowledgeCandidate[] = []
  if (capacity) {
    try {
      candidates = await analyze({ bookId: job.bookId, jobId, chunkText: chunk.text, deadlineMs, existing: existing.own })
    } catch (error: any) {
      const message = String(error?.message || error)
      if (message.includes('BOOK_READ_TIME_BUDGET_EXHAUSTED') || (Date.now() >= deadlineMs - 10_000 && /timeout|deadline|abort|timed out/i.test(message))) return { completed: false, added: 0 }
      // Provider/model exhaustion never poisons the entire book: mark this
      // chunk retryable and advance to another chunk on the next step.
      // Lease/content/configuration faults still propagate and are never hidden.
      if (store.defer && /BOOK_AI_PROVIDER_EXHAUSTED|INVALID_JSON_RESPONSE|BOOK_AI_RESPONSE_TRUNCATED|AI_ACADEMIC_PROVIDER_UNAVAILABLE|TEXT_AI_ROUTER_FAILED|\b(?:401|403|429|500|502|503|504)\b/i.test(message)) {
        await store.defer(chunk.id, message)
        return { completed: false, added: 0, deferred: true }
      }
      throw error
    }
  }
  const accepted: BookKnowledgeCandidate[] = []
  for (const raw of candidates) {
    const item = validateBookKnowledgeCandidate(raw, chunk.text, { fromVerifiedLineRange: raw.sourceLineRangeVerified === true && chunk.text.includes(raw.excerpt) })
    if (item && !isRepeatedBookConcept(item, [...existing.local, ...accepted])) accepted.push(item)
    if (accepted.length >= capacity) break
  }
  console.info('[book-enrich] selection', { bookId: job.bookId, chunkId: chunk.id, candidates: candidates.length, accepted: accepted.length, rejected: { duplicateOrInvalid: candidates.length - accepted.length }, capacity, target })
  await store.save(chunk, accepted, capacity, target)
  return { completed: false, added: accepted.length }
}

// A provider outage is not a completed enrichment pass. Deferred chunks
// stay eligible for a future attempt but do not block other chunks today.
export function __testEnrichDeferralForTests(lastError: string | null | undefined, now = Date.now()): { attempts: number; ready: boolean } {
  const match = /^BOOK_ENRICH_WAIT:(\d+):(\d+)(?::|$)/.exec(String(lastError || ''))
  return match ? { attempts: Number(match[1]), ready: Number(match[2]) <= now } : { attempts: 0, ready: true }
}

/** Requires the shared read-step job lock. Processes exactly one chunk per call. */
export async function runEnrichStep(jobId: string, deadlineMs: number, claimedAt: Date) {
  const store: EnrichStepStore = {
    getJob: (id) => db.bookReadJob.findUnique({ where: { id }, select: { id: true, bookId: true, phase: true, enrichmentTarget: true } }),
    nextChunk: async (bookId) => {
      // Fetch only metadata first: no expensive 4KB texts until a due chunk
      // is found. Never turn an all-deferred book into false completion.
      // A confirmed-garbled chunk is BLOCKED from enrichment until it is
      // repaired: it is skipped here (and in finish) without touching the
      // healthy chunks. When only garbled chunks remain, return null so the
      // job completes for its readable content instead of spinning forever.
      const pending = await db.bookChunk.findMany({
        where: { bookId, status: 'ANALYZED', saturatedAt: null, analysisPasses: { lt: 3 } },
        orderBy: [{ analysisPasses: 'asc' }, { index: 'asc' }],
        select: { id: true, lastError: true },
      })
      let sawDeferred = false
      for (const item of pending) {
        if (!__testEnrichDeferralForTests(item.lastError).ready) { sawDeferred = true; continue }
        const chunk = await db.bookChunk.findUnique({
          where: { id: item.id },
          select: { id: true, bookId: true, programId: true, index: true, text: true, pageStart: true, pageEnd: true, textProvenance: true, analysisPasses: true },
        })
        if (!chunk) continue
        if (looksLikeBrokenBookPageText(chunk.text)) continue
        return chunk
      }
      if (sawDeferred) throw new Error('BOOK_ENRICH_DEFERRED')
      return null
    },
    defer: async (chunkId, reason) => {
      await db.$transaction(async (tx) => {
        await assertBookReadLease(tx, jobId, claimedAt)
        const chunk = await tx.bookChunk.findUnique({ where: { id: chunkId }, select: { status: true, lastError: true } })
        if (chunk?.status !== 'ANALYZED') return
        const attempts = Math.min(12, __testEnrichDeferralForTests(chunk.lastError).attempts + 1)
        const retryAt = Date.now() + Math.min(60 * 60_000, Math.pow(2, Math.min(attempts - 1, 6)) * 60_000)
        // Store diagnostic codes, not source text, credentials or provider payloads.
        const codes = [...new Set((reason.match(/INVALID_JSON_RESPONSE|BOOK_AI_RESPONSE_TRUNCATED|BOOK_AI_PROVIDER_EXHAUSTED|AI_ACADEMIC_PROVIDER_UNAVAILABLE|TEXT_AI_ROUTER_FAILED|\b(?:401|403|429|500|502|503|504)\b/gi) || []).slice(0, 6))].join(',') || 'PROVIDER_ERROR'
        await tx.bookChunk.update({ where: { id: chunkId }, data: { lastError: `BOOK_ENRICH_WAIT:${attempts}:${retryAt}:${codes}` } })
      })
    },
    existing: async (bookId, chunkId, index) => {
      const chunks = await db.bookChunk.findMany({ where: { bookId, index: { gte: Math.max(0, index - 2), lte: index } }, select: { id: true } })
      const rows = await db.bookKnowledgeItem.findMany({ where: { bookId, kbVersion: 2, chunkId: { in: chunks.map((chunk) => chunk.id) } }, select: { chunkId: true, title: true, summary: true } })
      return { local: rows, own: rows.filter((row) => row.chunkId === chunkId) }
    },
    save: async (chunk, items, capacity, target) => {
      const finalTarget = resolveEnrichmentTarget(target)
      await db.$transaction(async (tx) => {
        await assertBookReadLease(tx, jobId, claimedAt)
        const current = await tx.bookChunk.findUnique({
          where: { id: chunk.id }, select: { status: true, saturatedAt: true, analysisPasses: true },
        })
        if (current?.status !== 'ANALYZED' || current.saturatedAt || current.analysisPasses >= 3) return
        // Re-check both capacity and duplicate content at commit time, not at
        // the start of the AI call. The job-row lease lock serializes workers.
        const rows = await tx.bookKnowledgeItem.findMany({
          where: { bookId: chunk.bookId, kbVersion: 2, chunkId: chunk.id },
          select: { title: true, summary: true },
        })
        const available = Math.max(0, finalTarget - rows.length)
        const accepted: BookKnowledgeCandidate[] = []
        for (const item of items) {
          if (accepted.length >= available) break
          if (!isRepeatedBookConcept(item, [...rows, ...accepted])) accepted.push(item)
        }
        if (accepted.length) await tx.bookKnowledgeItem.createMany({
          data: accepted.map((item) => ({
            bookId: chunk.bookId, programId: chunk.programId,
            chunkId: chunk.id, pageStart: chunk.pageStart,
            pageEnd: chunk.pageEnd, textProvenance: chunk.textProvenance,
            kbVersion: 2, category: item.category, title: item.title,
            summary: item.summary, excerpt: item.excerpt, importance: item.importance,
          })),
        })
        await tx.bookChunk.update({
          where: { id: chunk.id },
          data: {
            // Saturation means the job target persisted items, never merely
            // exhausted tries. Count consecutive zero-yield passes; any saved
            // item reopens progress. The base target (10) is NOT final
            // saturation; final saturation is at 20.
            ...(enrichChunkSaturates({ capacity: capacity ?? 0, available, rowsBefore: rows.length, accepted: accepted.length, target: finalTarget })
              ? { saturatedAt: new Date(), analysisPasses: 0 }
              : accepted.length > 0
                ? { analysisPasses: 0 }
                : { analysisPasses: { increment: 1 } }),
            lastError: null,
          },
        })
      })
    },
    finish: async (id) => {
      await db.$transaction(async (tx) => {
        await assertBookReadLease(tx, id, claimedAt)
        const bookId = (await tx.bookReadJob.findUniqueOrThrow({ where: { id } })).bookId
        const pending = await tx.bookChunk.findMany({
          where: { bookId, status: 'ANALYZED', saturatedAt: null, analysisPasses: { lt: 3 } },
          select: { text: true },
        })
        // Garbled chunks are blocked from enrichment until repaired; they do
        // not keep the job open once every readable chunk is done.
        const stillOpen = pending.filter((chunk) => !looksLikeBrokenBookPageText(chunk.text)).length
        if (stillOpen) return
        const blocked = pending.length
        const previous = blocked ? await tx.bookReadJob.findUnique({ where: { id }, select: { lastError: true } }) : null
        await tx.bookReadJob.updateMany({
          where: { id, status: 'RUNNING', startedAt: claimedAt },
          data: { phase: 'DONE', status: 'COMPLETED', finishedAt: new Date(), lockedUntil: null, retryAt: null, ...(blocked ? { lastError: preserveBookPageReadIssues(previous?.lastError, `BOOK_ENRICH_PARTIAL: ${blocked} مقطع مشوه يحتاج إصلاح القراءة قبل الإثراء.`) } : {}) },
        })
      })
    },
  }
  return enrichStepWithStore(jobId, deadlineMs, store)
}

export type AnalyzeStepStore = {
  getJob: (id: string) => Promise<{ id: string; bookId: string; programId: string; phase: string; status: string } | null>
  nextChunk: (bookId: string, excludeIds: string[]) => Promise<{ id: string; bookId: string; programId: string; index: number; text: string; pageStart: number; pageEnd: number; textProvenance: string; attempts: number } | null>
  priorItems: (bookId: string, chunkIndex: number) => Promise<Pick<BookKnowledgeCandidate, 'title' | 'summary'>[]>
  saveAnalyzed: (chunk: { id: string; bookId: string; programId: string; pageStart: number; pageEnd: number; textProvenance: string }, items: BookKnowledgeCandidate[], jobId: string) => Promise<void>
  saveFailure: (chunkId: string, jobId: string, error: string, exhausted: boolean) => Promise<void>
  complete: (bookId: string, jobId: string) => Promise<void>
}

export async function analyzeStepWithStore(
  jobId: string,
  deadlineMs: number,
  store: AnalyzeStepStore,
  analyze: typeof analyzeBookChunk = analyzeBookChunk,
): Promise<{ analyzed: number; failed: number; completed: boolean; paused: boolean }> {
  const job = await store.getJob(jobId)
  if (!job) throw new Error('BOOK_READ_JOB_NOT_FOUND')
  if (job.phase !== 'ANALYZE') return { analyzed: 0, failed: 0, completed: job.phase === 'DONE', paused: false }
  let analyzed = 0, failed = 0
  const attempted = new Set<string>()
  while (Date.now() < deadlineMs - 1500) {
    // A manual stop can arrive while the AI provider is answering. Persist
    // the completed chunk, but never begin another after the admin pauses.
    if ((await store.getJob(jobId))?.status === 'PAUSED') {
      return { analyzed, failed, completed: false, paused: true }
    }
    const chunk = await store.nextChunk(job.bookId, [...attempted])
    if (!chunk) {
      if (attempted.size > analyzed + failed) return { analyzed, failed, completed: false, paused: false }
      await store.complete(job.bookId, jobId)
      // Completion can legitimately resolve to FAILED (zero analyzed chunks),
      // or remain RUNNING if pending work appeared. Reflect the persisted job.
      const finalJob = await store.getJob(jobId)
      return { analyzed, failed, completed: finalJob?.status === 'COMPLETED', paused: false }
    }
    attempted.add(chunk.id)
    try {
      const prior = await store.priorItems(job.bookId, chunk.index)
      if (deadlineMs - Date.now() < 25_000) return { analyzed, failed, completed: false, paused: false }
      const candidates = await analyze({ bookId: job.bookId, jobId, chunkText: chunk.text, deadlineMs, prior })
      // Revalidate at the persistence boundary, including injected analyzers in tests.
      const items = candidates.map((item) => validateBookKnowledgeCandidate(item, chunk.text, { fromVerifiedLineRange: item.sourceLineRangeVerified === true && chunk.text.includes(item.excerpt) }))
        .filter((item): item is BookKnowledgeCandidate => item !== null)
        .filter((item, index, all) => !isRepeatedBookConcept(item, [...prior, ...all.slice(0, index)]))
      await store.saveAnalyzed(chunk, items, jobId)
      analyzed++
    } catch (error: any) {
      const message = String(error?.message || error)
      // Losing the lease is a job-level fault. Provider/model exhaustion is
      // a chunk-level failure: record its attempt and continue other chunks.
      if (message.includes('BOOK_READ_LEASE_LOST')) throw error
      if (message.includes('BOOK_READ_TIME_BUDGET_EXHAUSTED') || (Date.now() >= deadlineMs - 10_000 && /timeout|deadline|abort|timed out/i.test(message))) return { analyzed, failed, completed: false, paused: false }
      const exhausted = chunk.attempts + 1 >= 3
      await store.saveFailure(chunk.id, jobId, message.slice(0, 2000), exhausted)
      if (exhausted) failed++
    }
  }
  return { analyzed, failed, completed: false, paused: false }
}

/** Requires the read-step lock to have been claimed before invocation. */
export async function runAnalyzeStep(jobId: string, deadlineMs: number, claimedAt: Date) {
  const store: AnalyzeStepStore = {
    getJob: (id) => db.bookReadJob.findUnique({ where: { id }, select: { id: true, bookId: true, programId: true, phase: true, status: true } }),
    nextChunk: async (bookId, excludeIds) => {
      // A confirmed-garbled chunk is BLOCKED from analysis until it is
      // repaired: skip it without touching the healthy chunks. Fetch the
      // pending texts once and pick the first readable one.
      const pending = await db.bookChunk.findMany({
        where: { bookId, status: { in: ['EXTRACTED', 'PENDING'] }, id: { notIn: excludeIds } },
        orderBy: { index: 'asc' },
        select: { id: true, text: true },
      })
      const healthy = pending.find((chunk) => !looksLikeBrokenBookPageText(chunk.text))
      if (!healthy) return null
      return db.bookChunk.findUnique({
        where: { id: healthy.id },
        select: { id: true, bookId: true, programId: true, index: true, text: true, pageStart: true, pageEnd: true, textProvenance: true, attempts: true },
      })
    },
    priorItems: async (bookId, chunkIndex) => {
      const chunks = await db.bookChunk.findMany({
        where: { bookId, index: { gte: Math.max(0, chunkIndex - 2), lte: chunkIndex } },
        select: { id: true },
      })
      if (!chunks.length) return []
      return db.bookKnowledgeItem.findMany({
        where: { bookId, kbVersion: 2, chunkId: { in: chunks.map((chunk) => chunk.id) } },
        select: { title: true, summary: true },
      })
    },
    saveAnalyzed: async (chunk, items, id) => {
      // The read lease and knowledge/chunk/counter writes share one short
      // transaction. A frozen old worker cannot replace the new worker's items.
      await db.$transaction(async (tx) => {
        await assertBookReadLease(tx, id, claimedAt)
        const current = await tx.bookChunk.findUnique({ where: { id: chunk.id }, select: { status: true } })
        if (!current || !['EXTRACTED', 'PENDING'].includes(current.status)) return
        await tx.bookKnowledgeItem.deleteMany({ where: { chunkId: chunk.id, kbVersion: 2 } })
        await tx.bookKnowledgeItem.createMany({ data: items.map((item) => ({
          bookId: chunk.bookId, programId: chunk.programId, chunkId: chunk.id,
          pageStart: chunk.pageStart, pageEnd: chunk.pageEnd, textProvenance: chunk.textProvenance,
          kbVersion: 2, category: item.category, title: item.title, summary: item.summary,
          excerpt: item.excerpt, importance: item.importance,
        })) })
        await tx.bookChunk.update({ where: { id: chunk.id }, data: { status: 'ANALYZED', analysisPasses: 0, lastError: null } })
        await tx.bookReadJob.update({ where: { id }, data: { chunksAnalyzed: { increment: 1 } } })
      })
    },
    saveFailure: async (chunkId, id, error, exhausted) => {
      await db.$transaction(async (tx) => {
        await assertBookReadLease(tx, id, claimedAt)
        const current = await tx.bookChunk.findUnique({ where: { id: chunkId }, select: { status: true } })
        if (!current || !['PENDING', 'EXTRACTED'].includes(current.status)) return
        await tx.bookChunk.update({
          where: { id: chunkId },
          data: { attempts: { increment: 1 }, lastError: error, ...(exhausted ? { status: 'FAILED' } : {}) },
        })
        if (exhausted) await tx.bookReadJob.update({ where: { id }, data: { chunksFailed: { increment: 1 } } })
      })
    },
    complete: async (bookId, id) => {
      await db.$transaction(async (tx) => {
        await assertBookReadLease(tx, id, claimedAt)
        const pending = await tx.bookChunk.findMany({
          where: { bookId, status: { in: ['EXTRACTED', 'PENDING'] } },
          select: { text: true },
        })
        // Garbled chunks are blocked from analysis until repaired; they do
        // not keep the job open once every readable chunk is analyzed.
        const remaining = pending.filter((chunk) => !looksLikeBrokenBookPageText(chunk.text)).length
        if (remaining) return
        const failed = pending.length + await tx.bookChunk.count({ where: { bookId, status: 'FAILED' } })
        // Do not block the rest of the book because a few chunks exhausted
        // their retries. If nothing was analyzed at all, still fail honestly.
        const analyzed = failed ? await tx.bookChunk.count({ where: { bookId, status: 'ANALYZED' } }) : 0
        if (failed && analyzed === 0) {
          const previous = await tx.bookReadJob.findUnique({ where: { id }, select: { lastError: true } })
          await tx.bookReadJob.updateMany({ where: { id, status: 'RUNNING', startedAt: claimedAt }, data: {
            phase: 'ANALYZE', status: 'FAILED',
            lastError: preserveBookPageReadIssues(previous?.lastError, `${failed} مقطع فشل`),
            finishedAt: new Date(), lockedUntil: null, retryAt: null,
          } })
          return
        }
        // Legacy normalization and completion share the owned lease.
        await tx.$executeRaw`
          UPDATE "BookKnowledgeItem"
          SET "sourceNote" = COALESCE("sourceNote", '') || ' [legacyCategory:' || "category" || ']',
              "category" = 'LEGACY'
          WHERE "bookId" = ${bookId}
            AND ("kbVersion" = 1 OR "kbVersion" IS NULL)
            AND "category" <> 'LEGACY'
        `
        const priorJob = failed ? await tx.bookReadJob.findUnique({ where: { id }, select: { lastError: true } }) : null
        await tx.bookReadJob.updateMany({
          where: { id, status: 'RUNNING', startedAt: claimedAt },
          data: {
            phase: 'DONE', status: 'COMPLETED', finishedAt: new Date(), lockedUntil: null, retryAt: null,
            ...(failed ? { lastError: preserveBookPageReadIssues(priorJob?.lastError, `BOOK_ANALYSIS_PARTIAL: ${failed} مقطع تعذر تحليله بعد استنفاد المحاولات. يمكن متابعة الفهرسة من المقاطع الناجحة؛ النواقص محفوظة للمراجعة.`) } : {}),
          },
        })
      })
    },
  }
  return analyzeStepWithStore(jobId, deadlineMs, store)
}
