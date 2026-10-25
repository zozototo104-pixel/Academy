/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

// ===== حالة الاختبار القابلة للتبديل =====
let currentUser: any = { id: 'sup-1', role: 'SUPERVISOR', name: 'المشرف' }
let admissionSupervisorId: string | null = 'sup-1'
let textAiResponse = ''
let extractedText: string | null = 'نص إجابة الطالب المكتوب في الملف المرفق بشكل واضح ومفصل.'
const updateCalls: any[] = []
const notifyCalls: any[] = []
const emailCalls: any[] = []
const auditCalls: any[] = []
let textAiCalls = 0

const submission: any = {
  id: 'sub-1',
  userId: 'student-1',
  answerText: 'إجابة الطالب النصية: تحليل لعملية الاستقطاب مع أمثلة من سوق العمل المحلي.',
  fileName: null,
  fileStorageKey: null,
  fileUrl: null,
  data: null,
  fileStorageProvider: null,
  mimeType: null,
  status: 'SUBMITTED',
  score: null,
  feedback: null,
  submittedAt: new Date(),
  assignment: {
    id: 'assign-1',
    programId: 'prog-1',
    unitId: null,
    title: 'التكليف الثاني',
    description: 'صمّم خطة عملية للبحث عن الكفاءات.',
    semester: 1,
    points: 100,
    rubric: 'الاستناد إلى مصادر الوحدة 30%، جودة التحليل 30%، التطبيق المهني 25%، وضوح العرض 15%',
  },
  user: { id: 'student-1', name: 'محمود', email: 'student@example.com' },
}

const db: any = {
  assignmentSubmission: {
    findUnique: async () => submission,
    update: async (_args: any) => {
      updateCalls.push(_args)
      return { ...submission, score: _args.data.score, feedback: _args.data.feedback, status: _args.data.status }
    },
  },
  admissionApplication: {
    findFirst: async () => ({ id: 'app-1', supervisorId: admissionSupervisorId, supervisionMode: 'HYBRID' }),
  },
  unit: {
    findUnique: async () => null,
    findMany: async () => [],
  },
  bookChunk: { findMany: async () => [] },
  bookKnowledgeItem: { findMany: async () => [] },
  book: { findUnique: async () => null },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({
  requireUser: async () => currentUser,
  requireAdmin: async () => {
    throw new Error('UNAUTHORIZED')
  },
}))
mock.module('@/lib/text-ai', () => ({
  textAiCompleteJson: async () => {
    textAiCalls += 1
    return textAiResponse
  },
}))
mock.module('@/lib/document-extract', () => ({
  extractDocumentText: async () => ({
    text: extractedText || '',
    readable: Boolean(extractedText && extractedText.length >= 40),
    reader: 'PDF',
    note: '',
  }),
  isPdfLike: () => true,
}))
mock.module('@/lib/storage', () => ({
  getFileBufferFromStorageOrBase64: async () => null,
  getStorageDownloadPathForKey: (key: string) => `/api/files/${key}`,
}))
mock.module('@/lib/notify', () => ({
  notify: async (...args: any[]) => {
    notifyCalls.push(args)
  },
  audit: async (...args: any[]) => {
    auditCalls.push(args)
  },
}))
mock.module('@/lib/mailer', () => ({
  emailAssignmentGraded: async (...args: any[]) => {
    emailCalls.push(args)
  },
}))

const validDraft = () =>
  JSON.stringify({
    score: 85,
    criteria: [
      { label: 'الاستناد إلى مصادر الوحدة', points: 25, justification: 'استند إلى مصادر الوحدة مع أمثلة.' },
      { label: 'جودة التحليل', points: 25, justification: 'تحليل متماسك ومرتب.' },
      { label: 'التطبيق المهني', points: 20, justification: 'تطبيق عملي جيد مع نقص في التفاصيل.' },
      { label: 'وضوح العرض', points: 15, justification: 'عرض واضح ومنظم.' },
    ],
    strengths: ['تحليل واضح', 'أمثلة من الواقع'],
    gaps: ['ينقصه تفصيل خطوات التنفيذ'],
    errors: [],
    effortNote: 'يظهر اجتهاد شخصي في التحليل والتطبيق.',
    feedback: 'أحسنت يا محمود، تحليلك واضح وتطبيقك المهني جيد مع أمثلة من الواقع. ينقصك تفصيل خطوات التنفيذ أكثر، وربط كل خطوة بمصدر من الوحدة. خطوتك التالية: أعد صياغة خطة التنفيذ بجدول زمني واضح.',
  })

function postRequest(body: any) {
  return new NextRequest('http://localhost/api/supervisor/assignments', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}

describe('supervisor assignment grading — rubric and draft normalization', () => {
  test('screenshot rubric parses to 30/30/25/15', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    const criteria = lib.parseRubricCriteria('الاستناد إلى مصادر الوحدة 30%، جودة التحليل 30%، التطبيق المهني 25%، وضوح العرض 15%')
    expect(criteria.map((c: any) => c.weightPct)).toEqual([30, 30, 25, 15])
  })

  test('missing or non-summing rubric falls back to the default', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    expect(lib.parseRubricCriteria(null).map((c: any) => c.weightPct)).toEqual([30, 30, 25, 15])
    expect(lib.parseRubricCriteria('تحليل 40%، عرض 20%').map((c: any) => c.weightPct)).toEqual([30, 30, 25, 15])
  })

  test('valid per-criterion breakdown is kept', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    const draft = lib.normalizeAiDraft(JSON.parse(validDraft()), 100, lib.DEFAULT_RUBRIC)
    expect(draft?.score).toBe(85)
    expect(draft?.criteria?.length).toBe(4)
    expect(draft?.criteria?.reduce((t: number, c: any) => t + c.points, 0)).toBe(85)
  })

  test('breakdown that does not sum to the total is discarded, total kept', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    const raw = JSON.parse(validDraft())
    raw.criteria[0].points = 10
    const draft = lib.normalizeAiDraft(raw, 100, lib.DEFAULT_RUBRIC)
    expect(draft?.score).toBe(85)
    expect(draft?.criteria).toBeNull()
  })

  test('score above assignment points is clamped, short feedback rejected', async () => {
    const lib = await import('@/lib/supervisor-assignment-grading')
    const raw = JSON.parse(validDraft())
    raw.score = 140
    expect(lib.normalizeAiDraft(raw, 100, lib.DEFAULT_RUBRIC)?.score).toBe(100)
    raw.score = 80
    raw.feedback = 'جيد'
    expect(lib.normalizeAiDraft(raw, 100, lib.DEFAULT_RUBRIC)).toBeNull()
  })
})

describe('supervisor assignments route — scope is the gate, analyze never saves', () => {
  beforeEach(() => {
    currentUser = { id: 'sup-1', role: 'SUPERVISOR', name: 'المشرف' }
    admissionSupervisorId = 'sup-1'
    textAiResponse = validDraft()
    textAiCalls = 0
    updateCalls.length = 0
    notifyCalls.length = 0
    emailCalls.length = 0
    auditCalls.length = 0
  })

  test('assigned supervisor analyzes: draft returned, no DB update, no student notification', async () => {
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.saved).toBe(false)
    expect(body.draft.score).toBe(85)
    expect(body.draft.feedback).toContain('أحسنت يا محمود')
    expect(updateCalls.length).toBe(0)
    expect(notifyCalls.length).toBe(0)
    expect(emailCalls.length).toBe(0)
    expect(textAiCalls).toBe(1)
  })

  test('supervisor who is not assigned to this student gets 403 and no AI call', async () => {
    admissionSupervisorId = 'sup-OTHER'
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(postRequest({ action: 'analyze', submissionId: 'sub-1' }))
    expect(res.status).toBe(403)
    expect(textAiCalls).toBe(0)
    expect(updateCalls.length).toBe(0)
  })

  test('admin override analyzes and grades, grade notifies and emails the student', async () => {
    currentUser = { id: 'admin-1', role: 'ADMIN', name: 'المدير' }
    admissionSupervisorId = null
    const route = await import('@/app/api/supervisor/assignments/route')
    const graded = await route.POST(
      postRequest({ action: 'grade', submissionId: 'sub-1', score: 80, feedback: 'ملاحظة مفصلة للطالب بعد المراجعة.', status: 'GRADED' })
    )
    expect(graded.status).toBe(200)
    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0].data.score).toBe(80)
    expect(notifyCalls.length).toBe(1)
    expect(emailCalls.length).toBe(1)
    expect(auditCalls.length).toBe(1)
  })

  test('grade above assignment points is rejected without saving', async () => {
    const route = await import('@/app/api/supervisor/assignments/route')
    const res = await route.POST(
      postRequest({ action: 'grade', submissionId: 'sub-1', score: 150, feedback: 'ملاحظة مفصلة للطالب بعد المراجعة.', status: 'GRADED' })
    )
    expect(res.status).toBe(400)
    expect(updateCalls.length).toBe(0)
  })
})
