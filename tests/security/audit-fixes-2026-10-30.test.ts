// حراس حزمة التدقيق الأمني 2026-10-30 (مكدّسة على PR #160):
// 1) مفاتيح تصحيح اختبارات المشرف لا تصل الطالب (لا مباشرة ولا متداخلة).
// 2) تسجيل المناقشة للمشرف المعيّن فقط.
// 3) استئناف آثار السداد عند إعادة المحاولة بعد قلب الفاتورة PAID.
// 4) فك تشفير أسرار اللوحة عند القراءة (payments + helper).
// 5) أسئلة امتحان الفصل لا تُرسل قبل بدء محاولة على الخادم.
// 6) مجموع نقاط امتحان الفصل يُعاد حسابه من المنشورة عند التعديل/الاعتماد/الحذف.
// 7) مفاتيح التصحيح لا تصل الطالب عبر my/supervision أيضاً (الباب الثاني).
import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { NextRequest } from 'next/server'

// ---------- حالة قابلة لإعادة الضبط ----------
let currentUser: any = null
const notifyCalls: any[] = []
const auditCalls: any[] = []
const receiptEmails: any[] = []
let appRow: any = null
let scopeFindFirst: any = null
let admissionThrowOnce = false
let admissionUpdates: any[] = []
let activeAttemptRow: any = null
let settingRows: any[] = []
let examUpdates: any[] = []
let publishedPointRows: any[] = [{ points: 5 }, { points: 8 }]

const paymentRow: any = {
  id: 'p1', invoiceNo: 'INV-1', status: 'UNPAID', admissionId: 'app-1', enrollmentId: null,
  purpose: 'APPLICATION_FEE', userId: 'stu-1', payerName: 'طالب تجريبي', description: 'رسوم تقديم',
  method: null, receiptNo: null, agentId: null, amountCents: 3000, amount: 30, paidViaWebhook: false,
}

const questionRow = {
  id: 'q1', order: 1, type: 'MCQ', text: 'سؤال تجريبي بطول كافٍ للعرض؟', options: JSON.stringify(['أ', 'ب']),
  correctAnswer: 'أ', modelAnswer: 'إجابة نموذجية', correctRationale: 'لأن…', sourceEvidence: 'من الكتاب…', points: 2,
}
const assessmentRow = {
  id: 'as1', admissionId: 'app-1', studentId: 'stu-1', title: 'اختبار خاص', status: 'PUBLISHED', sourceBookIds: null,
  questions: [questionRow],
  attempts: [{ id: 'at1', studentId: 'stu-1', status: 'GRADED', answers: [{ id: 'an1', questionId: 'q1', answerText: null, question: { ...questionRow } }] }],
}
const examRow = {
  id: 'ex1', title: 'امتحان الفصل', semester: 1, status: 'READY', passScore: 50, durationMin: 60, totalPoints: 999,
  programId: 'prog-1', program: { id: 'prog-1', titleAr: 'برنامج', slug: 'p', category: 'DIPLOMA' },
  questions: [
    { id: 'pq1', order: 1, type: 'MCQ', text: 'سؤال فصل أول؟', options: JSON.stringify(['x', 'y']), points: 2, status: 'PUBLISHED' },
    { id: 'pq2', order: 2, type: 'ESSAY', text: 'سؤال فصل ثانٍ؟', options: null, points: 2, status: 'PUBLISHED' },
  ],
}

const fakeDb: any = {
  admissionApplication: {
    findUnique: async () => {
      if (admissionThrowOnce) { admissionThrowOnce = false; throw new Error('transient db failure') }
      return appRow
    },
    findFirst: async () => scopeFindFirst,
    findMany: async () => [],
    update: async (args: any) => { admissionUpdates.push(args); if (appRow) Object.assign(appRow, args.data); return appRow },
  },
  supervisorAssessment: {
    findMany: async () => [structuredClone(assessmentRow)],
    findUnique: async () => structuredClone(assessmentRow),
  },
  supervisorChannelMessage: { findMany: async () => [] },
  thesisSubmission: {
    findUnique: async () => ({ id: 'th-1', userId: 'stu-1', recordingStorageProvider: 's3', recordingStorageKey: 'k', recordingUrl: null, recordingData: null, recordingMime: 'video/webm' }),
  },
  payment: {
    findUnique: async (args: any) => {
      if (args?.where?.invoiceNo === paymentRow.invoiceNo || args?.where?.id === paymentRow.id) return paymentRow
      return null
    },
    findMany: async () => [paymentRow],
    updateMany: async (args: any) => {
      if (paymentRow.status === args.where.status) { Object.assign(paymentRow, args.data); return { count: 1 } }
      return { count: 0 }
    },
    update: async (args: any) => { Object.assign(paymentRow, args.data); return paymentRow },
  },
  user: {
    findUnique: async (args: any) => {
      if (args?.where?.id === 'stu-1' || args?.where?.email === 's@x.test') return { id: 'stu-1', email: 's@x.test', name: 'طالب تجريبي', role: 'STUDENT' }
      return null
    },
    findMany: async () => [],
  },
  enrollment: {
    findUnique: async () => null,
    create: async (args: any) => ({ id: 'en1', ...args.data }),
    update: async (args: any) => ({ id: 'en1', ...args.data }),
  },
  programExam: {
    findUnique: async () => structuredClone(examRow),
    findFirst: async () => null,
    update: async (args: any) => { examUpdates.push(args); return { id: 'ex1', ...args.data } },
  },
  programQuestion: {
    findUnique: async () => ({
      id: 'pq1', examId: 'ex1', text: 'نص سؤال قائم بطول مناسب', options: null, modelAnswer: null, sourceEvidence: null,
      status: 'PENDING_REVIEW', points: 5, exam: { id: 'ex1', title: 'امتحان الفصل' },
    }),
    update: async (args: any) => ({ id: 'pq1', ...args.data }),
    findMany: async (args: any) => (args?.where?.status === 'PUBLISHED' ? publishedPointRows : []),
    count: async () => publishedPointRows.length,
  },
  programExamAttempt: {
    findFirst: async (args: any) => (args?.where?.status === 'STARTED' ? activeAttemptRow : null),
    findMany: async () => [],
    count: async () => 0,
    updateMany: async () => ({ count: 0 }),
  },
  book: { findMany: async () => [] },
  setting: { findMany: async () => settingRows },
  aiLiveCredit: { findFirst: async () => null },
  agentApplication: { findUnique: async () => null },
  certificate: { create: async (args: any) => ({ id: 'c1', ...args.data }) },
}

mock.module('@/lib/db', () => ({ db: fakeDb }))
mock.module('@/lib/auth', () => ({
  requireUser: async () => { if (!currentUser) throw new Error('UNAUTHORIZED'); return currentUser },
  getCurrentUser: async () => currentUser,
  requireAdmin: async () => { if (!currentUser || currentUser.role !== 'ADMIN') throw new Error('UNAUTHORIZED'); return currentUser },
}))
mock.module('@/lib/notify', () => ({
  notify: async (...a: any[]) => { notifyCalls.push(a) },
  audit: async (...a: any[]) => { auditCalls.push(a) },
}))
mock.module('@/lib/supervisor-assessment-ai', () => ({
  AI_UNAVAILABLE_MESSAGE: 'AI unavailable',
  generateSupervisorQuestions: async () => [],
  gradeSupervisorAttemptWithAi: async () => ({ score: 0, passed: false, feedback: '', perQuestion: {} }),
}))
mock.module('@/lib/storage', () => ({
  readStoredFile: async () => ({ buffer: Buffer.from('video-bytes'), mimeType: 'video/webm' }),
}))
mock.module('@/lib/settings', () => ({
  nextReceiptNo: async () => 'RCPT-TEST-1',
  nextCertSerial: async () => 'CERT-TEST-1',
  getSetting: async () => null,
}))
mock.module('@/lib/mailer', () => ({
  emailPaymentReceipt: async (...a: any[]) => { receiptEmails.push(a) },
  emailFinalRegistration: async () => {},
  emailCertificateIssued: async () => {},
  emailExamPublished: async () => {},
}))
mock.module('@/lib/exam-cognitive-policy', () => ({
  cognitivePolicyArabicMessage: () => '',
  validateCognitiveDistribution: () => ({ ok: true }),
}))
mock.module('@/lib/program-exam-publication-readiness', () => ({
  validateProgramExamPublicationReadiness: async () => ({ ok: true }),
}))
mock.module('@/lib/tuition-installments', () => ({
  getAdmissionTuitionPlan: async () => null,
  enforceSemesterTuitionGate: async () => ({ ok: true }),
}))
mock.module('@/lib/semester-readiness', () => ({ calculateSemesterReadiness: async () => ({ readyMarked: true }) }))
mock.module('@/lib/exam-attempt-policy', () => ({
  EXAM_ATTEMPT_POLICY_SINCE: new Date(0),
  getExamMaxAttempts: async () => 3,
}))
mock.module('@/lib/live-usage-guard', () => ({ grantGeminiLiveCredit: async () => {} }))

process.env.AACT_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64')

const assessmentsRoute = await import('@/app/api/supervisor/assessments/route')
const mySupervisionRoute = await import('@/app/api/my/supervision/route')
const recordingRoute = await import('@/app/api/admin/defense-recording/route')
const programExamDetail = await import('@/app/api/program-exam/detail/route')
const programExamQuestions = await import('@/app/api/admin/program-exam-questions/route')
const settle = await import('@/lib/settle-payment')
const payments = await import('@/lib/payments')
const cryptoLib = await import('@/lib/secret-crypto')

function req(url: string) { return new NextRequest(url) }

beforeEach(() => {
  notifyCalls.length = 0; auditCalls.length = 0; receiptEmails.length = 0
  admissionUpdates = []; admissionThrowOnce = false; examUpdates = []
  publishedPointRows = [{ points: 5 }, { points: 8 }]
  appRow = { id: 'app-1', userId: 'stu-1', supervisorId: 'sup-1', email: 's@x.test', fullName: 'طالب تجريبي', country: 'PS', program: 'برنامج', programId: 'prog-1', reference: 'REF-1', status: 'AWAITING_FEE' }
  scopeFindFirst = null; activeAttemptRow = null; settingRows = []
  paymentRow.status = 'UNPAID'; paymentRow.receiptNo = null; paymentRow.method = null
  cryptoLib.clearSecretCache()
})

describe('1) مفاتيح تصحيح اختبارات المشرف', () => {
  test('الطالب لا يرى correctAnswer/modelAnswer لا مباشرة ولا متداخلة', async () => {
    currentUser = { id: 'stu-1', role: 'STUDENT', email: 's@x.test', name: 'طالب' }
    const res = await assessmentsRoute.GET(req('http://x/api/supervisor/assessments?admissionId=app-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    const q = body.assessments[0].questions[0]
    expect(q.text).toBeTruthy()
    expect(q.options).toEqual(['أ', 'ب'])
    expect('correctAnswer' in q).toBe(false)
    expect('modelAnswer' in q).toBe(false)
    expect('correctRationale' in q).toBe(false)
    expect('sourceEvidence' in q).toBe(false)
    const nested = body.assessments[0].attempts[0].answers[0].question
    expect('correctAnswer' in nested).toBe(false)
    expect('modelAnswer' in nested).toBe(false)
  })

  test('المشرف المعيّن يرى مفاتيح التصحيح كاملة', async () => {
    currentUser = { id: 'sup-1', role: 'SUPERVISOR', email: 'sup@x.test', name: 'مشرف' }
    const res = await assessmentsRoute.GET(req('http://x/api/supervisor/assessments?admissionId=app-1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.assessments[0].questions[0].correctAnswer).toBe('أ')
    expect(body.assessments[0].questions[0].modelAnswer).toBe('إجابة نموذجية')
  })
})

describe('2) نطاق تسجيل المناقشة', () => {
  test('مشرف غير معيّن على الطالب يُرفض 403', async () => {
    currentUser = { id: 'sup-9', role: 'SUPERVISOR', email: 'o@x.test', name: 'غريب' }
    scopeFindFirst = null
    const res = await recordingRoute.GET(req('http://x/api/admin/defense-recording?thesisId=th-1'))
    expect(res.status).toBe(403)
  })

  test('المشرف المعيّن يصل للتسجيل', async () => {
    currentUser = { id: 'sup-1', role: 'SUPERVISOR', email: 'sup@x.test', name: 'مشرف' }
    scopeFindFirst = { id: 'app-1' }
    const res = await recordingRoute.GET(req('http://x/api/admin/defense-recording?thesisId=th-1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('video/webm')
  })

  test('الأدمن يصل بلا قيد نطاق', async () => {
    currentUser = { id: 'adm-1', role: 'ADMIN', email: 'a@x.test', name: 'أدمن' }
    scopeFindFirst = null
    const res = await recordingRoute.GET(req('http://x/api/admin/defense-recording?thesisId=th-1'))
    expect(res.status).toBe(200)
  })
})

describe('3) استئناف آثار السداد', () => {
  test('عطل بعد قلب PAID ثم إعادة محاولة: تكتمل الآثار بلا إعادة إرسال الإيصال', async () => {
    admissionThrowOnce = true // finalize سيفشل مرة واحدة بعد قلب الفاتورة
    await expect(settle.markInvoicePaid('INV-1', 'CASH')).rejects.toThrow()
    expect(paymentRow.status).toBe('PAID') // القلب حصل وبقي
    expect(appRow.status).toBe('AWAITING_FEE') // التفعيل لم يكتمل

    const retry = await settle.markInvoicePaid('INV-1', 'CASH')
    expect(retry.ok).toBe(true)
    expect(appRow.status).toBe('UNDER_REVIEW') // انتقال الحالة اكتمل عند الاستئناف
    expect(receiptEmails.length).toBe(0) // لا إعادة إرسال لبريد الإيصال
    expect(notifyCalls.some((c) => c[2] === 'تم استلام دفعتك بنجاح')).toBe(false)

    const third = await settle.markInvoicePaid('INV-1', 'CASH')
    expect(third.ok).toBe(true)
    expect(admissionUpdates.filter((u) => u.data?.status === 'UNDER_REVIEW').length).toBe(1) // لا تكرار للانتقال
    expect(auditCalls.some((c) => c[1] === 'PAYMENT_SETTLEMENT_RESUMED')).toBe(true)
  })
})

describe('4) فك تشفير أسرار اللوحة عند القراءة', () => {
  test('unsealSettingSecret: نص عادي يمر، مشفّر يُفك، فاسد يعود فارغاً', () => {
    expect(cryptoLib.unsealSettingSecret('plain-value')).toBe('plain-value')
    const sealed = cryptoLib.encryptSecret('sk_test_abc')
    expect(sealed.startsWith('enc:v1:')).toBe(true)
    expect(cryptoLib.unsealSettingSecret(sealed)).toBe('sk_test_abc')
    expect(cryptoLib.unsealSettingSecret('enc:v1:bad:bad:bad')).toBe('')
    expect(cryptoLib.unsealSettingSecret('')).toBe('')
  })

  test('getGatewayConfig يفك مفتاح Stripe المحفوظ من اللوحة', async () => {
    settingRows = [
      { key: 'STRIPE_SECRET_KEY', value: cryptoLib.encryptSecret('sk_test_abc') },
      { key: 'PAYMENT_MODE', value: 'SANDBOX' },
    ]
    const cfg = await payments.getGatewayConfig()
    expect(cfg.stripeSecret).toBe('sk_test_abc')
  })
})

describe('5) أسئلة امتحان الفصل قبل البدء', () => {
  test('بلا محاولة نشطة: الأسئلة فارغة والعدد ظاهر', async () => {
    currentUser = { id: 'stu-1', role: 'STUDENT', email: 's@x.test', name: 'طالب' }
    fakeDb.enrollment.findUnique = async () => ({ id: 'en1', userId: 'stu-1', programId: 'prog-1', status: 'ACTIVE' })
    activeAttemptRow = null
    const res = await programExamDetail.GET(req('http://x/api/program-exam/detail?examId=ex1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.questions).toEqual([])
    expect(body.exam.questionsCount).toBe(2)
    expect(body.exam.hasActiveAttempt).toBe(false)
    // المجموع المعروض = مجموع المنشورة الفعلي (4) لا المخزّن المنحرف (999)
    expect(body.exam.totalPoints).toBe(4)
  })

  test('مع محاولة نشطة: الأسئلة تُرسل', async () => {
    currentUser = { id: 'stu-1', role: 'STUDENT', email: 's@x.test', name: 'طالب' }
    activeAttemptRow = { id: 'pa1', status: 'STARTED', startedAt: new Date(), createdAt: new Date() }
    const res = await programExamDetail.GET(req('http://x/api/program-exam/detail?examId=ex1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.questions.length).toBe(2)
    expect(body.exam.hasActiveAttempt).toBe(true)
    expect(body.exam.totalPoints).toBe(4)
  })
})

describe('6) مجموع نقاط امتحان الفصل لا ينحرف', () => {
  function patchReq(payload: any) {
    return new NextRequest('http://x/api/admin/program-exam-questions', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  }

  test('تعديل نقاط سؤال يعيد حساب المجموع المخزّن من المنشورة', async () => {
    currentUser = { id: 'adm-1', role: 'ADMIN', email: 'a@x.test', name: 'أدمن' }
    const res = await programExamQuestions.PATCH(patchReq({ questionId: 'pq1', action: 'EDIT', points: 8 }))
    expect(res.status).toBe(200)
    expect(examUpdates.some((u) => u.data?.totalPoints === 13)).toBe(true)
  })

  test('اعتماد سؤال (قلب الحالة) يعيد حساب المجموع المخزّن أيضاً', async () => {
    currentUser = { id: 'adm-1', role: 'ADMIN', email: 'a@x.test', name: 'أدمن' }
    const res = await programExamQuestions.PATCH(patchReq({ questionId: 'pq1', action: 'APPROVE' }))
    expect(res.status).toBe(200)
    expect(examUpdates.some((u) => u.data?.totalPoints === 13)).toBe(true)
  })
})

describe('7) مفاتيح التصحيح عبر my/supervision (الباب الثاني)', () => {
  test('الطالب لا يرى مفاتيح التصحيح عبر صفحة متابعته — لا مباشرة ولا متداخلة', async () => {
    fakeDb.admissionApplication.findMany = async () => [{
      id: 'app-1', reference: 'REF-1', fullName: 'طالب تجريبي', program: 'برنامج', programId: 'prog-1',
      status: 'ACTIVE_STUDY', supervisorId: 'sup-1', supervisionMode: 'HYBRID', supervisorAt: new Date(),
      supervisor: { id: 'sup-1', name: 'مشرف', email: 'sup@x.test', phone: null },
      programRef: { id: 'prog-1', titleAr: 'برنامج', books: [] }, theses: [],
    }]
    currentUser = { id: 'stu-1', role: 'STUDENT', email: 's@x.test', name: 'طالب' }
    const res = await mySupervisionRoute.GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    const a = body.supervision[0].assessments[0]
    const q = a.questions[0]
    expect(q.text).toBeTruthy()
    expect(q.options).toEqual(['أ', 'ب'])
    expect('correctAnswer' in q).toBe(false)
    expect('modelAnswer' in q).toBe(false)
    expect('correctRationale' in q).toBe(false)
    expect('sourceEvidence' in q).toBe(false)
    const nested = a.attempts[0].answers[0].question
    expect('correctAnswer' in nested).toBe(false)
    expect('modelAnswer' in nested).toBe(false)
    expect('correctRationale' in nested).toBe(false)
    expect('sourceEvidence' in nested).toBe(false)
  })
})
