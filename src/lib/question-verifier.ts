import { z } from 'zod'
import { sourceTextAtOneBasedIndex, validateLiteralEvidence } from './evidence-validator'
import { textAiCompleteJson, type TextAiProvider } from './text-ai'

export type QuestionVerifierResult = {
  index: number
  valid: boolean
  answerSupported: boolean
  evidenceSupportsQuestion: boolean
  reason: string
}

export type VerifiableQuestion = {
  type?: string
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

export type VerificationSource = { text: string }

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

function assertVerifierCoverage(raw: string, expectedIndices: readonly number[]): { results: QuestionVerifierResult[] } {
  const parsed = parseVerifierJson(raw)
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

function buildBatchPrompt(items: { index: number; question: VerifiableQuestion; sourceText: string }[]): string {
  return `أنت محقق أكاديمي مستقل. تحقق فقط من العلاقة بين السؤال والدليل ونص المصدر الأصلي المحدد لكل سؤال. لا تستخدم معرفة عامة ولا أي مصدر خارج النص المرفق.\n\nأرجع JSON صالحاً فقط بهذا الشكل:\n{\n  "results": [\n    { "index": 0, "valid": true, "answerSupported": true, "evidenceSupportsQuestion": true, "reason": "سبب موجز" }\n  ]\n}\n\nالقواعد:\n- غطِّ كل index مرسل مرة واحدة بالضبط.\n- valid=true فقط إذا كانت answerSupported و evidenceSupportsQuestion كلتاهما true.\n- إذا كان الدليل لا يدعم السؤال أو الإجابة الصحيحة مباشرةً، اجعل valid=false.\n\nالأسئلة:\n${items.map((item) => buildVerifierPrompt({ ...item.question, index: item.index }, item.sourceText)).join('\n\n---\n\n')}`
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
  return {
    ...question,
    verifierReason: result?.reason || reason,
    qualityFlags: uniqueFlags(['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW', ...(question.qualityFlags || []).filter((flag) => flag !== 'SOURCE_GROUNDED')]),
  }
}

function applyAccepted<T extends VerifiableQuestion>(question: T, result: QuestionVerifierResult, context: { provider?: string; model?: string }): T {
  return {
    ...question,
    verifierProvider: context.provider,
    verifierModel: context.model,
    verifiedAt: new Date().toISOString(),
    verifierReason: result.reason,
    qualityFlags: uniqueFlags(['SOURCE_LINKED', 'SOURCE_GROUNDED', ...(question.qualityFlags || []).filter((flag) => flag !== 'SOURCE_GROUNDED')]),
  }
}

export async function verifyQuestionsWithCrossProvider<T extends VerifiableQuestion>(opts: {
  questions: readonly T[]
  sources: readonly VerificationSource[]
  generatorProvider?: string | null
  batchSize?: number
}): Promise<T[]> {
  const batchSize = Math.max(1, Math.min(10, Math.floor(opts.batchSize || 10)))
  const excludeProviders = opts.generatorProvider ? [opts.generatorProvider as TextAiProvider] : []
  const output = opts.questions.map((question) => ({ ...question })) as T[]

  for (let start = 0; start < output.length; start += batchSize) {
    const batch = output.slice(start, start + batchSize)
    const prepared: { index: number; question: T; sourceText: string; literalPass: boolean }[] = []
    batch.forEach((question, localIndex) => {
      const index = start + localIndex
      const sourceText = sourceTextAtOneBasedIndex(opts.sources, question.sourceIndex ?? '', (item) => item.text)
      const evidence = sourceEvidence(question)
      const literal = sourceText == null ? { ok: false as const, reason: 'BAD_INDEX' } : validateLiteralEvidence({ evidence, sourceText })
      if (sourceText == null) {
        output[index] = applyRejected(question, null, 'BAD_INDEX')
        return
      }
      prepared.push({ index, question, sourceText, literalPass: literal.ok })
    })
    if (!prepared.length) continue

    let verifierContext: { provider?: string; model?: string } = {}
    let parsed: { results: QuestionVerifierResult[] } | null = null
    try {
      const raw = await textAiCompleteJson({
        system: 'أنت محقق أكاديمي مستقل للأسئلة. أرجع JSON فقط.',
        history: [{ role: 'user', text: buildBatchPrompt(prepared) }],
        temperature: 0.1,
        maxOutputTokens: 3000,
        taskLevel: 'ACADEMIC_CRITICAL',
        excludeProviders,
        validate: (text, context) => {
          verifierContext = context || {}
          assertVerifierCoverage(text, prepared.map((item) => item.index))
        },
      })
      parsed = assertVerifierCoverage(raw, prepared.map((item) => item.index))
    } catch (error: any) {
      const reason = error?.code === 'AI_VERIFIER_UNAVAILABLE'
        ? 'AI_VERIFIER_UNAVAILABLE'
        : `VERIFICATION_PENDING:${String(error?.reason || error?.code || error?.message || error).slice(0, 180)}`
      for (const item of prepared) output[item.index] = applyPending(item.question, reason)
      continue
    }

    const byIndex = new Map(parsed.results.map((result) => [result.index, result]))
    for (const item of prepared) {
      const result = byIndex.get(item.index) || null
      if (item.literalPass && result?.valid) {
        output[item.index] = applyAccepted(item.question, result, verifierContext)
      } else {
        output[item.index] = applyRejected(item.question, result, item.literalPass ? 'VERIFIER_REJECTED' : 'LITERAL_EVIDENCE_FAILED')
      }
    }
  }

  return output
}
