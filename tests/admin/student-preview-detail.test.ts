/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

// Guard: the admin student preview is the owner's "everything about the
// student + what's left" view (2026-11-05). It must carry, per active
// enrollment: the cumulative average from the REAL grade engine (never a
// hand-rolled formula), a per-unit row with the unit's exam result and
// derived state, a what's-left list, the two correspondence payloads
// (AI supervisor + administration) in read-only shape, the pending-review
// split (NEEDS_REVIEW vs PENDING appeals — never merged), and the absence
// status from the SAME computeFollowUpStatus the duties board uses.

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.now()
const daysAgo = (n: number) => new Date(NOW - n * DAY)

let fx: any

function baseFx() {
  return {
    student: {
      id: 'stu-1', name: 'طالب الاختبار', email: 'student@example.com', phone: '+970599000000',
      country: 'فلسطين', role: 'STUDENT', status: 'ACTIVE', createdAt: daysAgo(60), lastActivityAt: daysAgo(0), academicMemory: null,
    },
    admissions: [] as any[],
    enrollments: [{
      id: 'enr-1', status: 'ACTIVE', completedUnits: '[]', finalScore: null, certificateNo: null,
      extensionDays: 0, followUpCount: 0, createdAt: daysAgo(10), updatedAt: daysAgo(1),
      program: { id: 'p1', titleAr: 'دبلوم إدارة الموارد البشرية', category: 'DIPLOMA', hours: 120, price: 500, maxStudyDays: 90, _count: { units: 3, books: 1, programExams: 1 } },
    }],
    enrollmentSingle: { id: 'enr-1', createdAt: daysAgo(10), status: 'ACTIVE', finalScore: null },
    programSingle: { category: 'DIPLOMA', admissionRules: null },
    units: [
      { id: 'u1', title: 'الوحدة الأولى', semester: 1, order: 0, programId: 'p1', exam: { id: 'e1', title: 'اختبار الوحدة الأولى', passScore: 60, status: 'READY' } },
      { id: 'u2', title: 'الوحدة الثانية', semester: 1, order: 1, programId: 'p1', exam: { id: 'e2', title: 'اختبار الوحدة الثانية', passScore: 60, status: 'READY' } },
      { id: 'u3', title: 'الوحدة الثالثة', semester: 1, order: 2, programId: 'p1', exam: { id: 'e3', title: 'اختبار الوحدة الثالثة', passScore: 60, status: 'READY' } },
    ],
    engineExams: [
      { id: 'e1', title: 'اختبار الوحدة الأولى', passScore: 60, unit: { title: 'الوحدة الأولى' }, _count: { questions: 5 } },
      { id: 'e2', title: 'اختبار الوحدة الثانية', passScore: 60, unit: { title: 'الوحدة الثانية' }, _count: { questions: 5 } },
      { id: 'e3', title: 'اختبار الوحدة الثالثة', passScore: 60, unit: { title: 'الوحدة الثالثة' }, _count: { questions: 5 } },
    ],
    unitAttemptsAll: [] as any[],
    unitAttemptsList: [] as any[],
    programExams: [{ id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, passScore: 60, status: 'READY', programId: 'p1' }],
    programAttemptsAll: [] as any[],
    programAttemptsList: [] as any[],
    publishedAssignments: [
      { id: 'as1', title: 'واجب الوحدة الأولى', semester: 1, programId: 'p1', points: 100, weight: 10 },
      { id: 'as2', title: 'واجب الوحدة الثانية', semester: 1, programId: 'p1', points: 100, weight: 0 },
    ],
    detailSubmissions: [] as any[],
    submissionsList: [] as any[],
    submissionByAssignment: {} as Record<string, any>,
    unitVideos: [{ id: 'v1', unitId: 'u1' }],
    watchRows: [] as any[],
    chatsDesc: [] as any[],
    adminMessages: [] as any[],
  }
}

function activeFx() {
  const f = baseFx()
  f.student.lastActivityAt = daysAgo(6)
  f.enrollments[0].followUpCount = 3
  f.unitAttemptsAll = [
    { id: 'a1', examId: 'e1', score: 80, passed: true, status: 'GRADED', appealStatus: 'NONE', answers: [], submittedAt: daysAgo(2), createdAt: daysAgo(2) },
    { id: 'a2', examId: 'e1', score: 40, passed: false, status: 'GRADED', appealStatus: 'NONE', answers: [], submittedAt: daysAgo(3), createdAt: daysAgo(3) },
    { id: 'a3', examId: 'e2', score: null, passed: null, status: 'NEEDS_REVIEW', appealStatus: 'NONE', answers: [], submittedAt: daysAgo(1), createdAt: daysAgo(1) },
  ]
  f.unitAttemptsList = [
    { id: 'a1', score: 80, passed: true, status: 'GRADED', appealStatus: 'NONE', submittedAt: daysAgo(2), createdAt: daysAgo(2), exam: { id: 'e1', title: 'اختبار الوحدة الأولى', unit: { title: 'الوحدة الأولى', program: { id: 'p1', titleAr: 'دبلوم إدارة الموارد البشرية' } } } },
    { id: 'a3', score: null, passed: null, status: 'NEEDS_REVIEW', appealStatus: 'NONE', submittedAt: daysAgo(1), createdAt: daysAgo(1), exam: { id: 'e2', title: 'اختبار الوحدة الثانية', unit: { title: 'الوحدة الثانية', program: { id: 'p1', titleAr: 'دبلوم إدارة الموارد البشرية' } } } },
  ]
  f.programAttemptsAll = [
    { id: 'pa1', examId: 'pe1', score: 70, finalScore: 70, passed: true, status: 'GRADED', feedback: null, appealStatus: 'NONE', answers: [] },
    { id: 'pa2', examId: 'pe1', score: 55, finalScore: 55, passed: false, status: 'GRADED', feedback: null, appealStatus: 'PENDING', answers: [] },
  ]
  f.programAttemptsList = [
    { id: 'pa1', score: 70, finalScore: 70, passed: true, status: 'GRADED', appealStatus: 'NONE', appealReason: null, durationUsedMin: 30, submittedAt: daysAgo(2), createdAt: daysAgo(2), exam: { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, program: { id: 'p1', titleAr: 'دبلوم إدارة الموارد البشرية', category: 'DIPLOMA' } } },
    { id: 'pa2', score: 55, finalScore: 55, passed: false, status: 'GRADED', appealStatus: 'PENDING', appealReason: 'أعتقد أن الدرجة غير صحيحة', durationUsedMin: 25, submittedAt: daysAgo(1), createdAt: daysAgo(1), exam: { id: 'pe1', title: 'امتحان الفصل الأول', semester: 1, program: { id: 'p1', titleAr: 'دبلوم إدارة الموارد البشرية', category: 'DIPLOMA' } } },
  ]
  f.detailSubmissions = [{ id: 'sub1', status: 'GRADED', score: 90, assignmentId: 'as1' }]
  f.submissionsList = [
    { id: 'sub1', status: 'GRADED', score: 90, feedback: null, fileName: 'w.pdf', submittedAt: daysAgo(2), gradedAt: daysAgo(1), assignment: { id: 'as1', title: 'واجب الوحدة الأولى', semester: 1, type: 'HOMEWORK', points: 100, program: { id: 'p1', titleAr: 'دبلوم إدارة الموارد البشرية' } } },
  ]
  f.submissionByAssignment = { as1: { status: 'GRADED', score: 90 } }
  f.watchRows = [{ watchedPercent: 100, completedAt: daysAgo(2), video: { unitId: 'u1' } }]
  f.chatsDesc = [
    { id: 'm2', role: 'assistant', mode: 'TEXT', kind: null, content: 'رد المشرف الذكي', createdAt: daysAgo(1) },
    { id: 'm1', role: 'user', mode: 'TEXT', kind: null, content: 'سؤال الطالب', createdAt: daysAgo(2) },
  ]
  f.adminMessages = [
    { id: 'am1', senderRole: 'STUDENT', senderId: 'stu-1', mode: 'TEXT', content: 'رسالة إلى الإدارة', createdAt: daysAgo(2) },
    { id: 'am2', senderRole: 'ADMIN', senderId: 'admin-1', mode: 'TEXT', content: 'رد الإدارة', createdAt: daysAgo(1) },
  ]
  return f
}

const db: any = {
  user: { findUnique: async () => fx.student },
  admissionApplication: { findMany: async () => fx.admissions },
  enrollment: {
    findMany: async () => fx.enrollments,
    findUnique: async () => fx.enrollmentSingle,
  },
  program: { findUnique: async () => fx.programSingle },
  unit: { findMany: async () => fx.units },
  exam: { findMany: async () => fx.engineExams },
  examAttempt: {
    findMany: async (args: any) => {
      if (args?.where?.examId) return fx.unitAttemptsAll.filter((a: any) => a.examId === args.where.examId && (!args.where.status || a.status === args.where.status))
      if (args?.where?.exam) return fx.unitAttemptsAll
      return fx.unitAttemptsList
    },
  },
  programExam: { findMany: async () => fx.programExams },
  programExamAttempt: {
    findMany: async (args: any) => {
      if (args?.where?.examId) return fx.programAttemptsAll.filter((a: any) => a.examId === args.where.examId)
      if (args?.where?.exam) return fx.programAttemptsAll
      return fx.programAttemptsList
    },
  },
  programAssignment: { findMany: async () => fx.publishedAssignments },
  assignmentSubmission: {
    findMany: async (args: any) => (args?.where?.assignment ? fx.detailSubmissions : fx.submissionsList),
    findUnique: async (args: any) => fx.submissionByAssignment[args?.where?.assignmentId_userId?.assignmentId] ?? null,
  },
  thesisSubmission: { findMany: async () => [], findFirst: async () => null },
  payment: { findMany: async () => [] },
  certificate: { findMany: async () => [] },
  userMicroCredential: { findMany: async () => [] },
  chatMessage: { findMany: async () => fx.chatsDesc, count: async () => fx.chatsDesc.length },
  supervisorChannelMessage: { findMany: async () => fx.adminMessages },
  lectureVideoResource: { findMany: async () => fx.unitVideos },
  lectureWatchProgress: { findMany: async () => fx.watchRows },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/auth', () => ({ requireAdmin: async () => ({ id: 'admin-1', role: 'ADMIN' }) }))
mock.module('@/lib/notify', () => ({ notify: async () => ({}), notifyAdmins: async () => ({}), audit: async () => ({}) }))
mock.module('@/lib/mailer', () => ({ sendEmail: async () => true, emailTemplate: () => '' }))
mock.module('@/lib/whatsapp-cloud', () => ({ officialWhatsAppConfigured: () => false, sendOfficialWhatsAppHumanFollowup: async () => ({}), sendOfficialWhatsAppText: async () => ({}) }))
mock.module('@/lib/whatsapp-conversations', () => ({ hashWhatsAppId: (x: string) => x, recordWhatsAppOutboundMessage: async () => ({}) }))

const { GET } = await import('../../src/app/api/admin/students/preview/route')

async function getPreview() {
  const res = await GET(new NextRequest('http://localhost/api/admin/students/preview?studentId=stu-1'))
  return { status: res.status, body: await res.json() }
}

beforeEach(() => { fx = activeFx() })

describe('admin student preview — detail payload', () => {
  test('per-unit rows carry the exam result + state, and the cumulative average comes from the grade engine', async () => {
    const { status, body } = await getPreview()
    expect(status).toBe(200)
    expect(body.previewMode).toBe('ADMIN_READ_ONLY')
    expect(body.enrollmentDetails).toHaveLength(1)
    const detail = body.enrollmentDetails[0]
    expect(detail.programTitle).toBe('دبلوم إدارة الموارد البشرية')

    // Cumulative: engine-computed. Work remains, so the final score is null
    // but the earned progress is real: quizzes avg(80,0,0)=26.67×20% +
    // assignments 90×20% + final exam 70×60% ≈ 65.33.
    expect(detail.cumulative).not.toBeNull()
    expect(detail.cumulative.score).toBeNull()
    expect(detail.cumulative.progressScore).toBeCloseTo(65.33, 1)
    expect(detail.cumulative.components.map((c: any) => c.key)).toEqual(['quizzes', 'assignments', 'final_exam'])

    const [u1, u2, u3] = detail.units
    expect(u1.bestScore).toBe(80)
    expect(u1.passed).toBe(true)
    expect(u1.attemptsCount).toBe(2)
    expect(u1.state).toBe('COMPLETED')
    expect(u1.watch).toBe('COMPLETED')
    // Unit 2: a single NEEDS_REVIEW attempt — engaged, ungraded, not passed.
    expect(u2.bestScore).toBeNull()
    expect(u2.passed).toBe(false)
    expect(u2.attemptsCount).toBe(1)
    expect(u2.state).toBe('IN_PROGRESS')
    expect(u2.watch).toBeNull()
    expect(u3.attemptsCount).toBe(0)
    expect(u3.state).toBe('NOT_STARTED')

    expect(detail.counts.unitsCompleted).toBe(1)
    expect(detail.counts.assignmentsSubmitted).toBe(1)
    expect(detail.remaining.unitExamsNotPassed).toEqual(['الوحدة الثانية', 'الوحدة الثالثة'])
    expect(detail.remaining.unitsNotCompleted).toEqual(['الوحدة الثانية', 'الوحدة الثالثة'])
    expect(detail.remaining.assignmentsNotSubmitted).toEqual(['واجب الوحدة الثانية'])
    expect(detail.remaining.programExamsNotPassed).toEqual([])
    expect(detail.remaining.daysLeft).toBeGreaterThanOrEqual(79)
    expect(detail.remaining.daysLeft).toBeLessThanOrEqual(80)

    expect(body.overview.examsSat).toBe(4)
    expect(body.overview.assignmentsSolved).toBe(1)
    expect(body.overview.assignmentsPublishedTotal).toBe(2)
  })

  test('urgent signals follow the latest admission analysis, not historical supervisor memory', async () => {
    fx = baseFx()
    const oldFinding = 'الهوية غير متحقق منها'
    fx.student.academicMemory = {
      weaknesses: JSON.stringify([oldFinding]),
      strengths: '[]', conceptsToReview: '[]', recommendedNextActions: '[]',
    }
    fx.admissions = [{
      id: 'ad-1', reference: 'AACT-1', status: 'UNDER_REVIEW',
      aiVerdict: 'NEEDS_CLARIFICATION', aiReviewedAt: daysAgo(1),
      aiReview: JSON.stringify({
        verdict: 'NEEDS_CLARIFICATION',
        findings: [{ severity: 'HIGH', title: oldFinding, detail: 'يلزم تدقيق الهوية' }],
      }),
    }]
    const first = await getPreview()
    expect(first.status).toBe(200)
    expect(first.body.overview.atRiskSignals.join(' ')).toContain(oldFinding)

    // The same admission is re-analyzed with no current findings.
    fx.admissions[0].aiVerdict = 'RECOMMEND_APPROVE'
    fx.admissions[0].aiReviewedAt = new Date()
    fx.admissions[0].aiReview = JSON.stringify({
      verdict: 'RECOMMEND_APPROVE', findings: [], strengths: ['الوثائق مطابقة'],
    })
    const second = await getPreview()
    expect(second.status).toBe(200)
    expect(second.body.overview.atRiskSignals).toEqual([])
    // Academic history stays available but does not produce active alerts.
    expect(second.body.student.academicMemory.weaknesses).toContain(oldFinding)
    expect(second.body.admissions[0].aiReview).toBeUndefined()
  })

  test('current unresolved admission findings remain actionable and tied to an application', async () => {
    fx = baseFx()
    fx.admissions = [{
      id: 'ad-2', reference: 'AACT-2', status: 'UNDER_REVIEW',
      aiVerdict: 'NEEDS_CLARIFICATION', aiReviewedAt: new Date(),
      aiReview: JSON.stringify({ verdict: 'NEEDS_CLARIFICATION',
        findings: [{ severity: 'HIGH', title: 'الشهادة غير واضحة', detail: 'يلزم صورة أوضح' }] }),
    }]
    const { status, body } = await getPreview()
    expect(status).toBe(200)
    expect(body.overview.atRiskSignals.join(' ')).toContain('AACT-2')
    expect(body.overview.atRiskSignals.join(' ')).toContain('الشهادة غير واضحة')
  })

  test('pending review: NEEDS_REVIEW and PENDING appeals are exposed distinctly, never merged', async () => {
    const { body } = await getPreview()
    expect(body.pendingReview.needsReviewCount).toBe(1)
    expect(body.pendingReview.pendingAppealsCount).toBe(1)
    expect(body.pendingReview.items).toHaveLength(2)
    const reviewItem = body.pendingReview.items.find((i: any) => i.attemptId === 'a3')
    expect(reviewItem.kind).toBe('UNIT')
    expect(reviewItem.needsReview).toBe(true)
    expect(reviewItem.appealPending).toBe(false)
    expect(reviewItem.examTitle).toBe('اختبار الوحدة الثانية')
    const appealItem = body.pendingReview.items.find((i: any) => i.attemptId === 'pa2')
    expect(appealItem.kind).toBe('PROGRAM')
    expect(appealItem.needsReview).toBe(false)
    expect(appealItem.appealPending).toBe(true)
  })

  test('absence: 6 days away + episode count 3 → daysAbsent 6 and needsIntervention true (board formula)', async () => {
    const { body } = await getPreview()
    expect(body.absence.daysAbsent).toBe(6)
    expect(body.absence.followUpCount).toBe(3)
    expect(body.absence.needsIntervention).toBe(true)
    expect(body.enrollmentDetails[0].followUp.daysAbsent).toBe(6)
    expect(body.enrollmentDetails[0].followUp.needsIntervention).toBe(true)
  })

  test('zero-activity student active today: units «لم تبدأ», full what-is-left, null (never NaN) average, no pending, no absence alarm', async () => {
    fx = baseFx()
    const { status, body } = await getPreview()
    expect(status).toBe(200)
    const detail = body.enrollmentDetails[0]
    expect(detail.units.map((u: any) => u.state)).toEqual(['NOT_STARTED', 'NOT_STARTED', 'NOT_STARTED'])
    expect(detail.remaining.unitsNotCompleted).toHaveLength(3)
    expect(detail.remaining.unitExamsNotPassed).toHaveLength(3)
    expect(detail.remaining.assignmentsNotSubmitted).toHaveLength(2)
    expect(detail.remaining.programExamsNotPassed).toHaveLength(1)
    expect(detail.cumulative.score).toBeNull()
    expect(detail.cumulative.progressScore).toBe(0)
    expect(Number.isFinite(detail.cumulative.progressScore)).toBe(true)
    expect(JSON.stringify(body)).not.toContain('NaN')
    expect(body.pendingReview.needsReviewCount).toBe(0)
    expect(body.pendingReview.pendingAppealsCount).toBe(0)
    expect(body.pendingReview.items).toEqual([])
    expect(body.absence.daysAbsent).toBe(0)
    expect(body.absence.needsIntervention).toBe(false)
    expect(body.correspondence.aiSupervisor.total).toBe(0)
    expect(body.correspondence.admin.messages).toEqual([])
  })

  test('correspondence payloads exist for both tabs, chronological and read-only shaped', async () => {
    const { body } = await getPreview()
    const ai = body.correspondence.aiSupervisor
    expect(ai.total).toBe(2)
    expect(ai.capped).toBe(false)
    expect(ai.messages.map((m: any) => m.id)).toEqual(['m1', 'm2'])
    expect(ai.messages[0].role).toBe('user')
    const admin = body.correspondence.admin
    expect(admin.total).toBe(2)
    expect(admin.messages.map((m: any) => m.senderRole)).toEqual(['STUDENT', 'ADMIN'])
    for (const m of [...ai.messages, ...admin.messages]) {
      expect(m.audioData).toBeUndefined()
      expect(m.audioUrl).toBeUndefined()
    }
  })
})

describe('student preview — wiring & tab pins', () => {
  const root = join(import.meta.dir, '../..')
  test('students-tab rows carry the معاينة button wired to openStudentPreview', () => {
    const src = readFileSync(join(root, 'src/components/aact/AdminView.tsx'), 'utf8')
    expect(src).toContain('openStudentPreview(s.id)')
    expect(src).toContain('معاينة')
  })
  test('preview page is fully tab-organized with identity, cumulative, absence and pending-review surfaces', () => {
    const src = readFileSync(join(root, 'src/components/aact/AdminStudentPreview.tsx'), 'utf8')
    for (const label of ['نظرة شاملة', 'الوحدات', 'الامتحانات والواجبات', 'المتبقي عليه', 'مراسلات المشرف الذكي', 'مراسلات الإدارة', 'الالتحاق والماليات', 'الملف الأكاديمي']) {
      expect(src).toContain(label)
    }
    expect(src).toContain('المعدل التراكمي')
    expect(src).toContain('رقم الهاتف')
    expect(src).toContain('التخصص')
    expect(src).toContain('يحتاج تدخل')
    expect(src).toContain('غائب منذ')
    expect(src).toContain('نشط اليوم')
    expect(src).toContain('آخر نشاط')
    expect(src).toContain('بانتظار مراجعة')
    expect(src).toContain('التماسات قيد الانتظار')
    expect(src).toContain('الانتقال إلى صفحة المراجعة')
    expect(src).toContain("'aact-admin-tab'")
    expect(src).toContain("tab: 'grading-review'")
  })
  test('preview route performs no writes and consumes the shared engines (read-only monitoring contract)', () => {
    const src = readFileSync(join(root, 'src/app/api/admin/students/preview/route.ts'), 'utf8')
    expect(src).toContain("previewMode: 'ADMIN_READ_ONLY'")
    expect(src).not.toContain('.create(')
    expect(src).not.toContain('.update(')
    expect(src).not.toContain('.upsert(')
    expect(src).not.toContain('.delete(')
    expect(src).toContain("from '@/lib/final-grade'")
    expect(src).toContain('calculateFinalGrade')
    expect(src).toContain("from '@/lib/student-follow-up'")
    expect(src).toContain('computeFollowUpStatus')
  })
})
