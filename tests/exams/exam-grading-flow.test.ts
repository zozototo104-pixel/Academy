import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { readFileSync } from 'node:fs'
// Essay grading is imported after mocks to preserve test isolation.

// ===== essay-source: مصدر المقارنة للمقالي =====
// حالة هاريس: الكتاب يذكر ستة بنود، بنك المعرفة التقط ثلاثة منها فقط،
// والطالب ذكر بندين من الستة غير موجودين في الثلاثة — المصدر المُركّب
// يجب أن يحمل نص الكتاب كاملًا وإلا حُسب الصحيح خطأً.

const knowledgeRows = [
  { id: 'k-full', summary: 'ملخص عنصر المعرفة', excerpt: 'البنود: أ، ب، ج', chunkId: 'chunk-1' },
  { id: 'k-nochunk', summary: 'ملخص بلا مقطع', excerpt: 'اقتباس قصير', chunkId: null },
  { id: 'k-broken-chunk', summary: 'ملخص', excerpt: 'اقتباس بديل', chunkId: 'chunk-missing' },
]
const chunkRows = [
  { id: 'chunk-1', text: 'نص الكتاب الكامل — البنود الستة: أ، ب، ج، د، هـ، و' },
]

const dbMock = {
  bookKnowledgeItem: {
    findMany: async ({ where }: any) => knowledgeRows.filter((row) => where.id.in.includes(row.id)),
  },
  bookChunk: {
    findMany: async ({ where }: any) => chunkRows.filter((row) => where.id.in.includes(row.id)),
  },
}
mock.module('@/lib/db', () => ({ db: dbMock }))

const { buildEssaySourceMap } = await import('../../src/lib/essay-source')

describe('essay grading source (book text leads)', () => {
  test('chunk text is included in full — items the bank missed still prove the student right', async () => {
    const map = await buildEssaySourceMap(['k-full'])
    const source = map.get('k-full')!
    expect(source).toContain('نص الكتاب الكامل')
    expect(source).toContain('د، هـ، و')
    expect(source.startsWith('ملخص عنصر المعرفة')).toBe(true)
  })

  test('without a chunk the summary + excerpt remain the fallback', async () => {
    const map = await buildEssaySourceMap(['k-nochunk'])
    expect(map.get('k-nochunk')).toContain('ملخص بلا مقطع')
    expect(map.get('k-nochunk')).toContain('اقتباس قصير')
  })

  test('a missing chunk row falls back to the excerpt instead of failing', async () => {
    const map = await buildEssaySourceMap(['k-broken-chunk'])
    expect(map.get('k-broken-chunk')).toContain('اقتباس بديل')
  })

  test('unknown ids are simply absent from the map', async () => {
    const map = await buildEssaySourceMap(['k-nope'])
    expect(map.has('k-nope')).toBe(false)
  })
})

// ===== exam-attempt-notifications =====

const notifyCalls: any[][] = []
const adminCalls: any[][] = []
let hasHumanSupervisor = true

mock.module('@/lib/notify', () => ({
  notify: async (...args: any[]) => { notifyCalls.push(args) },
  notifyAdmins: async (...args: any[]) => { adminCalls.push(args) },
}))
mock.module('@/lib/supervisor-scope', () => ({
  assignedSupervisorForStudent: async () => ({ supervisorId: 'sup-1', supervisionMode: 'HUMAN' }),
  studentHasHumanSupervisor: async () => hasHumanSupervisor,
}))

const notifications = await import('../../src/lib/exam-attempt-notifications')

describe('exam attempt notifications', () => {
  beforeEach(() => {
    notifyCalls.length = 0
    adminCalls.length = 0
    hasHumanSupervisor = true
  })

  test('review entry: student hears the preliminary grade, admins and the human supervisor hear about the pending review', async () => {
    await notifications.notifyAttemptNeedsReview({
      studentId: 'stu-1', studentName: 'ريهام', examTitle: 'اختبار الوحدة',
      preliminary: { gradedPoints: 17, gradedMaxPoints: 20, pendingCount: 1 },
    })
    const studentCall = notifyCalls.find((c) => c[0] === 'stu-1')
    expect(studentCall).toBeTruthy()
    expect(studentCall![3]).toContain('أولية')
    expect(studentCall![3]).toContain('17')
    expect(adminCalls.length).toBe(1)
    expect(notifyCalls.some((c) => c[0] === 'sup-1')).toBe(true)
  })

  test('review entry without a human supervisor: no supervisor notification', async () => {
    hasHumanSupervisor = false
    await notifications.notifyAttemptNeedsReview({ studentId: 'stu-1', examTitle: 'اختبار الوحدة' })
    expect(notifyCalls.some((c) => c[0] === 'sup-1')).toBe(false)
    expect(adminCalls.length).toBe(1)
  })

  test('graded result: admins and supervisor are notified, the student is not spammed (he sees it live)', async () => {
    await notifications.notifyAttemptGraded({ studentId: 'stu-1', studentName: 'ريهام', examTitle: 'امتحان الفصل', score: 82.5 })
    expect(adminCalls.length).toBe(1)
    expect(adminCalls[0][2]).toContain('82.5')
    expect(notifyCalls.some((c) => c[0] === 'sup-1')).toBe(true)
    expect(notifyCalls.some((c) => c[0] === 'stu-1')).toBe(false)
  })

  test('review resolution: the student hears the final approved score', async () => {
    await notifications.notifyStudentReviewResolved({ studentId: 'stu-1', examTitle: 'اختبار الوحدة', score: 74 })
    const studentCall = notifyCalls.find((c) => c[0] === 'stu-1')
    expect(studentCall).toBeTruthy()
    expect(studentCall![2]).toContain('تمت مراجعة نتيجتك')
    expect(studentCall![3]).toContain('74')
  })
})

// ===== pins: الأسلاك في المسارات والواجهة =====

describe('grading-flow wiring pins', () => {
  const unitSubmit = readFileSync('src/app/api/exam/submit/route.ts', 'utf8')
  const programSubmit = readFileSync('src/app/api/program-exam/submit/route.ts', 'utf8')

  test('both submit routes grade essays against the book-led source map', () => {
    expect(unitSubmit).toContain('buildEssaySourceMap')
    expect(programSubmit).toContain('buildEssaySourceMap')
  })

  test('live payloads use the stored three-way partial value, not the 60% boolean', () => {
    const unitTernaries = unitSubmit.split('? true : pts > 0 ? null : false').length - 1
    expect(unitTernaries).toBeGreaterThanOrEqual(2)
    expect(programSubmit).toContain('isCorrect: clampedPoints >= q.points * 0.6 ? true : clampedPoints > 0 ? null : false')
  })

  test('NEEDS_REVIEW responses carry a preliminary grade and pending markers', () => {
    expect(unitSubmit).toContain('pendingReview: true')
    expect(unitSubmit).toContain('preliminary')
    expect(programSubmit).toContain('pendingReview: true')
    expect(programSubmit).toContain('preliminary')
  })

  test('both submit routes notify on review entry and on confident grading', () => {
    expect(unitSubmit).toContain('notifyAttemptNeedsReview')
    expect(unitSubmit).toContain('notifyAttemptGraded')
    expect(programSubmit).toContain('notifyAttemptNeedsReview')
    expect(programSubmit).toContain('notifyAttemptGraded')
  })

  test('a pending review locks a new attempt in both start paths', () => {
    const unitDetail = readFileSync('src/app/api/exam/detail/route.ts', 'utf8')
    expect(unitDetail).toContain("status: 'NEEDS_REVIEW'")
    expect(unitDetail).toContain('بانتظار تأكيد المشرف — لا يمكنك بدء محاولة جديدة')
    const programStart = readFileSync('src/app/api/program-exam/start/route.ts', 'utf8')
    expect(programStart).toContain('REVIEW_PENDING')
    expect(programStart).toContain('بانتظار تأكيد المشرف — لا يمكنك بدء محاولة جديدة')
  })

  test('admin review resolution notifies the student from both POST and PATCH', () => {
    const review = readFileSync('src/app/api/admin/attempts-review/route.ts', 'utf8')
    expect(review.split('notifyStudentReviewResolved').length - 1).toBeGreaterThanOrEqual(3) // import + POST + PATCH
    expect(review).toContain('buildEssaySourceMap')
  })

  test('ExamView renders the preliminary screen and pending badges', () => {
    const view = readFileSync('src/components/aact/ExamView.tsx', 'utf8')
    expect(view).toContain('d.preliminary')
    expect(view).toContain('نتيجتك أولية — بانتظار تأكيد المشرف')
    expect(view).toContain('بانتظار تأكيد المشرف')
    expect(view).toContain('pendingReview')
  })
})
