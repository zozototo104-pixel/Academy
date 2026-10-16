/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

const calls: string[] = []
const answers: any[] = []
const defenseMessages: any[] = [{ id: 'm1', thesisId: 'thesis-1', role: 'STUDENT', content: 'إجابة محفوظة' }]
let thesis: any

function clone<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

const program = {
  id: 'program-1',
  titleAr: 'برنامج عربي للاختبار',
  titleEn: 'Arabic Test Program',
  category: 'DIPLOMA',
  hours: 30,
  price: 0,
  description: 'برنامج اختبار',
  admissionRules: null,
  _count: { units: 1 },
  units: [{ order: 1, title: 'وحدة بلا أسئلة' }],
  books: [],
  assignments: [{ id: 'assignment-1', title: 'واجب تطبيقي', semester: 1, points: 100, status: 'PUBLISHED', weight: 20 }],
  programExams: [{ id: 'program-exam-1', title: 'اختبار نهائي', semester: 1, status: 'READY', passScore: 51, totalPoints: 100, _count: { questions: 1 } }],
}

const db: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(db),
  exam: {
    findUnique: async () => ({
      id: 'exam-1',
      status: 'READY',
      passScore: 60,
      unit: { programId: 'program-1', program: { id: 'program-1', titleAr: 'برنامج عربي للاختبار', slug: 'program' } },
      questions: [{ id: 'essay-1', order: 1, type: 'ESSAY', text: 'اشرح الفكرة', modelAnswer: 'إجابة نموذجية', rubric: null, knowledgeItemId: null, sourceEvidence: null, points: 10 }],
    }),
    findMany: async () => [{ id: 'empty-unit-exam', title: 'اختبار فارغ قديم', status: 'READY', passScore: 60, unit: { title: 'وحدة قديمة' }, _count: { questions: 0 } }],
  },
  enrollment: {
    findUnique: async () => ({ id: 'enrollment-1', userId: 'user-1', programId: 'program-1', status: 'ACTIVE', finalScore: 88, certificateNo: 'AACT-C-1', createdAt: new Date(), updatedAt: new Date() }),
    findFirst: async () => ({ id: 'enrollment-1', userId: 'user-1', programId: 'program-1', status: 'COMPLETED', finalScore: 88, certificateNo: 'AACT-C-1', createdAt: new Date(), updatedAt: new Date() }),
  },
  examAttempt: {
    findFirst: async () => ({ id: 'attempt-1', createdAt: new Date() }),
    updateMany: async ({ data }: any) => { calls.push(`attempt.updateMany:${data.status}`); return { count: 1 } },
    update: async ({ data }: any) => { calls.push(`attempt.update:${data.status}`); return { id: 'attempt-1', ...data } },
    findMany: async () => [],
  },
  answer: {
    create: async ({ data }: any) => { calls.push(`answer.create:${data.questionId}:${data.aiFeedback || ''}`); answers.push({ ...data }); return data },
    updateMany: async ({ where, data }: any) => {
      calls.push(`answer.updateMany:${where.questionId}:${data.aiFeedback || ''}`)
      const existing = answers.find((answer) => answer.attemptId === where.attemptId && answer.questionId === where.questionId)
      if (existing) Object.assign(existing, data)
      return { count: existing ? 1 : 0 }
    },
  },
  bookKnowledgeItem: { findMany: async () => [] },
  examDraft: { deleteMany: async () => ({ count: 1 }) },
  thesisSubmission: {
    findFirst: async () => thesis,
    findMany: async () => [],
    update: async ({ data }: any) => { Object.assign(thesis, data); return thesis },
  },
  defenseMessage: {
    findMany: async () => clone(defenseMessages),
    deleteMany: async () => { calls.push('defense.deleteMany'); defenseMessages.splice(0, defenseMessages.length); return { count: 1 } },
    create: async ({ data }: any) => { const row = { id: `m${defenseMessages.length + 1}`, createdAt: new Date(), ...data }; defenseMessages.push(row); return row },
    findFirst: async () => null,
  },
  program: {
    findUnique: async () => clone(program),
    findFirst: async () => clone(program),
  },
  programExam: {
    findMany: async () => [clone(program.programExams[0])],
    findUnique: async () => ({
      id: 'program-exam-1',
      title: 'اختبار نهائي',
      status: 'READY',
      programId: 'program-1',
      semester: 1,
      passScore: 51,
      durationMin: 60,
      totalPoints: 100,
      program: { id: 'program-1', titleAr: 'برنامج عربي للاختبار' },
      questions: [{ id: 'program-essay-1', order: 1, type: 'ESSAY', text: 'حلل الحالة', modelAnswer: 'إجابة نموذجية', rubric: null, knowledgeItemId: null, sourceEvidence: null, points: 100, status: 'PUBLISHED' }],
    }),
  },
  programExamAttempt: {
    findFirst: async ({ where }: any) => {
      if (where?.status === 'EXPIRED') return null
      if (where?.status === 'STARTED') return { id: 'program-attempt-started', userId: 'user-1', examId: 'program-exam-1', status: 'STARTED', startedAt: new Date(Date.now() - 60_000), createdAt: new Date() }
      return null
    },
    updateMany: async ({ data }: any) => { calls.push(`programAttempt.updateMany:${data.status}`); return { count: 1 } },
    update: async ({ data }: any) => { calls.push(`programAttempt.update:${data.status}`); return { id: 'program-attempt-started', ...data } },
    findMany: async ({ where }: any) => {
      if (where?.examId) {
        return [{ score: 72, finalScore: 88, appealStatus: 'REVIEWED', status: 'GRADED', passed: true, answers: [{ points: 72, maxPoints: 100 }] }]
      }
      return [{ id: 'program-attempt-1', score: 72, finalScore: 88, passed: true, status: 'GRADED', submittedAt: new Date(), exam: { title: 'اختبار نهائي', semester: 1, passScore: 51, totalPoints: 100 } }]
    },
  },
  programAnswer: {
    create: async ({ data }: any) => { calls.push(`programAnswer.create:${data.questionId}:${data.aiFeedback || ''}`); answers.push({ ...data }); return data },
    updateMany: async ({ where, data }: any) => {
      calls.push(`programAnswer.updateMany:${where.questionId}:${data.aiFeedback || ''}`)
      const existing = answers.find((answer) => answer.attemptId === where.attemptId && answer.questionId === where.questionId)
      if (existing) Object.assign(existing, data)
      return { count: existing ? 1 : 0 }
    },
  },
  programAssignment: {
    findMany: async () => [{ id: 'assignment-1', title: 'واجب تطبيقي', points: 100 }],
  },
  assignmentSubmission: {
    findUnique: async () => ({ status: 'GRADED', score: 80 }),
    findMany: async () => [],
  },
  payment: { findMany: async () => [] },
  certificate: {
    findFirst: async () => ({ id: 'cert-1', serial: 'AACT-C-1', qrToken: 'qr-1', type: 'PROGRAM_COMPLETION', holderName: 'طالب', program: 'برنامج عربي للاختبار', country: 'فلسطين', issuedAt: new Date(), valid: true, userId: 'user-1', admissionId: 'admission-1', enrollmentId: 'enrollment-1' }),
  },
  admissionApplication: {
    findUnique: async () => ({ userId: 'user-1', programId: 'program-1', email: 'student@example.test', phone: '+970 59 123 4567', user: { email: 'student@example.test', phone: '+970 59 123 4567' } }),
  },
  user: {
    findUnique: async () => ({ id: 'user-1', email: 'student@example.test', phone: '+970 59 123 4567' }),
  },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({ requireUser: async () => ({ id: 'user-1', name: 'طالب', email: 'student@example.test', role: 'STUDENT' }) }))
mock.module('@/lib/essay-grading', () => ({ gradeEssayWithRubric: async () => { calls.push('essay.grade'); throw new Error('AI_DOWN') } }))
mock.module('@/lib/ai', () => ({ generateOverallFeedback: async () => ({ summary: '', strengths: [], improvements: [] }) }))
mock.module('@/lib/enrollment-completion', () => ({ completeEnrollmentIfEligible: async () => null }))
mock.module('@/lib/text-ai', () => ({ textAiComplete: async () => 'سؤال', textAiCompleteJson: async () => JSON.stringify({}) }))
mock.module('@/lib/notify', () => ({ notify: async () => null, audit: async () => null }))
mock.module('@/lib/storage', () => ({ storeFileBuffer: async () => ({}), storageErrorMessage: () => 'storage error' }))
mock.module('@/lib/supervisor-ai', () => ({ buildSupervisorContext: async () => '', mergeContext: (...parts: string[]) => parts.filter(Boolean).join('\n'), buildSupervisorPersonaBlock: () => '', updateStudentAcademicMemory: async () => null }))
mock.module('@/lib/ai-rate-limits', () => ({ AI_RATE_LIMITS: { defense: {}, defenseRecording: {} }, base64DecodedSize: () => 0, enforceUserAiRateLimit: () => null }))
mock.module('@/lib/thesis-context', () => ({ buildThesisDefenseContextFromDb: async () => '', getThesisDigest: async () => null, summarizeDigestForPrompt: () => '' }))
mock.module('@/lib/thesis-defense-score', () => ({ scoreDefenseBreakdown: () => ({ score: null, needsReview: true }) }))
mock.module('@/lib/rate-limit', () => ({ enforceApiRateLimit: () => null }))
mock.module('@/lib/w3c/certificate-credential', () => ({ certificateCredentialUrl: () => 'https://credential.test', certificateVerificationUrl: () => 'https://verify.test' }))
mock.module('@/lib/program-tracks', () => ({ academicProfileFromRules: () => ({}), buildAcademicProgramProfile: (input: any) => input }))

const examSubmitRoute = await import('../../src/app/api/exam/submit/route')
const defenseRoute = await import('../../src/app/api/defense/route')
const { canPublishUnitExamFromQuestions } = await import('../../src/lib/unit-exam-policy')
const { evaluateProgramCertificateEligibility } = await import('../../src/lib/certificate-eligibility')
const certVerifyRoute = await import('../../src/app/api/certificates/verify/route')

async function body(response: Response) {
  return response.json() as Promise<any>
}

beforeEach(() => {
  calls.splice(0, calls.length)
  answers.splice(0, answers.length)
  defenseMessages.splice(0, defenseMessages.length, { id: 'm1', thesisId: 'thesis-1', role: 'STUDENT', content: 'إجابة محفوظة' })
  thesis = { id: 'thesis-1', userId: 'user-1', title: 'بحث', abstract: 'ملخص', status: 'SCHEDULED', defenseStatus: 'NEEDS_REVIEW', extractionStatus: 'READY', fileStorageKey: 'thesis.pdf', defenseDate: new Date(Date.now() - 60_000), createdAt: new Date() }
})

describe('academic B1 safety', () => {
  test('essay answer is persisted before AI grading and remains saved when grading fails', async () => {
    const res = await examSubmitRoute.POST(new NextRequest('https://academy.test/api/exam/submit', {
      method: 'POST',
      body: JSON.stringify({ examId: 'exam-1', answers: [{ questionId: 'essay-1', answerText: 'إجابة الطالب المقالية' }] }),
      headers: { 'content-type': 'application/json' },
    }))
    const payload = await body(res as any)
    expect(res.status).toBe(202)
    expect(payload.status).toBe('NEEDS_REVIEW')
    expect(calls.indexOf('answer.create:essay-1:{"status":"PENDING_AI_GRADING"}')).toBeLessThan(calls.indexOf('essay.grade'))
    expect(answers[0]).toMatchObject({ questionId: 'essay-1', answerText: 'إجابة الطالب المقالية', isCorrect: null, points: null })
    expect(calls.some((call) => call.startsWith('answer.updateMany:essay-1'))).toBe(true)
  })

  test('NEEDS_REVIEW defense cannot be restarted and existing messages are not deleted', async () => {
    const res = await defenseRoute.POST(new NextRequest('https://academy.test/api/defense', {
      method: 'POST',
      body: JSON.stringify({ action: 'start' }),
      headers: { 'content-type': 'application/json' },
    }))
    const payload = await body(res as any)
    expect(res.status).toBe(409)
    expect(payload.code).toBe('DEFENSE_NEEDS_REVIEW')
    expect(calls).not.toContain('defense.deleteMany')
    expect(defenseMessages).toHaveLength(1)
  })

  test('empty unit exam cannot be published and legacy empty READY unit exams do not block certificate eligibility', async () => {
    expect(canPublishUnitExamFromQuestions([])).toBe(false)
    const eligibility = await evaluateProgramCertificateEligibility({ userId: 'user-1', programId: 'program-1', client: db })
    expect(eligibility.ok).toBe(true)
    expect(eligibility.missing.some((item) => item.includes('اختبار وحدة'))).toBe(false)
  })

  test('certificate verification details expose program exam finalScore instead of raw score', async () => {
    const res = await certVerifyRoute.POST(new NextRequest('https://academy.test/api/certificates/verify', {
      method: 'POST',
      body: JSON.stringify({ serial: 'AACT-C-1', email: 'student@example.test', phoneLast4: '4567' }),
      headers: { 'content-type': 'application/json' },
    }))
    const payload = await body(res as any)
    expect(res.status).toBe(200)
    const exam = payload.certificate.academicRecord.comprehensiveExams[0]
    expect(exam.score).toBe(88)
    expect(exam.rawScore).toBe(72)
  })
})
