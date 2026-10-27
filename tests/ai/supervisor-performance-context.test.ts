/// <reference types="bun-types" />
import { describe, expect, mock, test } from 'bun:test'

// ===== حالة الاختبار القابلة للتبديل =====
// full: طالب مسجل + محاولات + امتحانات مقررة
// assigned-only: مسجل لكن بلا محاولات
// empty: بلا تسجيل ولا محاولات ولا مقررات
let scenario: 'full' | 'assigned-only' | 'empty' = 'full'

const enrollmentRow: any = {
  programId: 'program-1',
  status: 'ACTIVE',
  program: {
    titleAr: 'برنامج الاختبار',
    category: 'DIPLOMA',
    books: [],
    units: [],
    assignments: [],
    studyGuides: [],
    knowledgeItems: [],
    questionBankItems: [],
    programExams: [],
  },
}

const unitAttemptRows: any[] = [
  {
    _userId: 'student-1',
    score: 60,
    passed: false,
    status: 'GRADED',
    feedback: JSON.stringify({ summary: 'فهم جيد للأساسيات', strengths: ['التعريفات'], improvements: ['التطبيق'] }),
    submittedAt: new Date(),
    exam: { title: 'اختبار وحدة الموارد', unit: { title: 'وحدة الموارد البشرية', semester: 1 } },
    answers: [
      { question: { text: 'ما هو التعريف الصحيح للحوافز؟', type: 'MCQ' }, aiFeedback: null },
      { question: { text: 'اذكر فرقا بين التحفيز الداخلي والخارجي', type: 'ESSAY' }, aiFeedback: null },
    ],
  },
  {
    _userId: 'student-2',
    score: 100,
    passed: true,
    status: 'GRADED',
    feedback: null,
    submittedAt: new Date(),
    exam: { title: 'اختبار طالب آخر', unit: { title: 'وحدة سرية', semester: 1 } },
    answers: [{ question: { text: 'سؤال سري لطالب آخر', type: 'MCQ' }, aiFeedback: null }],
  },
]

const programAttemptRows: any[] = [
  {
    _userId: 'student-1',
    score: 70,
    finalScore: null,
    passed: true,
    status: 'GRADED',
    feedback: null,
    submittedAt: new Date(),
    exam: { title: 'الاختبار النهائي', semester: 2 },
    answers: [
      { question: { text: 'سؤال برنامج خاطئ', type: 'MCQ', sourceChapter: 'الفصل الثالث', cognitiveSkill: 'APPLY' }, aiFeedback: null },
    ],
  },
]

const submissionRows: any[] = [
  {
    _userId: 'student-1',
    status: 'GRADED',
    score: 88,
    feedback: 'عمل ممتاز',
    submittedAt: new Date(),
    assignment: { title: 'واجب تطبيقي', type: 'REPORT', semester: 1 },
  },
]

const assignedUnitExams: any[] = [
  { title: 'اختبار وحدة الموارد', unit: { title: 'وحدة الموارد البشرية', semester: 1 } },
  { title: 'اختبار وحدة مقبلة', unit: { title: 'وحدة مقبلة', semester: 2 } },
]

function filterByUser(rows: any[], args: any): any[] {
  // Substantive scope filter: the mock only returns rows matching the query's
  // userId (and status list when given), mirroring what Prisma would return.
  return rows.filter((row) => {
    if (args?.where?.userId && row._userId !== args.where.userId) return false
    if (Array.isArray(args?.where?.status?.in) && !args.where.status.in.includes(row.status)) return false
    return true
  })
}

const db: any = {
  user: { findUnique: async () => ({ name: 'طالب', role: 'STUDENT', createdAt: new Date() }) },
  studentAcademicMemory: { findUnique: async () => null },
  chatMessage: { findMany: async () => [] },
  supervisorChannelMessage: { findMany: async () => [] },
  admissionApplication: { findFirst: async () => null },
  thesisSubmission: { findFirst: async () => null },
  enrollment: { findMany: async () => (scenario === 'empty' ? [] : [enrollmentRow]) },
  program: { findMany: async () => [] },
  examAttempt: { findMany: async (args: any) => (scenario === 'full' ? filterByUser(unitAttemptRows, args) : []) },
  programExamAttempt: { findMany: async (args: any) => (scenario === 'full' ? filterByUser(programAttemptRows, args) : []) },
  assignmentSubmission: { findMany: async (args: any) => (scenario === 'full' ? filterByUser(submissionRows, args) : []) },
  exam: { findMany: async () => (scenario === 'empty' ? [] : assignedUnitExams) },
  programExam: { findMany: async () => (scenario === 'empty' ? [] : [{ title: 'الاختبار النهائي', semester: 2 }]) },
  programAssignment: { findMany: async () => (scenario === 'empty' ? [] : [{ title: 'واجب تطبيقي', type: 'REPORT', semester: 1 }]) },
}

mock.module('@/lib/db', () => ({ db }))
mock.module('@/lib/ai-context-builder', () => ({ buildScopedProgramCatalogSnapshot: async () => '' }))
mock.module('@/lib/text-ai', () => ({ textAiCompleteJson: async () => '' }))

describe('AI supervisor context — student exam/assignment results', () => {
  test('context lists assigned exams, attempts with scores, wrong questions, and weakness aggregation', async () => {
    scenario = 'full'
    const lib = await import('@/lib/supervisor-ai')
    const context = await lib.buildSupervisorContext('student-1')
    // Assigned (on the student's page)
    expect(context).toContain('اختبار وحدة الموارد')
    expect(context).toContain('اختبار وحدة مقبلة')
    expect(context).toContain('الاختبار النهائي')
    expect(context).toContain('واجب تطبيقي')
    // Attempts with score + outcome + parsed feedback
    expect(context).toContain('العلامة 60')
    expect(context).toContain('غير ناجح')
    expect(context).toContain('فهم جيد للأساسيات')
    expect(context).toContain('نقاط قوة: التعريفات')
    expect(context).toContain('العلامة 88')
    // Wrong questions + weakness aggregation
    expect(context).toContain('ما هو التعريف الصحيح للحوافز؟')
    expect(context).toContain('اذكر فرقا بين التحفيز الداخلي والخارجي')
    expect(context).toContain('وحدة الموارد البشرية: 2 أخطاء')
    expect(context).toContain('الفصل الثالث: 1 أخطاء')
  })

  test('context never includes another student\'s attempts or wrong answers', async () => {
    scenario = 'full'
    const lib = await import('@/lib/supervisor-ai')
    const context = await lib.buildSupervisorContext('student-1')
    expect(context).not.toContain('اختبار طالب آخر')
    expect(context).not.toContain('وحدة سرية')
    expect(context).not.toContain('سؤال سري لطالب آخر')
  })

  test('assigned list appears even without attempts, but no attempt sections', async () => {
    scenario = 'assigned-only'
    const lib = await import('@/lib/supervisor-ai')
    const context = await lib.buildSupervisorContext('student-1')
    expect(context).toContain('اختبار وحدة الموارد')
    expect(context).not.toContain('آخر محاولاته في امتحانات الوحدات')
    expect(context).not.toContain('آخر تسليمات واجباته')
    scenario = 'full'
  })

  test('no performance section when the student has nothing assigned and no attempts', async () => {
    scenario = 'empty'
    const lib = await import('@/lib/supervisor-ai')
    const context = await lib.buildSupervisorContext('student-1')
    expect(context).not.toContain('نتائج الطالب في الامتحانات والواجبات')
    scenario = 'full'
  })
})
