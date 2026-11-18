import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { PrismaClient } from '@prisma/client'

const DAY_MS = 86_400_000

// Fixture writes are scoped to the synthetic student/program returned by the
// existing QA journey endpoint. Verify both identities before touching a row.
async function prepareExpiredUnitAppeals(prisma: PrismaClient, setup: any) {
  if (process.env.E2E_QA_ONLY !== '1') throw new Error('Reopen appeal journey requires E2E_QA_ONLY=1')
  const stamp = String(setup.stamp || '')
  if (!/^\d{14}$/.test(stamp)) throw new Error('Invalid QA journey stamp')
  const [student, program, enrollment] = await Promise.all([
    prisma.user.findUnique({ where: { id: setup.student.id }, select: { id: true, email: true } }),
    prisma.program.findUnique({ where: { id: setup.program.id }, select: { id: true, slug: true, category: true, semestersCount: true } }),
    prisma.enrollment.findUnique({ where: { id: setup.enrollment.id }, select: { id: true, userId: true, programId: true } }),
  ])
  if (student?.email !== `qa.fulljourney.${stamp}@aact.test` ||
      program?.slug !== `qa-full-journey-${stamp}` || program.category !== 'MASTERS' || program.semestersCount !== 2 ||
      enrollment?.userId !== student.id || enrollment.programId !== program.id) {
    throw new Error('Refusing to modify a non-QA student, program, or enrollment')
  }

  // Master's semester 1 lasts 90 days. With two semester-1 units, each
  // receives 45 days. Day 60 closes only the first unit, not the semester.
  const endedUnit = await prisma.unit.create({
    data: {
      programId: program.id, semester: 1, order: 0, status: 'APPROVED',
      title: `QA وحدة انتهت مدتها ${stamp}`, summary: 'QA reopening guard', content: '[]',
      exam: {
        create: {
          status: 'READY', title: `QA امتحان وحدة منتهية ${stamp}`, passScore: 60,
          questions: {
            create: {
              order: 1, type: 'MCQ', text: 'ما الهدف من اختبار إعادة الفتح؟',
              options: JSON.stringify(['التحقق من صلاحية المنحة', 'تجاوز الإدارة']), correctAnswer: '0', points: 100,
            },
          },
        },
      },
    },
    include: { exam: { include: { questions: { select: { id: true } } } } },
  })
  const [semesterAssignment, unitAssignment] = await Promise.all([
    prisma.programAssignment.create({
      data: {
        programId: program.id, semester: 1, title: `QA واجب فصلي متأخر ${stamp}`,
        description: 'QA unlinked assignment with an expired fixed deadline',
        type: 'REPORT', points: 10, weight: 0, status: 'PUBLISHED',
        dueAt: new Date(Date.now() - DAY_MS),
      },
    }),
    prisma.programAssignment.create({
      data: {
        programId: program.id, unitId: endedUnit.id, semester: 1,
        title: `QA واجب وحدة منتهية ${stamp}`, description: 'QA expired unit assignment',
        type: 'REPORT', points: 10, weight: 0, status: 'PUBLISHED',
      },
    }),
  ])
  await prisma.enrollment.update({
    where: { id: enrollment.id },
    data: { createdAt: new Date(Date.now() - 60 * DAY_MS) },
  })
  if (!endedUnit.exam?.questions[0]) throw new Error('QA expired exam is missing its question')
  return {
    unitId: endedUnit.id,
    examId: endedUnit.exam.id,
    questionId: endedUnit.exam.questions[0].id,
    semesterAssignmentId: semesterAssignment.id,
    unitAssignmentId: unitAssignment.id,
  }
}

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

function requiredAnyEnv(names: string[]) {
  for (const name of names) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  throw new Error(`Missing required environment variable. Expected one of: ${names.join(', ')}`)
}

// The login route is cookie-based: createSession sets the raw session token
// only as the httpOnly aact_session cookie, and the JSON body carries the
// user object, never a token. Session reading accepts Authorization: Bearer
// first, so the cookie value doubles as the bearer token used below.
function sessionTokenFromHeaders(headers: { name: string; value: string }[]) {
  const cookies = headers
    .filter((h) => h.name.toLowerCase() === 'set-cookie')
    .map((h) => h.value)
    .join('; ')
  const match = cookies.match(/aact_session=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : ''
}

async function login(page: Page, email: string, password: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } })
  const body = await response.json().catch(() => ({}))
  expect(response.ok(), `Login failed for ${email}: ${response.status()} ${JSON.stringify(body).slice(0, 700)}`).toBeTruthy()
  const token = sessionTokenFromHeaders(response.headersArray())
  expect(token, 'Login must set the aact_session session cookie').toBeTruthy()
  return { token, user: body.user }
}

async function loginAsAdmin(page: Page) {
  return login(page, requiredAnyEnv(['ADMIN_EMAIL', 'E2E_ADMIN_EMAIL']), requiredAnyEnv(['ADMIN_PASSWORD', 'E2E_ADMIN_PASSWORD']))
}

function norm(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/[ة]/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function scoreExamAlignment(exam: any, bookTitle: string, concepts: string[]) {
  const title = norm(bookTitle)
  const conceptNeedles = concepts.map(norm).filter(Boolean)
  const questions = Array.isArray(exam?.questions) ? exam.questions : []
  const rows = questions.map((q: any) => {
    const hay = norm(`${q.text || ''} ${q.sourceEvidence || ''} ${q.sourceBookTitle || ''} ${q.modelAnswer || ''}`)
    const titleHit = !!title && hay.includes(title)
    const conceptHits = conceptNeedles.filter((c) => hay.includes(c))
    return {
      id: q.id,
      type: q.type,
      aligned: titleHit || conceptHits.length > 0,
      titleHit,
      conceptHits,
      sourceBookTitle: q.sourceBookTitle,
      text: q.text,
      sourceEvidence: q.sourceEvidence,
    }
  })
  const aligned = rows.filter((r: any) => r.aligned).length
  return { total: rows.length, aligned, score: rows.length ? Math.round((aligned / rows.length) * 100) : 0, rows }
}

async function verifyReopenAppealJourney(page: Page, prisma: PrismaClient, setup: any, adminToken: string, studentToken: string) {
  const fixture = await prepareExpiredUnitAppeals(prisma, setup)
  const studentHeaders = { Authorization: `Bearer ${studentToken}` }
  const adminHeaders = { Authorization: `Bearer ${adminToken}` }
  const submit = (assignmentId: string) => page.request.post('/api/assignments', {
    headers: studentHeaders,
    data: { assignmentId, answerText: 'إجابة اختبارية للتأكد من السماح بالتسليم بعد الموافقة.' },
  })
  const examDetail = () => page.request.get(`/api/exam/detail?examId=${encodeURIComponent(fixture.examId)}`, { headers: studentHeaders })

  // Both overdue assignments and the exam must be blocked before an appeal.
  const beforeSemester = await submit(fixture.semesterAssignmentId)
  expect(beforeSemester.status(), 'Expired unlinked assignment must be blocked before the grant').toBe(400)
  const beforeUnit = await submit(fixture.unitAssignmentId)
  expect(beforeUnit.status(), 'Expired unit assignment must be blocked before the grant').toBe(400)
  const beforeExam = await examDetail()
  const beforeExamBody = await beforeExam.json().catch(() => ({}))
  expect(beforeExam.status(), `Ended unit exam should return 403: ${JSON.stringify(beforeExamBody)}`).toBe(403)
  expect(beforeExamBody.code).toBe('UNIT_WINDOW_ENDED')
  expect(beforeExamBody.data).toMatchObject({ programId: setup.program.id, semester: 1, unitId: fixture.unitId })

  const semesterAppeal = await page.request.post('/api/reopen-appeals', {
    headers: studentHeaders,
    data: { programId: setup.program.id, semester: 1, reason: 'QA: التماس فصل للواجب غير المرتبط بوحدة.' },
  })
  const semesterAppealBody = await semesterAppeal.json().catch(() => ({}))
  expect(semesterAppeal.ok(), `Semester appeal request failed: ${JSON.stringify(semesterAppealBody)}`).toBeTruthy()
  expect(semesterAppealBody.appeal.unitId).toBeNull()
  const semesterDecision = await page.request.post('/api/admin/reopen-appeals', {
    headers: adminHeaders, data: { appealId: semesterAppealBody.appeal.id, approve: true },
  })
  const semesterDecisionBody = await semesterDecision.json().catch(() => ({}))
  expect(semesterDecision.ok(), `Semester approval failed: ${JSON.stringify(semesterDecisionBody)}`).toBeTruthy()
  expect(semesterDecisionBody.appeal.status).toBe('APPROVED')

  const semesterSubmission = await submit(fixture.semesterAssignmentId)
  const semesterSubmissionBody = await semesterSubmission.json().catch(() => ({}))
  expect(semesterSubmission.ok(), `Approved semester grant must permit the unlinked assignment: ${JSON.stringify(semesterSubmissionBody)}`).toBeTruthy()
  expect(semesterSubmissionBody.submission.status).toBe('SUBMITTED')
  const stillBlockedUnit = await submit(fixture.unitAssignmentId)
  expect(stillBlockedUnit.status(), 'Semester grant must NOT reopen the expired unit assignment').toBe(400)
  const stillBlockedExam = await examDetail()
  const stillBlockedExamBody = await stillBlockedExam.json().catch(() => ({}))
  expect(stillBlockedExam.status(), `Semester grant must NOT reopen the unit exam: ${JSON.stringify(stillBlockedExamBody)}`).toBe(403)
  expect(stillBlockedExamBody.code).toBe('UNIT_WINDOW_ENDED')

  // Verify the student-facing warning, not only the server permissions.
  await page.goto(`/dashboard/program/${encodeURIComponent(setup.program.id)}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: 'المحتوى والواجبات' }).click()
  await page.getByRole('tab', { name: /الواجبات/ }).click()
  await expect(page.getByText(/الوحدات التي انتهت مدتها ما زالت مغلقة/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'التماس إعادة فتح الوحدة' })).toBeVisible()

  // The exam page must show an actionable appeal and submit it as a student.
  await page.goto(`/exam/${encodeURIComponent(fixture.examId)}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByText('انتهت نافذة هذا الامتحان', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'التماس إعادة فتح الامتحان' }).click()
  await page.getByPlaceholder('اكتب سبب التأخر باختصار ووضوح...').fill('QA: أطلب إعادة فتح الوحدة المنتهية لأداء امتحانها وتسليم واجبها.')
  await page.getByRole('button', { name: 'تقديم الالتماس', exact: true }).click()
  await expect(page.getByText(/التماس إعادة فتحك قيد البتّ/)).toBeVisible()

  const myAppeals = await page.request.get('/api/reopen-appeals', { headers: studentHeaders })
  const myAppealsBody = await myAppeals.json().catch(() => ({}))
  expect(myAppeals.ok()).toBeTruthy()
  const unitAppeal = (myAppealsBody.appeals || []).find((appeal: any) => appeal.unitId === fixture.unitId && appeal.status === 'PENDING')
  expect(unitAppeal, 'Student exam screen must persist an appeal for the exact unit').toBeTruthy()
  const unitDecision = await page.request.post('/api/admin/reopen-appeals', {
    headers: adminHeaders, data: { appealId: unitAppeal.id, approve: true },
  })
  const unitDecisionBody = await unitDecision.json().catch(() => ({}))
  expect(unitDecision.ok(), `Unit approval failed: ${JSON.stringify(unitDecisionBody)}`).toBeTruthy()
  expect(unitDecisionBody.appeal.status).toBe('APPROVED')

  const unitSubmission = await submit(fixture.unitAssignmentId)
  const unitSubmissionBody = await unitSubmission.json().catch(() => ({}))
  expect(unitSubmission.ok(), `Approved unit grant must permit its assignment: ${JSON.stringify(unitSubmissionBody)}`).toBeTruthy()
  expect(unitSubmissionBody.submission.status).toBe('SUBMITTED')

  const reopenedExam = await examDetail()
  const reopenedExamBody = await reopenedExam.json().catch(() => ({}))
  expect(reopenedExam.ok(), `Approved unit grant must permit the exam start: ${JSON.stringify(reopenedExamBody)}`).toBeTruthy()
  expect(reopenedExamBody.exam.id).toBe(fixture.examId)
  expect(reopenedExamBody.questions.some((question: any) => question.id === fixture.questionId)).toBe(true)
  const examSubmission = await page.request.post('/api/exam/submit', {
    headers: studentHeaders,
    data: { examId: fixture.examId, answers: [{ questionId: fixture.questionId, selectedOption: 0 }] },
    timeout: 90_000,
  })
  const examSubmissionBody = await examSubmission.json().catch(() => ({}))
  expect(examSubmission.ok(), `Approved grant must permit exam submission: ${JSON.stringify(examSubmissionBody).slice(0, 1200)}`).toBeTruthy()
  const persistedAttempt = await prisma.examAttempt.findFirst({ where: { examId: fixture.examId, userId: setup.student.id }, select: { status: true } })
  expect(persistedAttempt?.status, 'Submitted QA unit exam must be graded').toBe('GRADED')

  return {
    unlinkedAssignmentSubmitted: semesterSubmissionBody.submission.status === 'SUBMITTED',
    unitProtectedBySemesterGrant: stillBlockedUnit.status() === 400 && stillBlockedExamBody.code === 'UNIT_WINDOW_ENDED',
    unitAppealRequestedFromExamScreen: Boolean(unitAppeal.id),
    unitAssignmentSubmitted: unitSubmissionBody.submission.status === 'SUBMITTED',
    unitExamSubmitted: persistedAttempt?.status === 'GRADED',
  }
}

function md(report: any) {
  const stepRows = report.setup.steps.map((s: any) => `| ${s.name} | ${s.ok ? '✅' : '❌'} | ${String(s.detail || '').replace(/\|/g, '/')} |`).join('\n')
  const qRows = report.exam.alignment.rows.map((q: any) => `| ${q.type} | ${q.aligned ? '✅' : '❌'} | ${q.titleHit ? 'book' : q.conceptHits.join(', ')} | ${String(q.text || '').replace(/\|/g, '/').slice(0, 160)} |`).join('\n')
  const academic = report.setup.academicJourney || {}
  return `# AACT Platform Full Journey Report\n\nGenerated: ${new Date().toISOString()}\n\n## Setup and business operations\n\n| Step | Result | Detail |\n|---|---|---|\n${stepRows}\n\n## Academic + financial gates\n\n- Semester 1 before half tuition: **${report.setup.tuitionGates?.semester1BeforeInitialPayment?.ok === false ? 'BLOCKED ✅' : 'NOT BLOCKED ❌'}**\n- Semester 1 after half tuition: **${report.setup.tuitionGates?.semester1AfterInitialPayment?.ok ? 'OPEN ✅' : 'BLOCKED ❌'}**\n- Semester 1 average: **${academic.semesters?.semester1?.average ?? '—'}%**\n- Semester 2 average: **${academic.semesters?.semester2?.average ?? '—'}%**\n- Semester 2 before full installment: **${academic.tuitionGate?.semester2BeforeFinalPayment?.ok === false ? 'BLOCKED ✅' : 'NOT BLOCKED ❌'}**\n- Semester 2 after full installment: **${academic.tuitionGate?.semester2AfterFinalPayment?.ok ? 'OPEN ✅' : 'BLOCKED ❌'}**\n- Thesis eligible: **${academic.thesis?.eligible ? 'YES ✅' : 'NO ❌'}**\n- Final grade: **${academic.finalGrade?.score ?? '—'}%**\n- Enrollment status: **${report.setup.enrollment?.status || '—'}**\n\n## Student access\n\n- Student login: **${report.studentAccess.loginOk ? 'OK' : 'FAILED'}**\n- Dashboard visible: **${report.studentAccess.dashboardOk ? 'OK' : 'FAILED'}**\n- Program: ${report.setup.program.title}\n\n## Exam generation and book alignment\n\n- Exam generated: **${report.exam.generated ? 'YES' : 'NO'}**\n- Question count: **${report.exam.questionCount}**\n- Alignment score: **${report.exam.alignment.score}%**\n- Book: ${report.setup.book.title}\n\n| Type | Aligned | Evidence | Question |\n|---|---|---|---|\n${qRows}\n`
}

test.describe('AACT full platform journey suite', () => {
  test.setTimeout(300_000)

  test('unauthenticated visitors cannot create or delete academic journey fixtures', async ({ request }) => {
    const create = await request.post('/api/admin/full-journey', { data: {} })
    expect([401, 403], `Unauthenticated journey creation returned ${create.status()}`).toContain(create.status())
    const remove = await request.delete('/api/admin/full-journey', { data: { stamp: 'qa-unauthorized-probe' } })
    expect([401, 403], `Unauthenticated journey deletion returned ${remove.status()}`).toContain(remove.status())
  })

  test('admin cleanup rejects malformed and out-of-scope fixture identifiers without deleting records', async ({ page }) => {
    const admin = await loginAsAdmin(page)
    for (const stamp of ['', '20261109', '../../20261109123456', '20261109123456-extra']) {
      const response = await page.request.delete('/api/admin/full-journey', {
        headers: { Authorization: `Bearer ${admin.token}` },
        data: { stamp },
      })
      const body = await response.json().catch(() => ({}))
      expect(response.status(), `Invalid cleanup stamp ${JSON.stringify(stamp)} was accepted`).toBe(400)
      expect(body.ok, `Invalid cleanup stamp ${JSON.stringify(stamp)} returned success`).toBe(false)
    }
  })

  async function cleanupFullJourney(request: any, testInfo: TestInfo, target: { token: string; stamp: string }) {
    const cleanupRes = await request.delete('/api/admin/full-journey', {
      headers: { Authorization: `Bearer ${target.token}` },
      data: { stamp: target.stamp },
      timeout: 45_000,
    })
    const cleanupBody = await cleanupRes.json().catch(() => ({}))
    await mkdir('test-results/full-journey', { recursive: true }).catch(() => {})
    const cleanupPath = 'test-results/full-journey/cleanup.json'
    await writeFile(cleanupPath, JSON.stringify({ status: cleanupRes.status(), body: cleanupBody }, null, 2), 'utf8')
    await testInfo.attach('full-journey-cleanup-json', { path: cleanupPath, contentType: 'application/json' })
    const cleanupOk = cleanupRes.ok() && cleanupBody?.ok === true
    if (!cleanupOk && testInfo.status !== 'failed') {
      throw new Error(`Full journey cleanup failed after artifact generation: ${cleanupRes.status()} ${JSON.stringify(cleanupBody).slice(0, 1000)}`)
    }
  }

  test('student, service, payment, admin approval, installments, program access, and exam alignment work end-to-end', async ({ page }, testInfo: TestInfo) => {
    let cleanupTarget: { token: string; stamp: string } | null = null
    const prisma = new PrismaClient()
    try {
    if (process.env.E2E_QA_ONLY !== '1') throw new Error('Full student journey with database fixtures requires E2E_QA_ONLY=1')
    const admin = await loginAsAdmin(page)

    const setupRes = await page.request.post('/api/admin/full-journey', {
      headers: { Authorization: `Bearer ${admin.token}` },
      timeout: 90_000,
    })
    const setup = await setupRes.json().catch(() => ({}))
    if (setup?.stamp) cleanupTarget = { token: admin.token, stamp: String(setup.stamp) }
    expect(setupRes.ok(), `Full journey setup failed: ${setupRes.status()} ${JSON.stringify(setup).slice(0, 1200)}`).toBeTruthy()
    expect(setup.ok, `Full journey setup returned non-ok: ${JSON.stringify(setup.steps || setup).slice(0, 1200)}`).toBe(true)
    expect(setup.steps.every((s: any) => s.ok), `A setup step failed: ${JSON.stringify(setup.steps, null, 2)}`).toBe(true)
    expect(setup.tuitionGates?.semester1BeforeInitialPayment?.ok, 'Semester 1 exam must be blocked before half tuition payment').toBe(false)
    expect(setup.tuitionGates?.semester1BeforeInitialPayment?.code, 'Semester 1 block code must be TUITION_HALF_REQUIRED').toBe('TUITION_HALF_REQUIRED')
    expect(setup.tuitionGates?.semester1BeforeInitialPayment?.requiredAmount, 'Semester 1 required amount must equal half of total tuition').toBe((setup.tuitionGates?.semester1BeforeInitialPayment?.totalTuition || 0) / 2)
    expect(setup.tuitionGates?.semester1AfterInitialPayment?.ok, 'Semester 1 exam must open after half tuition payment').toBe(true)
    expect(setup.tuitionGates?.semester1AfterInitialPayment?.paidTuition, 'First installment must pay exactly half tuition').toBe((setup.tuitionGates?.semester1AfterInitialPayment?.totalTuition || 0) / 2)
    expect(setup.academicJourney?.tuitionGate?.semester2BeforeFinalPayment?.ok, 'Semester 2 exam must be blocked before full installment payment').toBe(false)
    expect(setup.academicJourney?.tuitionGate?.semester2BeforeFinalPayment?.code, 'Semester 2 block code must be TUITION_FULL_REQUIRED').toBe('TUITION_FULL_REQUIRED')
    expect(setup.academicJourney?.tuitionGate?.semester2AfterFinalPayment?.ok, 'Semester 2 exam must open after completing installment payment').toBe(true)
    for (const semester of ['semester1', 'semester2'] as const) {
      const state = setup.academicJourney?.semesters?.[semester]
      expect(state, `${semester}: missing semester journey`).toBeTruthy()
      for (const component of ['assignmentScore', 'unitQuizScore', 'examScore'] as const) {
        expect(typeof state?.[component], `${semester}: missing ${component}`).toBe('number')
        expect(Number.isFinite(state[component]), `${semester}: invalid ${component}`).toBe(true)
        expect(state[component], `${semester}: ${component} must be a passing QA fixture`).toBeGreaterThanOrEqual(60)
      }
      expect(state?.readinessAfterMark?.complete, `${semester}: unit/assignment/exam readiness incomplete`).toBe(true)
    }
    expect(setup.academicJourney?.semesters?.semester1?.passed, 'Semester 1 assignment/exam average must pass').toBe(true)
    expect(setup.academicJourney?.semesters?.semester1?.average || 0, 'Semester 1 average must be at least 60').toBeGreaterThanOrEqual(60)
    expect(setup.academicJourney?.semesters?.semester2?.passed, 'Semester 2 assignment/exam average must pass').toBe(true)
    expect(setup.academicJourney?.semesters?.semester2?.average || 0, 'Semester 2 average must be at least 60').toBeGreaterThanOrEqual(60)
    expect(setup.academicJourney?.thesis?.eligible, 'Student must become eligible for thesis after semesters and payment').toBe(true)
    expect(setup.academicJourney?.finalGrade?.score || 0, 'Final grade must be calculated and passing').toBeGreaterThanOrEqual(60)
    expect(setup.enrollment?.status, 'Enrollment should complete after final grade and thesis result').toBe('COMPLETED')

    const examsRes = await page.request.get(`/api/admin/program-exams?programId=${encodeURIComponent(setup.program.id)}&includeQuestions=1`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    })
    const examsBody = await examsRes.json().catch(() => ({}))
    expect(examsRes.ok(), `Loading generated exam diagnostics failed: ${examsRes.status()} ${JSON.stringify(examsBody).slice(0, 1200)}`).toBeTruthy()
    const exam = (examsBody.exams || []).find((e: any) => e.status === 'READY' && e.semester === 1) || (examsBody.exams || [])[0]
    expect(exam, 'Generated exam must be returned by admin program exams endpoint').toBeTruthy()
    expect(exam.questionCount, 'Generated exam must include at least six direct QA questions').toBeGreaterThanOrEqual(6)
    const alignment = scoreExamAlignment(exam, setup.book.title, setup.book.concepts || [])
    expect(alignment.total, 'Exam diagnostic must include at least six question details').toBeGreaterThanOrEqual(6)
    const examTypes = new Set(alignment.rows.map((q: any) => q.type))
    for (const requiredType of ['MCQ', 'TF', 'SHORT', 'ESSAY']) {
      expect(examTypes.has(requiredType), `Exam must include question type ${requiredType}`).toBeTruthy()
    }
    expect(alignment.score, `Exam questions are not sufficiently aligned to the book: ${JSON.stringify(alignment.rows, null, 2)}`).toBeGreaterThanOrEqual(80)
    const examGen = { ok: true, source: 'full-journey-setup', examId: exam.id, status: exam.status, questionCount: exam.questionCount }

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.evaluate((token) => {
      localStorage.setItem('aact_token', token)
      localStorage.setItem('aact_startup_seen_v2', '1')
      sessionStorage.setItem('aact_skip_startup', '1')
    }, admin.token)
    await page.goto('/?view=admin', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    const admissionCard = page.locator(`#admission-${setup.admission.id}`)
    await expect(admissionCard, 'Admin admission card must be visible for the full journey student').toBeVisible({ timeout: 30_000 })
    await expect(admissionCard.getByText(/فواتير غير مسددة/), 'Covered tuition installments must not leave a stale unpaid tuition warning').toHaveCount(0)

    const studentLogin = await login(page, setup.student.email, setup.student.password)
    expect(studentLogin.user?.role, 'The journey account must be a STUDENT, not an admin fixture').toBe('STUDENT')
    const studentAdminExams = await page.request.get(`/api/admin/program-exams?programId=${encodeURIComponent(setup.program.id)}&includeQuestions=1`, {
      headers: { Authorization: `Bearer ${studentLogin.token}` },
    })
    expect([401, 403], `Student accessed admin exam question bank: ${studentAdminExams.status()}`).toContain(studentAdminExams.status())
    const studentAdminJourney = await page.request.post('/api/admin/full-journey', {
      headers: { Authorization: `Bearer ${studentLogin.token}` },
      data: {},
    })
    expect([401, 403], `Student created an admin journey fixture: ${studentAdminJourney.status()}`).toContain(studentAdminJourney.status())
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await page.evaluate((token) => {
      localStorage.setItem('aact_token', token)
      localStorage.setItem('aact_startup_seen_v2', '1')
      sessionStorage.setItem('aact_skip_startup', '1')
    }, studentLogin.token)
    await page.goto(`/dashboard/program/${encodeURIComponent(setup.program.id)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
    const bodyText = await page.locator('body').innerText({ timeout: 10_000 }).catch(() => '')
    const dashboardOk = bodyText.includes(setup.program.title) || bodyText.includes('بوابة الطالب') || bodyText.includes('لوحة الطالب')
    expect(dashboardOk, `Student dashboard did not show program access. Body: ${bodyText.slice(0, 900)}`).toBeTruthy()

    const reopenAppeals = await verifyReopenAppealJourney(page, prisma, setup, admin.token, studentLogin.token)

    const report = {
      generatedAt: new Date().toISOString(),
      setup,
      reopenAppeals,
      exam: {
        generated: true,
        generation: examGen,
        questionCount: exam.questionCount,
        alignment,
      },
      studentAccess: {
        loginOk: !!studentLogin.token,
        dashboardOk,
        bodySample: bodyText.slice(0, 700),
      },
    }

    await mkdir('test-results/full-journey', { recursive: true }).catch(() => {})
    const jsonPath = 'test-results/full-journey/report.json'
    const mdPath = 'test-results/full-journey/report.md'
    const reopenMarkdown = `\n\n## Expired assignment and unit appeal journey\n\n- Semester grant allowed an unlinked assignment: **${reopenAppeals.unlinkedAssignmentSubmitted ? 'PASS' : 'FAIL'}**\n- Semester grant kept the expired unit closed: **${reopenAppeals.unitProtectedBySemesterGrant ? 'PASS' : 'FAIL'}**\n- Student filed the unit appeal from the exam screen: **${reopenAppeals.unitAppealRequestedFromExamScreen ? 'PASS' : 'FAIL'}**\n- Unit approval allowed assignment submission: **${reopenAppeals.unitAssignmentSubmitted ? 'PASS' : 'FAIL'}**\n- Unit approval allowed exam submission and grading: **${reopenAppeals.unitExamSubmitted ? 'PASS' : 'FAIL'}**\n`
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
    await writeFile(mdPath, md(report) + reopenMarkdown, 'utf8')
    await testInfo.attach('full-journey-report-json', { path: jsonPath, contentType: 'application/json' })
    await testInfo.attach('full-journey-report-md', { path: mdPath, contentType: 'text/markdown' })
    } finally {
      try {
        if (cleanupTarget) await cleanupFullJourney(page.request, testInfo, cleanupTarget)
      } finally {
        await prisma.$disconnect()
      }
    }
  })
})
