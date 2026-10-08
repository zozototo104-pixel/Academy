import assert from 'node:assert/strict'
import { parseScannedTranscriptionJson, visionExtractionFailedNote } from '../src/lib/book-content'
import { buildExamSourceChunks, selectExamSourceChunks } from '../src/lib/exam-source-chunks'
import { __resetTextAiStateForTests } from '../src/lib/text-ai'
import { inferTextProvenance, textContainsEvidenceAfterNormalization } from '../src/lib/text-provenance'
import { verifyQuestionsWithCrossProvider, type VerifiableQuestion } from '../src/lib/question-verifier'

const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }

const nativeText = 'هذا نص أصلي مستخرج مباشرة من ملف الكتاب يشرح أن القرار المهني الموثق يعتمد على الدليل والسياق المؤسسي قبل التنفيذ والمراجعة.'
const ocrText = 'هذا نص OCR مستخرج من صفحة ممسوحة يشرح أن القرار المهني الموثق يعتمد على الدليل والسياق المؤسسي قبل التنفيذ والمراجعة.'
const visionDescriptionText = 'هذا وصف بصري عام لمحتوى صفحة مصورة وليس نص الكتاب الحرفي، ويجب ألا يدخل ضمن الأدلة المرقمة للأسئلة.'
const legacyScaffoldText = 'خريطة امتحانية شاملة: هذا ملخص معرفي طويل لبناء الامتحان والمشرف الذكي، يحتوي بذور أسئلة ونقاط قابلة للسؤال، ولا تعامل كاقتباس حرفي من الكتاب.'

function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
}

function configureVerifier() {
  process.env.GEMINI_API_KEY = 'mock-gemini-key'
  process.env.UNOROUTER_API_KEY = 'mock-uno-key'
  process.env.AI_ACADEMIC_ALLOWLIST = 'GEMINI:gemini-3.8-flash,UNOROUTER:gpt-oss-120b:free'
}

function validResponse(index = 0) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [{ index, valid: true, answerSupported: true, evidenceSupportsQuestion: true, reason: 'مدعوم من النص المحدد.' }] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
}

async function withMockFetch(run: () => Promise<void>) {
  __resetTextAiStateForTests()
  configureVerifier()
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/pricing/catalog') || /\/models(?:\?|$)/.test(url)) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url.includes('api.unorouter.com') && url.includes('/chat/completions')) return validResponse(0)
    return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    resetEnv()
  }
}

function question(evidence: string): VerifiableQuestion {
  return {
    type: 'MCQ',
    text: 'على ماذا يعتمد القرار المهني الموثق؟',
    options: ['الدليل والسياق المؤسسي', 'الانطباع العام', 'تجاهل المصدر', 'التخمين'],
    correct: '0',
    sourceIndex: 1,
    sourceEvidence: evidence,
    qualityFlags: ['SOURCE_LINKED', 'NEEDS_HUMAN_REVIEW'],
  }
}

async function main() {
  console.log('▶ text provenance: evidence chunk filtering and OCR grounding rules')

  const chunks = buildExamSourceChunks([
    { bookId: 'native', bookTitle: 'Native', text: nativeText, contentQuality: 'UPLOADED_FILE', textProvenance: 'NATIVE_TEXT' },
    { bookId: 'ocr', bookTitle: 'OCR', text: ocrText, contentQuality: 'STORED_TEXT', linkReadStatus: 'VISION_OCR' },
    { bookId: 'legacy-scaffold', bookTitle: 'Legacy Scaffold', text: legacyScaffoldText, contentQuality: 'STORED_TEXT' },
    { bookId: 'legacy-note', bookTitle: 'Legacy Note', text: nativeText, contentQuality: 'STORED_TEXT', sourceNote: 'ملخص Gemini وخريطة معرفية قديمة' },
    { bookId: 'vision-description', bookTitle: 'Vision', text: visionDescriptionText, contentQuality: 'GEMINI_DOCUMENT', sourceNote: '[textProvenance:VISION_DESCRIPTION]' },
  ])
  assert.equal(chunks.some((chunk) => chunk.bookId === 'vision-description'), false, 'VISION_DESCRIPTION must not be numbered as exam evidence')
  assert.equal(chunks.some((chunk) => chunk.bookId === 'legacy-scaffold'), false, 'legacy Gemini scaffold text must be treated as VISION_DESCRIPTION')
  assert.equal(chunks.some((chunk) => chunk.bookId === 'legacy-note'), false, 'legacy Gemini summary notes must be treated as VISION_DESCRIPTION')
  assert.equal(chunks.some((chunk) => chunk.bookId === 'ocr'), true, 'legacy Vision/OCR status should remain usable as OCR evidence')
  assert.equal(inferTextProvenance({ linkReadStatus: 'VISION_OCR' }), 'VISION_OCR')
  assert.equal(inferTextProvenance({ contentQuality: 'STORED_TEXT', textContent: legacyScaffoldText }), 'VISION_DESCRIPTION')
  assert.equal(inferTextProvenance({ contentQuality: 'STORED_TEXT', linkReadNote: 'Gemini تلخيص وخريطة معرفية' }), 'VISION_DESCRIPTION')
  assert.equal(textContainsEvidenceAfterNormalization(nativeText, 'هذا excerpt غير موجود داخل نص الكتاب الأصلي ويجب أن يستبعد من بنك الأسئلة'), false)
  assert.equal(textContainsEvidenceAfterNormalization(nativeText, 'يشرح أن القرار المهني الموثق يعتمد على الدليل والسياق المؤسسي قبل التنفيذ والمراجعة'), true)
  const selected = selectExamSourceChunks(chunks, { maxChunks: 2 })
  assert.equal(selected.some((chunk) => chunk.bookId === 'vision-description'), false)

  const transcribed = parseScannedTranscriptionJson(JSON.stringify({ textContent: '[صفحة 1]\nهذا نص OCR مستخرج من صفحة ممسوحة يشرح أن القرار المهني الموثق يعتمد على الدليل والسياق المؤسسي قبل التنفيذ والمراجعة.', note: 'نسخ أول صفحة', pagesTranscribed: 1, pagesTotal: 3 }))
  assert.ok(transcribed.text.includes('[صفحة 1]'))
  assert.equal(transcribed.pagesTranscribed, 1)
  assert.equal(transcribed.pagesTotal, 3)
  const failureNote = visionExtractionFailedNote('OCR failed', 'summary failed', 'extract failed')
  assert.ok(failureNote.includes('تعذر استخراج نص حرفي أو ملخص بصري صالح'))
  assert.ok(failureNote.includes('[textProvenance:VISION_DESCRIPTION]'))

  await withMockFetch(async () => {
    const native = await verifyQuestionsWithCrossProvider({
      questions: [question('يشرح أن القرار المهني الموثق يعتمد على الدليل والسياق المؤسسي قبل التنفيذ والمراجعة')],
      sources: [{ text: nativeText, textProvenance: 'NATIVE_TEXT' }],
      generatorProvider: 'GEMINI',
      generatorModel: 'gemini-3.8-flash',
    })
    assert.ok(native[0].qualityFlags?.includes('SOURCE_GROUNDED'), 'native text may become source grounded')
  })

  await withMockFetch(async () => {
    const ocr = await verifyQuestionsWithCrossProvider({
      questions: [question('يشرح أن القرار المهني الموثق يعتمد على الدليل والسياق المؤسسي قبل التنفيذ والمراجعة')],
      sources: [{ text: ocrText, textProvenance: 'VISION_OCR' }],
      generatorProvider: 'GEMINI',
      generatorModel: 'gemini-3.8-flash',
    })
    assert.ok(!ocr[0].qualityFlags?.includes('SOURCE_GROUNDED'), 'OCR evidence must not become source grounded')
    assert.ok(ocr[0].qualityFlags?.includes('OCR_DERIVED_SOURCE'))
    assert.ok(ocr[0].qualityFlags?.includes('NEEDS_HUMAN_REVIEW'))
  })

  console.log('text provenance rules: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  globalThis.fetch = originalFetch
  resetEnv()
})
