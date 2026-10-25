import { z } from 'zod'
import { validateLiteralEvidence } from './evidence-validator'
import { applyOcrDerivedFlags, type TextProvenance } from './text-provenance'
import { modelFamily, resolvedTextAiModelFamily, textAiCompleteJson, type TextAiPreferredModel, type TextAiProvider, type TextAiRouterPolicy } from './text-ai'
import type { StageRouting } from './ai-stage-runner'

export type QuestionVerifierResult = {
  index: number
  valid: boolean
  answerSupported: boolean
  evidenceSupportsQuestion: boolean
  reason: string
}

export type VerifiableQuestion = {
  type?: string
  textProvenance?: TextProvenance | null
  text?: string
  options?: string[] | null
  correct?: string | number | null
  correctAnswer?: string | number | null
  modelAnswer?: string | null
  sourceEvidence?: string | null
  bookEvidence?: string | null
  sourceIndex?: string | number | null
  qualityFlags?: string[]
  sourceProvider?: string
  sourceModel?: string
  verifierProvider?: string
  verifierModel?: string
  verifiedAt?: string
  verifierReason?: string
  verificationPending?: boolean
  verificationReason?: string
}

export type VerificationSource = { text: string; textProvenance?: TextProvenance | null }

export const QUESTION_VERIFIER_TIME_BUDGET_MS = 90_000

export function __testVerifierExcludedProviders(generatorProvider: TextAiProvider): TextAiProvider[] {
  // Preserve verifier-mode diagnostics; the router selectively permits Alborihi cross-family review.
  return [generatorProvider]
}

export function __testVerifierPreferredProvidersForTests(generatorProvider?: TextAiProvider | null): TextAiProvider[] {
  const preferred: TextAiProvider[] = ['GROQ', 'GEMINI', 'UNOROUTER']
  return generatorProvider === 'ALBORIHI'
    ? ['ALBORIHI', ...preferred]
    : preferred.filter((provider) => provider !== generatorProvider)
}

const verifierItemSchema = z.object({
  index: z.number().int().nonnegative(),
  valid: z.boolean(),
  answerSupported: z.boolean(),
  evidenceSupportsQuestion: z.boolean(),
  reason: z.string().min(1).max(1000),
}).transform((item) => ({
  ...item,
  valid: item.valid && item.answerSupported && item.evidenceSupportsQuestion,
}))

const verifierResponseSchema = z.object({
  results: z.array(verifierItemSchema).min(1).max(20),
})

function clean(value: unknown, max = 4000): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function uniqueFlags(flags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const flag of flags) {
    const value = clean(flag, 120)
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function parseVerifierJson(raw: string): { results: QuestionVerifierResult[] } {
  const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return verifierResponseSchema.parse({ results: parsed })
    return verifierResponseSchema.parse(parsed)
  } catch {
    const arrayStart = text.indexOf('[')
    const arrayEnd = text.lastIndexOf(']')
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return verifierResponseSchema.parse({ results: JSON.parse(text.slice(arrayStart, arrayEnd + 1)) })
    }
    const objectStart = text.indexOf('{')
    const objectEnd = text.lastIndexOf('}')
    if (objectStart >= 0 && objectEnd > objectStart) return verifierResponseSchema.parse(JSON.parse(text.slice(objectStart, objectEnd + 1)))
    throw new Error('INVALID_VERIFIER_JSON')
  }
}

function validationRejected(reason: string): never {
  const error: any = new Error(reason)
  error.code = 'VALIDATION_REJECTED'
  error.reason = reason
  throw error
}

function assertVerifierCoverage(raw: string, expectedIndices: readonly number[]): { results: QuestionVerifierResult[] } {
  let parsed: { results: QuestionVerifierResult[] }
  try {
    parsed = parseVerifierJson(raw)
  } catch {
    validationRejected('INVALID_VERIFIER_RESPONSE')
  }
  const expected = [...expectedIndices].sort((a, b) => a - b)
  const actual = parsed.results.map((item) => item.index).sort((a, b) => a - b)
  const same = expected.length === actual.length && expected.every((index, i) => index === actual[i])
  if (!same) {
    const error: any = new Error('VERIFIER_INDEX_COVERAGE_MISMATCH')
    error.code = 'VALIDATION_REJECTED'
    error.reason = 'VERIFIER_INDEX_COVERAGE_MISMATCH'
    throw error
  }
  return parsed
}

function correctAnswerForPrompt(question: VerifiableQuestion): string {
  if (question.correct != null) return clean(question.correct, 260)
  if (question.correctAnswer != null) return clean(question.correctAnswer, 260)
  return clean(question.modelAnswer, 700)
}

function sourceEvidence(question: VerifiableQuestion): string {
  return clean(question.sourceEvidence || question.bookEvidence, 1000)
}

export function buildVerifierPrompt(question: VerifiableQuestion & { index?: number }, sourceText: string): string {
  const options = Array.isArray(question.options) && question.options.length
    ? question.options.map((option, i) => `${i}. ${clean(option, 400)}`).join('\n')
    : 'لا توجد خيارات.'
  return `تحقق من السؤال التالي اعتماداً على نص المصدر الأصلي المرفق فقط.\n\nindex: ${question.index ?? 0}\nنوع السؤال: ${clean(question.type, 40)}\nالسؤال: ${clean(question.text, 1600)}\nالخيارات:\n${options}\nالإجابة الصحيحة أو النموذجية: ${correctAnswerForPrompt(question)}\nsourceEvidence: ${sourceEvidence(question)}\n\nنص المصدر الأصلي المحدد فقط:\n"""\n${clean(sourceText, 12000)}\n"""`
}

function buildQuestionPrompt(question: VerifiableQuestion & { index?: number }, sourceRef: number): string {
  const options = Array.isArray(question.options) && question.options.length
    ? question.options.map((option, i) => `${i}. ${clean(option, 400)}`).join('\n')
    : 'لا توجد خيارات.'
  return `index: ${question.index ?? 0}\nsourceRef: ${sourceRef}\nنوع السؤال: ${clean(question.type, 40)}\nالسؤال: ${clean(question.text, 1600)}\nالخيارات:\n${options}\nالإجابة الصحيحة أو النموذجية: ${correctAnswerForPrompt(question)}\nsourceEvidence: ${sourceEvidence(question)}`
}

function buildBatchPrompt(items: { index: number; question: VerifiableQuestion; sourceText: string }[]): string {
  const sourceRefs = new Map<string, number>()
  const sources: { ref: number; text: string }[] = []
  for (const item of items) {
    if (!sourceRefs.has(item.sourceText)) {
      const ref = sourceRefs.size + 1
      sourceRefs.set(item.sourceText, ref)
      sources.push({ ref, text: item.sourceText })
    }
  }
  return `أنت محقق أكاديمي مستقل. تحقق فقط من العلاقة بين السؤال والدليل ونص المصدر الأصلي المحدد لكل سؤال. لا تستخدم معرفة عامة ولا أي مصدر خارج النص المرفق.\n\nأرجع JSON صالحاً فقط بهذا الشكل:\n{\n  "results": [\n    { "index": 0, "valid": true, "answerSupported": true, "evidenceSupportsQuestion": true, "reason": "سبب موجز" }\n  ]\n}\n\nالقواعد:\n- غطِّ كل index مرسل مرة واحدة بالضبط.\n- valid=true فقط إذا كانت answerSupported و evidenceSupportsQuestion كلتاهما true.\n- إذا كان الدليل لا يدعم السؤال أو الإجابة الصحيحة مباشرةً، اجعل valid=false.\n- استخدم فقط النص الموجود في sourceRef الخاص بكل سؤال.\n\nالمصادر الأصلية المرسلة لهذه الدفعة فقط:\n${sources.map((source) => `[sourceRef ${source.ref}]\n"""\n${clean(source.text, 12000)}\n"""`).join('\n\n')}\n\nالأسئلة:\n${items.map((item) => buildQuestionPrompt({ ...item.question, index: item.index }, sourceRefs.get(item.sourceText) || 0)).join('\n\n---\n\n')}`
}

function applyPending<T extends VerifiableQuestion>(question: T, reason: string): T {
  return {
    ...question,
    verificationPending: true,
    verificationReason: reason,
    qualityFlags: uniqueFlags(['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW', ...(question.qualityFlags || []).filter((flag) => flag !== 'SOURCE_GROUNDED')]),
  }
}

function applyRejected<T extends VerifiableQuestion>(question: T, result: QuestionVerifierResult | null, reason: string): T {
  const verifierReason = reason === 'VERIFIER_REJECTED' ? (result?.reason || reason) : reason
  return {
    ...question,
    verifierReason,
    qualityFlags: uniqueFlags(['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW', ...(question.qualityFlags || []).filter((flag) => flag !== 'SOURCE_GROUNDED')]),
  }
}

function applyAccepted<T extends VerifiableQuestion>(question: T, result: QuestionVerifierResult, context: { provider?: string; model?: string }, allowOcrGrounding = false): T {
  const provenance = question.textProvenance || null
  const isOcr = provenance === 'VISION_OCR'
  return {
    ...question,
    verifierProvider: context.provider,
    verifierModel: context.model,
    verifiedAt: new Date().toISOString(),
    verifierReason: result.reason,
    // Default: OCR sources never carry SOURCE_GROUNDED, even on verifier
    // pass (OCR text can misread words). allowOcrGrounding lifts that
    // ONLY for the reverify flow (owner-approved 2026-10-25): reverify
    // touches admin-approved items only, so a stamped OCR question has passed
    // both the AI verifier and human approval — and OCR_DERIVED_SOURCE
    // is KEPT alongside the stamp so provenance stays visible.
    qualityFlags: isOcr && !allowOcrGrounding
      ? applyOcrDerivedFlags(question.qualityFlags || ['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW'], provenance)
      : uniqueFlags(['SOURCE_LINKED', 'SOURCE_GROUNDED', ...(isOcr ? ['OCR_DERIVED_SOURCE'] : []), ...(question.qualityFlags || []).filter((flag) => flag !== 'SOURCE_GROUNDED')]),
  }
}

// Test-only export of the accept path (same __test convention as the other
// verifier helpers): lets the OCR-grounding branch be tested directly
// without driving the full AI call flow.
export const __testApplyAcceptedForTests = applyAccepted

function finalQuestionStatus(question: VerifiableQuestion): string {
  const flags = question.qualityFlags || []
  if (flags.includes('SOURCE_GROUNDED')) return 'SOURCE_GROUNDED'
  if (question.verificationPending) return 'VERIFICATION_PENDING'
  if (flags.includes('NEEDS_HUMAN_REVIEW')) return 'NEEDS_HUMAN_REVIEW'
  if (flags.includes('SOURCE_LINKED')) return 'SOURCE_LINKED'
  return 'UNKNOWN'
}

function logVerifierVerdict(args: {
  questionIndex: number
  question: VerifiableQuestion
  result: QuestionVerifierResult | null
  verifierContext?: { provider?: string; model?: string }
  generatorProvider?: string | null
  generatorModel?: string | null
  literalEvidenceOk: boolean
  reason: string
}) {
  const generator = `${clean(args.generatorProvider || '-', 80)}/${clean(args.generatorModel || '-', 140)}`
  const verifier = `${clean(args.verifierContext?.provider || '-', 80)}/${clean(args.verifierContext?.model || '-', 140)}`
  console.info(`[question-verifier] verdict index=${args.questionIndex} type=${clean(String(args.question.type || 'UNKNOWN'), 30)} generator=${generator} verifier=${verifier} valid=${Boolean(args.result?.valid)} literalEvidenceOk=${args.literalEvidenceOk} provenance=${clean(args.question.textProvenance || 'NATIVE_TEXT', 60)} finalStatus=${finalQuestionStatus(args.question)} reason="${clean(args.result?.reason || args.reason, 240)}"`)
}

function familyAliases(family: string): string[] {
  const aliases: Record<string, string[]> = {
    gemini: ['gemini', 'gemma', 'google'],
    gpt: ['gpt', 'gpt-oss', 'chatgpt', 'openai'],
    claude: ['claude', 'anthropic'],
    llama: ['llama', 'meta-llama'],
    qwen: ['qwen'],
    deepseek: ['deepseek'],
    mistral: ['mistral', 'mixtral'],
    glm: ['glm'],
    nemotron: ['nemotron'],
    minimax: ['minimax'],
    kimi: ['kimi', 'moonshot'],
    grok: ['grok'],
    phi: ['phi'],
    cohere: ['cohere', 'command'],
    yi: ['yi'],
    ernie: ['ernie'],
    hunyuan: ['hunyuan'],
    ling: ['ling'],
  }
  return aliases[family] || [family]
}

function verifierFamilyAllowed(context: { provider?: string; model?: string; family?: string }, generatorProvider: string, generatorFamily: string): { ok: true } | { ok: false; reason: string } {
  if (!context.model) return { ok: false, reason: 'VERIFIER_MODEL_UNKNOWN' }
  const declaredFamily = context.provider === 'ALBORIHI' ? modelFamily(context.family || '') : 'unknown'
  const verifierFamily = declaredFamily !== 'unknown' ? declaredFamily : modelFamily(context.model)
  if (verifierFamily === generatorFamily) return { ok: false, reason: 'VERIFIER_SAME_FAMILY' }
  if (verifierFamily !== 'unknown') return { ok: true }
  if (!context.provider || context.provider === generatorProvider) return { ok: false, reason: 'VERIFIER_SAME_FAMILY_OR_UNKNOWN' }
  const lower = String(context.model || '').toLowerCase()
  if (familyAliases(generatorFamily).some((alias) => lower.includes(alias))) return { ok: false, reason: 'VERIFIER_SAME_FAMILY' }
  return { ok: true }
}

// D3.1: قاعدة المدقق ≠ المولّد على مستوى الزوج الفعلي (مزوّد + موديل).
// تُزال من قائمة البروفايل أي خانة تطابق زوج التوليد لهذه الدفعة
// بالضبط؛ نفس الموديل عند مزوّد آخر أو موديل آخر عند نفس المزوّد
// يبقيان خاضعين لآلية العائلة الحالية دون تغيير.
export function filterDistinctVerifierModels<T extends { provider: string; model: string }>(
  models: readonly T[],
  generatorProvider?: string | null,
  generatorModel?: string | null,
): T[] {
  const provider = String(generatorProvider || '').trim().toUpperCase()
  const model = String(generatorModel || '').trim().toLowerCase()
  if (!provider || !model) return [...models]
  return models.filter((m) => !(String(m.provider).trim().toUpperCase() === provider && String(m.model).trim().toLowerCase() === model))
}

export const __testFilterDistinctVerifierModelsForTests = filterDistinctVerifierModels

export function verifierEqualsGenerator(
  context: { provider?: string; model?: string },
  generatorProvider?: string | null,
  generatorModel?: string | null,
): boolean {
  if (!context.provider || !context.model) return false
  return String(context.provider).trim().toUpperCase() === String(generatorProvider || '').trim().toUpperCase()
    && String(context.model).trim().toLowerCase() === String(generatorModel || '').trim().toLowerCase()
}

export const __testVerifierFamilyAllowedForTests = verifierFamilyAllowed

export async function verifyQuestionsWithCrossProvider<T extends VerifiableQuestion>(opts: {
  questions: readonly T[]
  sources: readonly VerificationSource[]
  generatorProvider?: string | null
  generatorModel?: string | null
  batchSize?: number
  timeBudgetMs?: number
  // D2.4: stage routing from the REVIEW profile (strict allowlist).
  // Absent/null = today's behavior exactly. The verifier never throws
  // on model failure (it marks questions pending), so "all stage
  // models failed" is detected as zero parsed responses and retried
  // once globally — inside this function — when the profile allows.
  routing?: StageRouting | null
  onFallbackAttempt?: () => void
  // Owner-approved 2026-10-25, reverify-only: when true, a verifier
  // PASS stamps VISION_OCR questions too (keeping OCR_DERIVED_SOURCE).
  // Absent/false = today's behavior exactly (generation, books-ai and
  // the recheck runner never pass it, so their OCR stripping is intact).
  allowOcrGrounding?: boolean
}): Promise<T[]> {
  const batchSize = Math.max(1, Math.min(10, Math.floor(opts.batchSize || 10)))
  if (!String(opts.generatorProvider || '').trim()) {
    return opts.questions.map((question) => applyPending({ ...question }, 'GENERATOR_PROVIDER_UNKNOWN')) as T[]
  }
  if (!String(opts.generatorModel || '').trim()) {
    return opts.questions.map((question) => applyPending({ ...question }, 'GENERATOR_MODEL_UNKNOWN')) as T[]
  }
  const alborihiGenerator = String(opts.generatorProvider).trim().toUpperCase() === 'ALBORIHI'
  const generatorFamily = alborihiGenerator
    ? await resolvedTextAiModelFamily('ALBORIHI', opts.generatorModel || '')
    : modelFamily(opts.generatorModel || '')
  if (generatorFamily === 'unknown') {
    return opts.questions.map((question) => applyPending({ ...question }, 'GENERATOR_FAMILY_UNKNOWN')) as T[]
  }
  const excludeProviders = __testVerifierExcludedProviders(opts.generatorProvider as TextAiProvider)
  const excludeModelFamilies = [generatorFamily]
  const budget = opts.timeBudgetMs == null ? QUESTION_VERIFIER_TIME_BUDGET_MS : Math.max(0, Math.floor(opts.timeBudgetMs))
  const deadline = Date.now() + budget

  async function runPass(effectiveRouting: StageRouting | null): Promise<{ output: T[]; anyResponse: boolean }> {
    const output = opts.questions.map((question) => ({ ...question })) as T[]
    let anyResponse = false
    const distinctRouting = effectiveRouting ? filterDistinctVerifierModels(effectiveRouting.preferredModels, opts.generatorProvider, opts.generatorModel) : []
    const routingModels = distinctRouting.map((m) => ({ provider: m.provider as TextAiPreferredModel['provider'], model: m.model }))
    if (effectiveRouting && !routingModels.length) {
      // D3.1: بروفايل التدقيق لا يملك أي مدقق مختلف عن المولّد —
      // لا نداء أصلًا، والأسئلة تبقى pending بسبب صريح، وتُعامل
      // التمريرة كفشل مرحلة لأغراض قرار الرجوع العالمي.
      for (let index = 0; index < output.length; index++) output[index] = applyPending(output[index], 'VERIFIER_EQUALS_GENERATOR')
      return { output, anyResponse: false }
    }
  for (let start = 0; start < output.length; start += batchSize) {
    if (Date.now() >= deadline) {
      for (let index = start; index < output.length; index++) output[index] = applyPending(output[index], 'VERIFIER_TIME_BUDGET_EXCEEDED')
      break
    }
    const batch = output.slice(start, start + batchSize)
    const prepared: { index: number; question: T; sourceText: string; literalPass: boolean }[] = []
    batch.forEach((question, localIndex) => {
      const index = start + localIndex
      const sourceNumber = typeof question.sourceIndex === 'string' ? Number(question.sourceIndex.trim()) : question.sourceIndex
      const source = Number.isInteger(sourceNumber) && Number(sourceNumber) >= 1 && Number(sourceNumber) <= opts.sources.length
        ? opts.sources[Number(sourceNumber) - 1]
        : null
      const sourceText = source?.text
      const textProvenance = question.textProvenance || source?.textProvenance || null
      const questionWithProvenance = { ...question, textProvenance } as T
      const evidence = sourceEvidence(questionWithProvenance)
      const literal = sourceText == null ? { ok: false as const, reason: 'BAD_INDEX' } : validateLiteralEvidence({ evidence, sourceText })
      if (sourceText == null) {
        output[index] = applyRejected(questionWithProvenance, null, 'BAD_INDEX')
        logVerifierVerdict({ questionIndex: index, question: output[index], result: null, generatorProvider: opts.generatorProvider, generatorModel: opts.generatorModel, literalEvidenceOk: false, reason: 'BAD_INDEX' })
        return
      }
      prepared.push({ index, question: questionWithProvenance, sourceText, literalPass: literal.ok })
    })
    if (!prepared.length) continue

    let verifierContext: { provider?: string; model?: string; family?: string } = {}
    let parsed: { results: QuestionVerifierResult[] } | null = null
    try {
      const raw = await textAiCompleteJson({
        system: 'أنت محقق أكاديمي مستقل للأسئلة. أرجع JSON فقط.',
        history: [{ role: 'user', text: buildBatchPrompt(prepared) }],
        temperature: 0.1,
        maxOutputTokens: 3000,
        taskLevel: 'ACADEMIC_CRITICAL',
        purpose: 'REVIEW',
        ...(effectiveRouting
          ? { preferredProviders: [...new Set([...effectiveRouting.preferredProviders, ...distinctRouting.map((m) => m.provider)])] as TextAiProvider[], preferredModels: routingModels, restrictToModels: routingModels, ...(effectiveRouting.policy ? { routerPolicy: effectiveRouting.policy as TextAiRouterPolicy } : {}) }
          : { preferredProviders: __testVerifierPreferredProvidersForTests(alborihiGenerator ? 'ALBORIHI' : opts.generatorProvider as TextAiProvider) }),
        excludeProviders,
        excludeModelFamilies,
        allowAlborihiCrossFamilyVerifier: alborihiGenerator,
        maxProviderModels: { UNOROUTER: 3 },
        providerRateLimitCooldown: { provider: 'UNOROUTER', threshold: 3, windowMs: 60_000, cooldownMinutes: 10 },
        deadlineMs: deadline,
        validate: (text, context) => {
          // A same-provider Alborihi verifier must have a known, different family.
          // Reject an unsuitable response inside the router so it can try another model/provider.
          if (alborihiGenerator && context?.provider === 'ALBORIHI') {
            const familyCheck = verifierFamilyAllowed(context, 'ALBORIHI', generatorFamily)
            if (!familyCheck.ok) validationRejected(familyCheck.reason)
          }
          verifierContext = context || {}
          assertVerifierCoverage(text, prepared.map((item) => item.index))
        },
      })
      parsed = assertVerifierCoverage(raw, prepared.map((item) => item.index))
      anyResponse = true
    } catch (error: any) {
      const reason = error?.code === 'AI_VERIFIER_UNAVAILABLE'
        ? 'AI_VERIFIER_UNAVAILABLE'
        : error?.code === 'AI_VERIFIER_SAME_FAMILY'
          ? 'VERIFIER_SAME_FAMILY'
          : error?.code === 'AI_DEADLINE_EXCEEDED'
            ? 'VERIFIER_TIME_BUDGET_EXCEEDED'
            : `VERIFICATION_PENDING:${String(error?.reason || error?.code || error?.message || error).slice(0, 180)}`
      for (const item of prepared) {
        output[item.index] = applyPending(item.question, reason)
        logVerifierVerdict({ questionIndex: item.index, question: output[item.index], result: null, verifierContext, generatorProvider: opts.generatorProvider, generatorModel: opts.generatorModel, literalEvidenceOk: item.literalPass, reason })
      }
      continue
    }

    if (Date.now() >= deadline) {
      for (const item of prepared) {
        output[item.index] = applyPending(item.question, 'VERIFIER_TIME_BUDGET_EXCEEDED')
        logVerifierVerdict({ questionIndex: item.index, question: output[item.index], result: null, verifierContext, generatorProvider: opts.generatorProvider, generatorModel: opts.generatorModel, literalEvidenceOk: item.literalPass, reason: 'VERIFIER_TIME_BUDGET_EXCEEDED' })
      }
      continue
    }
    // D3.1: تدقيق الزوج على الاستجابة الفعلية — أي رد من نفس زوج
    // المولّد لا يقف أبدًا مهما قالت فحوصات العائلة المعلنة.
    if (verifierEqualsGenerator(verifierContext, opts.generatorProvider, opts.generatorModel)) {
      for (const item of prepared) {
        output[item.index] = applyPending(item.question, 'VERIFIER_EQUALS_GENERATOR')
        logVerifierVerdict({ questionIndex: item.index, question: output[item.index], result: null, verifierContext, generatorProvider: opts.generatorProvider, generatorModel: opts.generatorModel, literalEvidenceOk: item.literalPass, reason: 'VERIFIER_EQUALS_GENERATOR' })
      }
      continue
    }
    const familyCheck = verifierFamilyAllowed(verifierContext, String(opts.generatorProvider), generatorFamily)
    if (!familyCheck.ok) {
      for (const item of prepared) {
        output[item.index] = applyPending(item.question, familyCheck.reason)
        logVerifierVerdict({ questionIndex: item.index, question: output[item.index], result: null, verifierContext, generatorProvider: opts.generatorProvider, generatorModel: opts.generatorModel, literalEvidenceOk: item.literalPass, reason: familyCheck.reason })
      }
      continue
    }

    const byIndex = new Map(parsed.results.map((result) => [result.index, result]))
    for (const item of prepared) {
      const result = byIndex.get(item.index) || null
      if (item.literalPass && result?.valid) {
        output[item.index] = applyAccepted(item.question, result, verifierContext, opts.allowOcrGrounding === true)
        logVerifierVerdict({ questionIndex: item.index, question: output[item.index], result, verifierContext, generatorProvider: opts.generatorProvider, generatorModel: opts.generatorModel, literalEvidenceOk: item.literalPass, reason: result.reason })
      } else {
        const reason = item.literalPass ? 'VERIFIER_REJECTED' : 'LITERAL_EVIDENCE_FAILED'
        output[item.index] = applyRejected(item.question, result, reason)
        logVerifierVerdict({ questionIndex: item.index, question: output[item.index], result, verifierContext, generatorProvider: opts.generatorProvider, generatorModel: opts.generatorModel, literalEvidenceOk: item.literalPass, reason })
      }
    }
  }
    return { output, anyResponse }
  }

  const routing = opts.routing ?? null
  const first = await runPass(routing)
  if (!routing || first.anyResponse) return first.output
  if (!routing.allowGlobalFallback) return first.output
  opts.onFallbackAttempt?.()
  const second = await runPass(null)
  return second.output
}
