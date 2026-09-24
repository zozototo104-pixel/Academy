import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

function requiredEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function login(page: Page, email: string, password: string) {
  const response = await page.request.post('/api/auth/login', { data: { email, password } })
  const body = await response.json().catch(() => ({}))
  expect(response.ok(), `Login failed for ${email}: ${response.status()} ${JSON.stringify(body).slice(0, 700)}`).toBeTruthy()
  expect(body.token, 'Login response must include token').toBeTruthy()
  return { token: String(body.token), user: body.user }
}

async function loginAsAdmin(page: Page) {
  return login(page, requiredEnv('E2E_ADMIN_EMAIL'), requiredEnv('E2E_ADMIN_PASSWORD'))
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

function md(report: any) {
  const stepRows = report.setup.steps.map((s: any) => `| ${s.name} | ${s.ok ? '✅' : '❌'} | ${String(s.detail || '').replace(/\|/g, '/')} |`).join('\n')
  const qRows = report.exam.alignment.rows.map((q: any) => `| ${q.type} | ${q.aligned ? '✅' : '❌'} | ${q.titleHit ? 'book' : q.conceptHits.join(', ')} | ${String(q.text || '').replace(/\|/g, '/').slice(0, 160)} |`).join('\n')
  const academic = report.setup.academicJourney || {}
  return `# AACT Platform Full Journey Report\n\nGenerated: ${new Date().toISOString()}\n\n## Setup and business operations\n\n| Step | Result | Detail |\n|---|---|---|\n${stepRows}\n\n## Academic + financial gates\n\n- Semester 1 before half tuition: **${report.setup.tuitionGates?.semester1BeforeInitialPayment?.ok === false ? 'BLOCKED ✅' : 'NOT BLOCKED ❌'}**\n- Semester 1 after half tuition: **${report.setup.tuitionGates?.semester1AfterInitialPayment?.ok ? 'OPEN ✅' : 'BLOCKED ❌'}**\n- Semester 1 average: **${academic.semesters?.semester1?.average ?? '—'}%**\n- Semester 2 average: **${academic.semesters?.semester2?.average ?? '—'}%**\n- Semester 2 before full installment: **${academic.tuitionGate?.semester2BeforeFinalPayment?.ok === false ? 'BLOCKED ✅' : 'NOT BLOCKED ❌'}**\n- Semester 2 after full installment: **${academic.tuitionGate?.semester2AfterFinalPayment?.ok ? 'OPEN ✅' : 'BLOCKED ❌'}**\n- Thesis eligible: **${academic.thesis?.eligible ? 'YES ✅' : 'NO ❌'}**\n- Final grade: **${academic.finalGrade?.score ?? '—'}%**\n- Enrollment status: **${report.setup.enrollment?.status || '—'}**\n\n## Student access\n\n- Student login: **${report.studentAccess.loginOk ? 'OK' : 'FAILED'}**\n- Dashboard visible: **${report.studentAccess.dashboardOk ? 'OK' : 'FAILED'}**\n- Program: ${report.setup.program.title}\n\n## Exam generation and book alignment\n\n- Exam generated: **${report.exam.generated ? 'YES' : 'NO'}**\n- Question count: **${report.exam.questionCount}**\n- Alignment score: **${report.exam.alignment.score}%**\n- Book: ${report.setup.book.title}\n\n| Type | Aligned | Evidence | Question |\n|---|---|---|---|\n${qRows}\n`
}

test.describe('AACT full platform journey suite', () => {
  test.setTimeout(180_000)

  test('student, service, payment, admin approval, installments, program access, and exam alignment work end-to-end', async ({ page }, testInfo: TestInfo) => {
    const admin = await loginAsAdmin(page)

    const setupRes = await page.request.post('/api/admin/full-journey', {
      headers: { Authorization: `Bearer ${admin.token}` },
      timeout: 90_000,
    })
    const setup = await setupRes.json().catch(() => ({}))
    expect(setupRes.ok(), `Full journey setup failed: ${setupRes.status()} ${JSON.stringify(setup).slice(0, 1200)}`).toBeTruthy()
    expect(setup.ok, `Full journey setup returned non-ok: ${JSON.stringify(setup.steps || setup).slice(0, 1200)}`).toBe(true)
    expect(setup.steps.every((s: any) => s.ok), `A setup step failed: ${JSON.stringify(setup.steps, null, 2)}`).toBe(true)
    expect(setup.tuitionGates?.semester1BeforeInitialPayment?.ok, 'Semester 1 exam must be blocked before half tuition payment').toBe(false)
    expect(setup.tuitionGates?.semester1BeforeInitialPayment?.code, 'Semester 1 block code must be TUITION_HALF_REQUIRED').toBe('TUITION_HALF_REQUIRED')
    expect(setup.tuitionGates?.semester1AfterInitialPayment?.ok, 'Semester 1 exam must open after half tuition payment').toBe(true)
    expect(setup.academicJourney?.tuitionGate?.semester2BeforeFinalPayment?.ok, 'Semester 2 exam must be blocked before full installment payment').toBe(false)
    expect(setup.academicJourney?.tuitionGate?.semester2BeforeFinalPayment?.code, 'Semester 2 block code must be TUITION_FULL_REQUIRED').toBe('TUITION_FULL_REQUIRED')
    expect(setup.academicJourney?.tuitionGate?.semester2AfterFinalPayment?.ok, 'Semester 2 exam must open after completing installment payment').toBe(true)
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

    const studentLogin = await login(page, setup.student.email, setup.student.password)
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

    const report = {
      generatedAt: new Date().toISOString(),
      setup,
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
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8')
    await writeFile(mdPath, md(report), 'utf8')
    await testInfo.attach('full-journey-report-json', { path: jsonPath, contentType: 'application/json' })
    await testInfo.attach('full-journey-report-md', { path: mdPath, contentType: 'text/markdown' })
  })
})
