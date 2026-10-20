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
    findUnique: async () => ({ userId: 'user-1', programId: 'program-1', email: 'student@example.test', phone: '+970 59 123 4567', scholarshipFull: false, user: { email: 'student@example.test', phone: '+970 59 123 4567' } }),
    findFirst: async () => ({ userId: 'user-1', programId: 'program-1', scholarshipFull: false }),
  },
  user: {
    findUnique: async () => ({ id: 'user-1', email: 'student@example.test', phone: '+970 59 123 4567' }),
  },
}

mock.module('@/lib/db', () => ({ db }))

const realAuth = await import('../../src/lib/auth')
mock.module('@/lib/auth', () => ({ ...realAuth, requireUser: async () => ({ id: 'user-1', name: 'طالب', email: 'student@example.test', role: 'STUDENT' }) }))

const realEssayGrading = await import('../../src/lib/essay-grading')
mock.module('@/lib/essay-grading', () => ({ ...realEssayGrading, gradeEssayWithRubric: async () => { calls.push('essay.grade'); throw new Error('AI_DOWN') } }))

const realAi = await import('../../src/lib/ai')
mock.module('@/lib/ai', () => ({ ...realAi, generateOverallFeedback: async () => ({ summary: '', strengths: [], improvements: [] }) }))

const realEnrollmentCompletion = await import('../../src/lib/enrollment-completion')
mock.module('@/lib/enrollment-completion', () => ({ ...realEnrollmentCompletion, completeEnrollmentIfEligible: async () => null }))

const realSemesterReadiness = await import('../../src/lib/semester-readiness')
mock.module('@/lib/semester-readiness', () => ({ ...realSemesterReadiness, calculateSemesterReadiness: async () => ({ readyMarked: true, maxExamScore: 100, missing: [] }) }))

const realTuitionInstallments = await import('../../src/lib/tuition-installments')
mock.module('@/lib/tuition-installments', () => ({
  ...realTuitionInstallments,
  enforceSemesterTuitionGate: async () => ({ ok: true }),
  TUITION_PURPOSES: ['TUITION', 'TUITION_INSTALLMENT'],
  inferTotalTuition: () => 0,
  roundMoney: (value: number) => Math.round(value * 100) / 100,
  tuitionPaidTotal: () => 0,
}))

const realTextAi = await import('../../src/lib/text-ai')
mock.module('@/lib/text-ai', () => ({ ...realTextAi, textAiComplete: async () => 'سؤال', textAiCompleteJson: async () => JSON.stringify({}) }))

const realNotify = await import('../../src/lib/notify')
mock.module('@/lib/notify', () => ({ ...realNotify, notify: async () => null, audit: async () => null }))

const realStorage = await import('../../src/lib/storage')
mock.module('@/lib/storage', () => ({ ...realStorage, storeFileBuffer: async () => ({}), storageErrorMessage: () => 'storage error' }))

const realSupervisorAi = await import('../../src/lib/supervisor-ai')
mock.module('@/lib/supervisor-ai', () => ({ ...realSupervisorAi, buildSupervisorContext: async () => '', mergeContext: (...parts: string[]) => parts.filter(Boolean).join('\n'), buildSupervisorPersonaBlock: () => '', updateStudentAcademicMemory: async () => null }))

const realAiRateLimits = await import('../../src/lib/ai-rate-limits')
mock.module('@/lib/ai-rate-limits', () => ({ ...realAiRateLimits, AI_RATE_LIMITS: { defense: {}, defenseRecording: {} }, base64DecodedSize: () => 0, enforceUserAiRateLimit: () => null }))

const realThesisContext = await import('../../src/lib/thesis-context')
mock.module('@/lib/thesis-context', () => ({ ...realThesisContext, buildThesisDefenseContextFromDb: async () => '', getThesisDigest: async () => null, summarizeDigestForPrompt: () => '' }))

const realThesisDefenseScore = await import('../../src/lib/thesis-defense-score')
mock.module('@/lib/thesis-defense-score', () => ({ ...realThesisDefenseScore, scoreDefenseBreakdown: () => ({ score: null, needsReview: true }) }))

const realRateLimit = await import('../../src/lib/rate-limit')
mock.module('@/lib/rate-limit', () => ({ ...realRateLimit, enforceApiRateLimit: () => null, enforceDatabaseApiRateLimit: async () => null, checkDatabaseRateLimit: async () => ({ ok: true, remaining: 99, resetAt: Date.now() + 60000, retryAfterSec: 0 }) }))

const realCertificateCredential = await import('../../src/lib/w3c/certificate-credential')
mock.module('@/lib/w3c/certificate-credential', () => ({ ...realCertificateCredential, certificateCredentialUrl: () => 'https://credential.test', certificateVerificationUrl: () => 'https://verify.test' }))

const realProgramTracks = await import('../../src/lib/program-tracks')
mock.module('@/lib/program-tracks', () => ({ ...realProgramTracks, academicProfileFromRules: () => ({}), buildAcademicProgramProfile: (input: any) => input }))

const examSubmitRoute = await import('../../src/app/api/exam/submit/route')
const programExamSubmitRoute = await import('../../src/app/api/program-exam/submit/route')
const defenseRoute = await import('../../src/app/api/defense/route')
const { canPublishUnitExamFromQuestions } = await import('../../src/lib/unit-exam-policy')
const { calculateFinalGrade } = await import('../../src/lib/final-grade')
const { certificateGradeLabelEn, evaluateProgramCertificateEligibility } = await import('../../src/lib/certificate-eligibility')
const { completeEnrollmentIfEligibleInTransaction } = await import('../../src/lib/enrollment-completion')
const { stampValue } = await import('../../src/lib/legacy-certificate-files')
const certVerifyRoute = await import('../../src/app/api/certificates/verify/route')

async function body(response: Response) {
  return response.json() as Promise<any>
}

function completionTx(options: { payments: any[]; scholarshipFull?: boolean; fullNameEn?: string | null }) {
  let createdCertificate: any = null
  const tx: any = {
    $queryRaw: async () => [{ value: 1 }],
    admissionApplication: {
      findUnique: async () => ({ id: 'admission-1', userId: 'user-1', programId: 'program-1', fullName: 'طالب عربي', fullNameEn: options.fullNameEn || null, program: 'برنامج عربي للاختبار', country: 'فلسطين', email: 'student@example.test', status: 'RESULT_APPROVED', scholarshipFull: options.scholarshipFull === true }),
      findFirst: async () => ({ id: 'admission-1', userId: 'user-1', programId: 'program-1', fullName: 'طالب عربي', fullNameEn: options.fullNameEn || null, program: 'برنامج عربي للاختبار', country: 'فلسطين', email: 'student@example.test', status: 'RESULT_APPROVED', scholarshipFull: options.scholarshipFull === true }),
      update: async ({ data }: any) => ({ id: 'admission-1', ...data }),
    },
    enrollment: {
      findUnique: async () => ({ id: 'enrollment-1', userId: 'user-1', programId: 'program-1', status: 'ACTIVE', certificateNo: null }),
      update: async ({ data }: any) => ({ id: 'enrollment-1', ...data }),
    },
    program: {
      findUnique: async () => ({ id: 'program-1', titleAr: 'برنامج عربي للاختبار', titleEn: 'Arabic Test Program', price: 1000, category: 'DIPLOMA' }),
    },
    payment: { findMany: async () => options.payments },
    certificate: {
      findFirst: async () => null,
      create: async ({ data }: any) => { createdCertificate = { id: 'cert-new', ...data }; return createdCertificate },
    },
    exam: { findMany: async () => [{ id: 'unit-empty', title: 'اختبار فارغ', passScore: 51, unit: { title: 'وحدة' }, _count: { questions: 0 } }] },
    examAttempt: { findMany: async () => [] },
    programExam: { findMany: async () => [{ id: 'program-exam-1', title: 'اختبار نهائي', semester: 1, passScore: 51 }] },
    programExamAttempt: { findMany: async () => [{ score: 95, finalScore: 95, appealStatus: 'REVIEWED', passed: true, answers: [{ points: 95, maxPoints: 100 }] }] },
    programAssignment: { findMany: async () => [{ id: 'assignment-1', title: 'واجب', points: 100 }] },
    assignmentSubmission: { findUnique: async () => ({ status: 'GRADED', score: 95 }) },
    thesisSubmission: { findFirst: async () => null },
  }
  return { tx, certificate: () => createdCertificate }
}

async function completionResult(options: { payments: any[]; scholarshipFull?: boolean; fullNameEn?: string | null }) {
  const ctx = completionTx(options)
  const result = await completeEnrollmentIfEligibleInTransaction(ctx.tx, { enrollmentId: 'enrollment-1', admissionId: 'admission-1' })
  return { result, certificate: ctx.certificate() }
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

  test('program exam essay answer is persisted before AI grading and remains saved when grading fails', async () => {
    const res = await programExamSubmitRoute.POST(new NextRequest('https://academy.test/api/program-exam/submit', {
      method: 'POST',
      body: JSON.stringify({ examId: 'program-exam-1', answers: [{ questionId: 'program-essay-1', answerText: 'إجابة برنامج مقالية' }] }),
      headers: { 'content-type': 'application/json' },
    }))
    const payload = await body(res as any)
    expect(res.status).toBe(202)
    expect(payload.status).toBe('NEEDS_REVIEW')
    expect(calls.indexOf('programAnswer.create:program-essay-1:{"status":"PENDING_AI_GRADING"}')).toBeLessThan(calls.indexOf('essay.grade'))
    expect(answers[0]).toMatchObject({ questionId: 'program-essay-1', answerText: 'إجابة برنامج مقالية', isCorrect: null, points: null })
    expect(calls).toContain('programAttempt.update:NEEDS_REVIEW')
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

  test('empty unit exam cannot be published and legacy empty READY unit exams do not block certificate eligibility or inflate the grade', async () => {
    expect(canPublishUnitExamFromQuestions([])).toBe(false)
    const finalGrade = await calculateFinalGrade({ userId: 'user-1', programId: 'program-1', client: db })
    expect(finalGrade.score).toBe(86)
    expect(finalGrade.components.find((component) => component.key === 'quizzes')).toMatchObject({ exempt: true, weighted: 0 })
    const eligibility = await evaluateProgramCertificateEligibility({ userId: 'user-1', programId: 'program-1', client: db })
    expect(eligibility.ok).toBe(true)
    expect(eligibility.score).toBe(86)
    expect(eligibility.missing.some((item) => item.includes('اختبار وحدة'))).toBe(false)
  })

  test('certificate issuance finance rules match tuition gate cases', async () => {
    expect((await completionResult({ payments: [] })).result.ok).toBe(true)
    expect((await completionResult({ payments: [], scholarshipFull: true })).result.ok).toBe(true)
    expect((await completionResult({ scholarshipFull: true, payments: [{ purpose: 'APPLICATION_FEE', status: 'UNPAID', amount: 30 }] })).result.ok).toBe(true)

    const halfPaid = await completionResult({ payments: [{ purpose: 'TUITION', status: 'PAID', amount: 500, originalAmount: 1000 }] })
    expect(halfPaid.result.ok).toBe(false)
    expect(halfPaid.result.code).toBe('PAYMENT_REQUIRED')

    const unpaidSeat = await completionResult({ payments: [
      { purpose: 'APPLICATION_FEE', status: 'UNPAID', amount: 30 },
      { purpose: 'TUITION', status: 'PAID', amount: 1000, originalAmount: 1000 },
    ] })
    expect(unpaidSeat.result.ok).toBe(false)
    expect(unpaidSeat.result.code).toBe('PAYMENT_REQUIRED')

    const fullyPaid = await completionResult({ payments: [
      { purpose: 'APPLICATION_FEE', status: 'PAID', amount: 30 },
      { purpose: 'TUITION', status: 'PAID', amount: 1000, originalAmount: 1000 },
    ] })
    expect(fullyPaid.result.ok).toBe(true)
  })

  test('certificate English labels and admission English name are used on issuance', async () => {
    expect(certificateGradeLabelEn(95)).toBe('Excellent')
    const issued = await completionResult({ payments: [], fullNameEn: 'John Smith' })
    expect(issued.result.ok).toBe(true)
    expect(issued.certificate.holderNameEn).toBe('John Smith')
    expect(issued.certificate.gradeEn).toBe('Excellent')
  })

  test('English stamp grade falls back from known Arabic grade label', () => {
    expect(stampValue('grade', { x: 50, y: 50, width: 40, fontSize: 2, lang: 'en' }, { grade: 'امتياز' })).toBe('Excellent')
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
