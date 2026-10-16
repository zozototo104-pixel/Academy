/// <reference types="bun-types" />
import { readFileSync } from 'fs'
import { join } from 'path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

const calls: string[] = []
let capturedAsrOptions: any = null
let unitKnowledgeCount = 3
let programOverrideAudit = false

function makeBankQuestions(count: number, skill = 'ANALYZE') {
  return Array.from({ length: count }, (_, index) => ({
    id: `bank-${index + 1}`,
    status: 'APPROVED',
    type: 'MCQ',
    text: `سؤال موثق ${index + 1}`,
    options: JSON.stringify(['أ', 'ب', 'ج', 'د']),
    correctAnswer: '0',
    modelAnswer: 'الإجابة أ',
    knowledgeItemId: `k-${index + 1}`,
    sourceEvidence: 'دليل موثق من الكتاب',
    rubric: null,
    correctRationale: 'لأنه مطابق للدليل',
    qualityFlags: 'SOURCE_GROUNDED',
    cognitiveSkill: skill,
    usageCount: 0,
    createdAt: new Date(),
  }))
}

function makeProgramQuestions(skill = 'UNDERSTAND') {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `pq-${index + 1}`,
    examId: 'program-exam-1',
    order: index + 1,
    type: 'MCQ',
    text: `سؤال شامل ${index + 1}`,
    options: JSON.stringify(['أ', 'ب', 'ج', 'د']),
    correctAnswer: '0',
    modelAnswer: 'الإجابة أ',
    sourceEvidence: 'دليل موثق من الكتاب',
    sourceBookTitle: 'كتاب موثق',
    sourceLocator: `صفحة ${index + 1}`,
    cognitiveSkill: skill,
    difficulty: 'MEDIUM',
    correctRationale: 'سبب صحة الإجابة',
    distractorRationales: JSON.stringify([{ optionIndex: 1, option: 'ب', reason: 'مشتت غير صحيح' }]),
    qualityFlags: JSON.stringify(['SOURCE_GROUNDED']),
    reviewNotes: null,
    points: 2,
    status: 'PUBLISHED',
  }))
}

const db: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(db),
  unit: {
    findFirst: async () => ({ id: 'unit-1', title: 'وحدة محدودة المعرفة', sourceBookId: 'book-1', chunkStartIndex: 0, chunkEndIndex: 10, semester: 1, exam: null }),
  },
  bookChunk: { findMany: async () => [{ id: 'chunk-1' }, { id: 'chunk-2' }] },
  bookKnowledgeItem: { count: async () => unitKnowledgeCount },
  questionBankItem: {
    findMany: async ({ where }: any) => makeBankQuestions(20, where?.unitId ? 'ANALYZE' : 'UNDERSTAND'),
    updateMany: async () => ({ count: 5 }),
  },
  exam: {
    create: async ({ data }: any) => ({ id: 'exam-1', ...data }),
    update: async ({ data }: any) => ({ id: 'exam-1', ...data }),
    findUnique: async () => ({ id: 'exam-1', title: 'اختبار وحدة: وحدة محدودة المعرفة', status: 'READY', passScore: 60, generationWarning: 'LIMITED_KNOWLEDGE', _count: { questions: 5, attempts: 0 } }),
  },
  examDraft: { deleteMany: async () => ({ count: 0 }) },
  question: {
    deleteMany: async () => ({ count: 0 }),
    count: async () => 0,
    create: async ({ data }: any) => { calls.push(`unit.question.create:${data.text}`); return { id: `q-${calls.length}`, ...data } },
  },
  program: { update: async () => ({}) },
  programExam: {
    findUnique: async () => ({ id: 'program-exam-1', programId: 'program-1', title: 'امتحان شامل', semester: 1, generatedBy: 'QUESTION_BANK', program: { category: 'DIPLOMA', titleAr: 'برنامج' }, questions: [] }),
    update: async ({ data }: any) => { calls.push(`programExam.update:${data.status}`); return { id: 'program-exam-1', ...data } },
  },
  programQuestion: {
    findMany: async ({ where, select }: any) => {
      if (where?.status === 'PENDING_REVIEW') return []
      if (select?.points) return makeProgramQuestions('UNDERSTAND').map((q) => ({ points: q.points }))
      return makeProgramQuestions('UNDERSTAND')
    },
    count: async () => 5,
    update: async () => ({}),
  },
  enrollment: { findMany: async () => [] },
  auditLog: { create: async ({ data }: any) => { calls.push(`auditLog:${data.action}`); return data } },
}

mock.module('@/lib/db', () => ({ db }))

const realAuth = await import('../../src/lib/auth')
mock.module('@/lib/auth', () => ({ ...realAuth, requireUser: async () => ({ id: 'student-1', role: 'STUDENT' }), requireAdmin: async () => ({ id: 'admin-1', name: 'مدير', role: 'ADMIN' }) }))

const realRateLimits = await import('../../src/lib/ai-rate-limits')
mock.module('@/lib/ai-rate-limits', () => ({ ...realRateLimits, base64DecodedSize: () => 32, enforceUserAiRateLimit: () => null }))

const realAsr = await import('../../src/lib/asr')
mock.module('@/lib/asr', () => ({ ...realAsr, transcribeAudioBase64: async (_audio: string, options: any) => { capturedAsrOptions = options; return 'نص مسموع' } }))

const realSettings = await import('../../src/lib/settings')
mock.module('@/lib/settings', () => ({ ...realSettings, getSetting: async (key: string) => key === 'VOICE_DEFAULT_DIALECT' ? 'ar-PS' : key === 'UNIT_MIN_KNOWLEDGE_ITEMS' ? '15' : '' }))

const realQuestionBankJob = await import('../../src/lib/question-bank-job')
mock.module('@/lib/question-bank-job', () => ({ ...realQuestionBankJob, ensureQuestionBankGenerationJob: async () => ({ id: 'job-1', status: 'QUEUED', saved: 0, requested: 5 }), runQuestionBankGenerationJobStepsUntil: async () => null }))

const realNotify = await import('../../src/lib/notify')
mock.module('@/lib/notify', () => ({ ...realNotify, audit: async (_actor: any, action: string) => { calls.push(`audit:${action}`); if (action === 'OVERRIDE_COGNITIVE_DISTRIBUTION') programOverrideAudit = true }, notify: async () => null }))

const realMailer = await import('../../src/lib/mailer')
mock.module('@/lib/mailer', () => ({ ...realMailer, emailExamPublished: async () => true }))

const asrRoute = await import('../../src/app/api/ai/asr/route')
const unitGenerateRoute = await import('../../src/app/api/admin/unit-exams/generate/route')
const programExamQuestionsRoute = await import('../../src/app/api/admin/program-exam-questions/route')

async function json(res: Response) {
  return res.json() as Promise<any>
}

function simulatePcmCaptureWorklet() {
  const code = readFileSync(join(process.cwd(), 'public', 'worklets', 'pcm-capture.js'), 'utf8')
  const registry: Record<string, any> = {}
  class FakeAudioWorkletProcessor {
    port = { messages: [] as any[], postMessage: (message: any) => this.port.messages.push(message) }
  }
  new Function('AudioWorkletProcessor', 'sampleRate', 'registerProcessor', code)(
    FakeAudioWorkletProcessor,
    48000,
    (name: string, processor: any) => { registry[name] = processor }
  )
  const Processor = registry['pcm-capture']
  if (!Processor) throw new Error('pcm-capture worklet was not registered')
  return new Processor() as FakeAudioWorkletProcessor & { process: (inputs: Float32Array[][]) => boolean }
}

beforeEach(() => {
  calls.splice(0, calls.length)
  capturedAsrOptions = null
  unitKnowledgeCount = 3
  programOverrideAudit = false
})

describe('AI D2 behavior', () => {
  test('PCM capture worklet buffers small 48k frames and preserves downsampled sample count', () => {
    const processor = simulatePcmCaptureWorklet()
    for (let i = 0; i < 100; i++) processor.process([ [new Float32Array(128).fill(0.1)] ])
    const messages = processor.port.messages
    const samples = messages.reduce((sum: number, message: any) => sum + Number(message.sampleCount || 0), 0)
    expect(messages.length).toBeGreaterThanOrEqual(7)
    expect(messages.length).toBeLessThanOrEqual(9)
    expect(Math.abs(samples - (100 * 128 / 3))).toBeLessThanOrEqual(1)
    expect(messages.every((message: any) => message.level > 0 && message.peak > 0)).toBe(true)
  })

  test('selected dialect reaches ASR and does not default to ar-SA', async () => {
    const res = await asrRoute.POST(new NextRequest('https://academy.test/api/ai/asr', {
      method: 'POST',
      body: JSON.stringify({ audioBase64: Buffer.from('voice').toString('base64'), mimeType: 'audio/webm', dialect: 'ar-EG' }),
      headers: { 'content-type': 'application/json' },
    }))
    expect(res.status).toBe(200)
    expect(capturedAsrOptions?.languageCode).toBe('ar-EG')
    expect(capturedAsrOptions?.languageCode).not.toBe('ar-SA')
  })

  test('limited unit knowledge reduces generated count and returns LIMITED_KNOWLEDGE', async () => {
    const res = await unitGenerateRoute.POST(new NextRequest('https://academy.test/api/admin/unit-exams/generate', {
      method: 'POST',
      body: JSON.stringify({ programId: 'program-1', unitId: 'unit-1', count: 20 }),
      headers: { 'content-type': 'application/json' },
    }))
    const payload = await json(res as any)
    expect(res.status).toBe(200)
    expect(payload.warning).toBe('LIMITED_KNOWLEDGE')
    expect(payload.requestedQuestions).toBe(20)
    expect(payload.requiredQuestions).toBe(5)
    expect(calls.filter((call) => call.startsWith('unit.question.create:')).length).toBe(5)
  })

  test('all-rote comprehensive exam returns 409 without override and override with reason passes with audit', async () => {
    const rejected = await programExamQuestionsRoute.POST(new NextRequest('https://academy.test/api/admin/program-exam-questions', {
      method: 'POST',
      body: JSON.stringify({ examId: 'program-exam-1', action: 'APPROVE_ALL' }),
      headers: { 'content-type': 'application/json' },
    }))
    const rejectedPayload = await json(rejected as any)
    expect(rejected.status).toBe(409)
    expect(rejectedPayload.code).toBe('COGNITIVE_DISTRIBUTION_FAILED')

    const approved = await programExamQuestionsRoute.POST(new NextRequest('https://academy.test/api/admin/program-exam-questions', {
      method: 'POST',
      body: JSON.stringify({ examId: 'program-exam-1', action: 'APPROVE_ALL', overrideCognitivePolicy: true, overrideReason: 'الامتحان قصير ومخصص لمراجعة تأسيسية مؤقتة' }),
      headers: { 'content-type': 'application/json' },
    }))
    const approvedPayload = await json(approved as any)
    expect(approved.status).toBe(200)
    expect(approvedPayload.ok).toBe(true)
    expect(programOverrideAudit).toBe(true)
    expect(calls).toContain('programExam.update:READY')
  })
})
