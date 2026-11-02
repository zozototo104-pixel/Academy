import { readFileSync } from 'fs'
import { join } from 'path'
import { calculateFinalGrade } from '../src/lib/final-grade'
import { evaluateProgramCertificateEligibility } from '../src/lib/certificate-eligibility'

function file(path: string) {
  return readFileSync(join(process.cwd(), path), 'utf8')
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message)
}

type DiplomaFixture = {
  unitScore?: number | null
  unitPassed?: boolean
  assignmentStatus?: 'GRADED' | 'SUBMITTED'
  assignmentScore?: number | null
  programAppealPending?: boolean
}

function mockDiplomaClient(programAttemptScores: number[], options: DiplomaFixture = {}) {
  const unitScore = options.unitScore === undefined ? 100 : options.unitScore
  const unitPassed = options.unitPassed ?? (unitScore !== null && unitScore >= 51)
  const client: any = {
    program: {
      findUnique: async () => ({ category: 'DIPLOMA', price: 0 }),
    },
    exam: {
      findMany: async () => [{
        id: 'unit-exam-1', title: 'اختبار وحدة', passScore: 51, unit: { title: 'الوحدة الأولى' },
        _count: { questions: 1 },
      }],
    },
    examAttempt: {
      findMany: async () => unitScore === null ? [] : [{
        status: 'GRADED', score: unitScore, passed: unitPassed,
        answers: [{ points: unitScore, maxPoints: 100 }],
      }],
    },
    programExam: {
      findMany: async () => [{ id: 'program-exam-1', title: 'الاختبار النهائي', semester: 1, passScore: 51 }],
    },
    programExamAttempt: {
      // Mimic Prisma's GRADED + non-pending-appeal WHERE filter, not unfiltered rows.
      findMany: async () => options.programAppealPending ? [] : programAttemptScores.map((score) => ({
        status: 'GRADED', score, finalScore: score, passed: score >= 51,
        appealStatus: null, answers: [{ points: score, maxPoints: 100 }],
      })),
    },
    programAssignment: {
      findMany: async () => [{ id: 'assignment-1', title: 'واجب تطبيقي', points: 100 }],
    },
    assignmentSubmission: {
      findUnique: async () => ({
        status: options.assignmentStatus || 'GRADED',
        score: options.assignmentScore === undefined ? 100 : options.assignmentScore,
      }),
    },
    thesisSubmission: {
      findFirst: async () => null,
    },
    enrollment: {
      findUnique: async () => ({ id: 'enrollment-1' }),
    },
    admissionApplication: {
      findFirst: async () => null,
      findUnique: async () => null,
    },
    payment: {
      findMany: async () => [{ purpose: 'TUITION', status: 'WAIVED', amount: 0, amountCents: 0 }],
    },
  }
  return client
}
async function testFinalGradeBehaviorWithMockData() {
  const bestAttemptGrade = await calculateFinalGrade({ userId: 'student-1', programId: 'program-1', client: mockDiplomaClient([60, 90]) })
  const finalExam = bestAttemptGrade.components.find((component) => component.key === 'final_exam')
  assert(finalExam?.score === 90, 'أفضل محاولة مصححة تدخل المعدل، لا متوسط المحاولات')

  const belowExamPass = await calculateFinalGrade({ userId: 'student-1', programId: 'program-1', client: mockDiplomaClient([50.96]) })
  assert(Math.abs((belowExamPass.components.find((c) => c.key === 'final_exam')?.score ?? 0) - 50.96) < 0.001, 'تُحفظ علامة الامتحان دون تقريب')
  const passesDespiteExam = await evaluateProgramCertificateEligibility({ userId: 'student-1', programId: 'program-1', client: mockDiplomaClient([50.96]) })
  assert(passesDespiteExam.ok, 'الطالب يستحق الشهادة إذا معدله فوق 50 حتى لو كان الامتحان نفسه أقل من درجة اجتيازه')

  const failedUnit = await evaluateProgramCertificateEligibility({
    userId: 'student-1', programId: 'program-1',
    client: mockDiplomaClient([90], { unitScore: 30, unitPassed: false }),
  })
  assert(failedUnit.ok && failedUnit.score !== null && failedUnit.score > 50,
    'رسوب وحدة لا يمنع الشهادة إذا مجموع الوحدات والواجبات والفصلي أكبر من 50')

  const missingUnit = await evaluateProgramCertificateEligibility({
    userId: 'student-1', programId: 'program-1',
    client: mockDiplomaClient([90], { unitScore: null }),
  })
  assert(missingUnit.ok, 'الوحدة غير المجابة تساوي صفر مساهمة، وليست شرط اجتياز منفصل')

  const ungradedAssignment = await evaluateProgramCertificateEligibility({
    userId: 'student-1', programId: 'program-1',
    client: mockDiplomaClient([90], { assignmentStatus: 'SUBMITTED' }),
  })
  assert(ungradedAssignment.ok, 'الواجب غير المصحح يأخذ صفر مساهمة من حصته ولا يمنع شهادة بمعدل كاف')

  const pendingAppeal = await evaluateProgramCertificateEligibility({
    userId: 'student-1', programId: 'program-1',
    client: mockDiplomaClient([90], { programAppealPending: true }),
  })
  assert(!pendingAppeal.ok, 'الطعن المعلق لا يضيف علامات الامتحان للمعدل، والـ40 المكتسبة لا تكفي')

  const atCutoff = await evaluateProgramCertificateEligibility({
    userId: 'student-1', programId: 'program-1',
    client: mockDiplomaClient([50], { unitScore: null }),
  })
  assert(!atCutoff.ok && atCutoff.score === 50, 'المعدل 50 بالضبط لا يتجاوز الحد الأدنى')

  const aboveCutoff = await evaluateProgramCertificateEligibility({
    userId: 'student-1', programId: 'program-1',
    client: mockDiplomaClient([50.01], { unitScore: null }),
  })
  assert(aboveCutoff.ok && aboveCutoff.score !== null && aboveCutoff.score > 50,
    'المعدل 50.006 يُقبل بدون التقريب إلى 50 أولاً')

  const belowCutoff = await evaluateProgramCertificateEligibility({
    userId: 'student-1', programId: 'program-1',
    client: mockDiplomaClient([49.99], { unitScore: null }),
  })
  assert(!belowCutoff.ok, 'المعدل الأقل من 50 لا يستحق الشهادة')
}
function testCentralCompletionOnly() {
  const submit = file('src/app/api/exam/submit/route.ts')
  assert(submit.includes("completeEnrollmentIfEligible({ enrollmentId: enrollment.id })"), 'unit exam submit must delegate completion to the central service')
  assert(!submit.includes('programUnits = await db.unit.count'), 'unit exam submit must not locally count all program units to issue certificates')
  assert(!submit.includes('data: { status: \'COMPLETED\''), 'unit exam submit must not directly mark Enrollment COMPLETED')
  assert(!submit.includes('AACT-${new Date().getFullYear()}'), 'unit exam submit must not mint local certificate numbers')

  const central = file('src/lib/enrollment-completion.ts')
  assert(central.includes('completeEnrollmentIfEligible'), 'central completion service must exist')
  assert(central.includes('db.$transaction'), 'central completion service must run inside a transaction')
  assert(central.includes('evaluateProgramCertificateEligibility'), 'central completion must use certificate eligibility')
  assert(central.includes('tx.enrollment.update'), 'central completion service must be the place that completes enrollment')
  assert(central.includes('tx.certificate.create'), 'central completion service must be the place that issues program certificates')
  const identity = file('src/lib/certificate-identity.ts')
  assert(identity.includes("SELECT nextval('\"Certificate_serial_seq\"')"), 'certificate serials must be allocated from the database sequence')
  assert(central.includes("from '@/lib/certificate-identity'") && central.includes('nextCertificateSerial(tx)'), 'central completion must allocate certificate serials via the shared database sequence helper')
  assert(central.includes('isCertificateSerialUniqueConflict'), 'central completion must detect unique serial conflicts')
  assert(central.includes('for (let attempt = 0; attempt < 3; attempt++)'), 'central completion must retry serial conflicts outside the transaction')
  assert(!central.includes('createProgramCompletionCertificateWithRetry'), 'central completion must not retry P2002 inside the same transaction')
  const programSubmit = file('src/app/api/program-exam/submit/route.ts')
  assert(programSubmit.includes('completeEnrollmentIfEligible({ enrollmentId: enrollment.id })'), 'program exam submit must also delegate eligible completion to the central service')
  assert(programSubmit.includes("return NextResponse.json({ error: 'JSON غير صالح في طلب التسليم' }, { status: 400 })"), 'program exam submit must return 400 for malformed JSON')
  assert(submit.includes("return NextResponse.json({ error: 'JSON غير صالح في طلب التسليم' }, { status: 400 })"), 'unit exam submit must return 400 for malformed JSON')
}

function testEligibilityRequiresAllAcademicAndFinancialInputs() {
  const finalGrade = file('src/lib/final-grade.ts')
  // Behavioral rejection and best-attempt coverage lives in testFinalGradeBehaviorWithMockData.
  // These checks guard required source wiring, not the exact Prisma query formatting.
  assert(finalGrade.includes('unitQuizAverage') && finalGrade.includes('exams.length'), 'final grade must enumerate and require unit exams')
  assert(finalGrade.includes("status: 'GRADED'") && finalGrade.includes("a.passed === true"), 'unit success must require a passed graded attempt')
  assert(finalGrade.includes('programExamAverage') && finalGrade.includes("appealStatus: { not: 'PENDING' }"), 'program exams must exclude pending appeals')
  assert(finalGrade.includes('assignmentAverage'), 'final grade must include published assignments')
  assert(finalGrade.includes("where: { programId, status: 'PUBLISHED' }"), 'published assignments must be enumerated')
  assert(finalGrade.includes("submission?.status === 'GRADED'"), 'published assignments must be graded')
  assert(finalGrade.includes('thesisScores'), 'masters/doctorate eligibility must include thesis/defense scores')
  assert(finalGrade.includes('percentFromAnswers') && finalGrade.includes('exam.passScore'), 'exam passing must use original answer-based percentage')
  assert(finalGrade.includes('function best(') && finalGrade.includes('best(scores)'), 'final grade must consider the best scored attempt per exam')

  const eligibility = file('src/lib/certificate-eligibility.ts')
  assert(eligibility.includes('academicScore <= CERTIFICATE_PASS_SCORE'), 'certificate eligibility must use the exact cumulative score above 50%')
  assert(!eligibility.includes('failedComponentLabels'), 'individual failed components must not independently block graduation')
  assert(eligibility.includes('finalGrade.earnedScore'), 'incomplete assessments must contribute zero credit instead of forcing null eligibility')
  assert(eligibility.includes('paymentEligibilityError'), 'certificate eligibility must include paid-fee checks')
  assert(eligibility.includes('tuitionPaidTotal'), 'certificate eligibility must require paid or waived tuition')

  const central = file('src/lib/enrollment-completion.ts')
  assert(central.includes('financialFailure'), 'central completion must include financial eligibility')
  assert(central.includes('tuitionPaidTotal'), 'central completion must require tuition to be paid or waived')
  assert(central.includes('PAYMENT_REQUIRED'), 'central completion must produce a payment-required failure')
}

function testAdminCertificatesUseCentralService() {
  const route = file('src/app/api/admin/certificates/route.ts')
  assert(route.includes('completeEnrollmentIfEligible'), 'admin certificates route must use central completion service')
  assert(!route.includes('db.certificate.create'), 'admin certificates route must not create certificates directly')
  assert(!route.includes('nextCertSerial'), 'admin certificates route must not mint certificate serials directly')
  assert(route.includes('status: result.httpStatus || 422'), 'admin certificates must return 422 for missing registration/payment/eligibility')
}

function testUnitExamAttemptSafety() {
  const submit = file('src/app/api/exam/submit/route.ts')
  assert(submit.includes('UNIT_EXAM_SUBMIT_GRACE_MS = 2 * 60 * 1000'), 'unit exam submit must allow only a two-minute grace period')
  assert(submit.includes('unitAttemptDeadline(activeAttempt.createdAt)'), 'unit exam submit must use server-created attempt time')
  assert(submit.includes("code: 'UNIT_EXAM_EXPIRED'"), 'unit exam submit must reject late submissions')

  const detail = file('src/app/api/exam/detail/route.ts')
  assert(detail.includes("status: 'GRADED', passed: true"), 'unit exam detail must look for an already passed attempt')
  assert(detail.includes("reason: 'PASSED_ALREADY'"), 'unit exam detail must block a new attempt after passing')
}

function testDefenseIncompleteCriteriaNeedsReview() {
  const defense = file('src/app/api/defense/route.ts')
  assert(defense.includes('{ requireAllCriteria: true }'), 'defense scoring must require all five criteria')
  assert(defense.includes('const incompleteCriteria = criteriaCovered.length < DEFENSE_CRITERIA.length'), 'defense must detect incomplete criteria coverage')
  assert(defense.includes("if (incompleteCriteria)") && defense.includes("data: { defenseStatus: 'NEEDS_REVIEW', aiScore: null"), 'early defense ending must become NEEDS_REVIEW')
  assert(defense.includes('weightedForEnd = scoreDefenseBreakdown(criteriaScores, { requireAllCriteria: true })') && defense.includes('noRebalance: true'), 'early defense ending must not rebalance partial scores')
  assert(defense.includes('reason: \'DEFENSE_CRITERIA_INCOMPLETE\''), 'defense breakdown must record incomplete criteria reason')
}

function testSchemaAndMigrationSafety() {
  const schema = file('prisma/schema.prisma')
  assert(schema.includes('enrollment   Enrollment? @relation(fields: [enrollmentId], references: [id], onDelete: Restrict)'), 'Certificate.enrollmentId must be a restrictive FK')
  assert(schema.includes('@@unique([enrollmentId, type])'), 'Certificate must be unique by enrollmentId and type')
  assert(schema.includes('Enrollment[]') && schema.includes('certificates Certificate[]'), 'User/Enrollment certificate relations must be declared')
  assert(schema.includes('user           User      @relation(fields: [userId], references: [id], onDelete: Restrict)'), 'Enrollment.user must restrict deletes')
  assert(schema.includes('program        Program   @relation(fields: [programId], references: [id], onDelete: Restrict)'), 'Enrollment.program must restrict deletes')
  assert(schema.includes('user        User      @relation(fields: [userId], references: [id], onDelete: Restrict)'), 'ExamAttempt.user must restrict deletes')
  assert(schema.includes('user        User     @relation(fields: [userId], references: [id], onDelete: Restrict)'), 'ThesisSubmission/ProgramExamAttempt user deletes must restrict')

  const migration = file('prisma/migrations/20261013153000_stage_c_completion_certificates/migration.sql')
  assert(migration.includes('CERTIFICATE_ORPHAN_ENROLLMENT_NULLIFIED'), 'migration must audit orphan certificate enrollment links before FK creation')
  assert(migration.includes('CERTIFICATE_DUPLICATE_ENROLLMENT_TYPE_INVALIDATED'), 'migration must audit duplicate enrollment/type certificates')
  assert(migration.includes('SET "enrollmentId" = NULL'), 'migration must unlink unsafe certificate rows instead of deleting them')
  assert(migration.includes('"valid" = false'), 'migration must invalidate duplicate certificate rows instead of deleting them')
  assert(!migration.includes('DELETE FROM "Certificate"'), 'migration must not delete certificates')
  assert(migration.includes('CREATE SEQUENCE IF NOT EXISTS "Certificate_serial_seq"'), 'migration must create an atomic certificate serial sequence')
  assert(migration.includes('ON DELETE RESTRICT'), 'migration must apply restrictive foreign keys')
}

function testProgramExamStartContract() {
  const detail = file('src/app/api/program-exam/detail/route.ts')
  const start = file('src/app/api/program-exam/start/route.ts')
  assert(!detail.includes('programExamAttempt.create'), 'program exam detail GET must not create attempts')
  assert(!detail.includes('FOR UPDATE'), 'program exam detail GET must remain read-only and avoid start locks')
  assert(detail.includes('serverNow'), 'program exam detail must return serverNow for client clock alignment')
  assert(start.includes('export async function POST'), 'program exam start endpoint must be POST-only')
  assert(start.includes('programExamAttempt.create'), 'program exam start endpoint must create the STARTED attempt')
  assert(start.includes("status: 'STARTED'"), 'program exam start endpoint must create or restore only STARTED attempts')
  assert(start.includes('FOR UPDATE'), 'program exam start endpoint must serialize concurrent starts with the existing user lock')
  assert(start.includes('getExamMaxAttempts(\'PROGRAM\''), 'program exam start must enforce max attempts before creating a new attempt')
}

function testMaxAttemptsAndAnswerKeyDisclosure() {
  const policy = file('src/lib/exam-attempt-policy.ts')
  assert(policy.includes('DEFAULT_EXAM_MAX_ATTEMPTS = 3'), 'exam maxAttempts default must be 3')
  assert(policy.includes("['PROGRAM_EXAM_MAX_ATTEMPTS', 'EXAM_MAX_ATTEMPTS']"), 'program exams must read program-specific maxAttempts setting first')
  assert(policy.includes("['UNIT_EXAM_MAX_ATTEMPTS', 'EXAM_MAX_ATTEMPTS']"), 'unit exams must read unit-specific maxAttempts setting first')
  assert(policy.includes('return input.passed || input.completedAttempts >= input.maxAttempts'), 'correct answers must reveal only after passing or exhausting attempts')

  const unitDetail = file('src/app/api/exam/detail/route.ts')
  const programStart = file('src/app/api/program-exam/start/route.ts')
  const unitSubmit = file('src/app/api/exam/submit/route.ts')
  const programSubmit = file('src/app/api/program-exam/submit/route.ts')
  assert(unitDetail.includes('MAX_ATTEMPTS_REACHED'), 'unit exam detail must block attempts after maxAttempts')
  assert(programStart.includes('MAX_ATTEMPTS_REACHED'), 'program exam start must block attempts after maxAttempts')
  assert(unitSubmit.includes('shouldRevealCorrectAnswers'), 'unit exam submit must apply answer-key disclosure policy')
  assert(programSubmit.includes('shouldRevealCorrectAnswers'), 'program exam submit must apply answer-key disclosure policy')
  assert(unitSubmit.includes('correctAnswerText, ...result'), 'unit exam submit must strip correctAnswerText before pass/exhaustion')
  assert(programSubmit.includes('correctAnswerText, correctRationale, wrongOptionRationale, ...result'), 'program exam submit must strip detailed answer keys before pass/exhaustion')
}

function testProgressCertificateUsesCentralServiceAndFullTuition() {
  const progress = file('src/app/api/progress/route.ts')
  assert(progress.includes('completeEnrollmentIfEligible({ enrollmentId: enrollment.id })'), 'progress POST must delegate PROGRAM_COMPLETION issuance to the central completion service')
  assert(progress.includes('completeEnrollmentIfEligible({ enrollmentId: enrollment.id })'), 'progress POST must defer graduation to central service')
  assert(progress.includes('data: { completedUnits: JSON.stringify(completedUnits) }'), 'marking a read unit may update only its progress, never graduation status or academic score')
  assert(!progress.includes('db.certificate.create'), 'progress POST must not create PROGRAM_COMPLETION certificates directly')
  assert(!progress.includes('nextCertSerial'), 'progress POST must not mint certificate serials directly')
  assert(!progress.includes('randomBytes(16).toString'), 'progress POST must not generate certificate tokens directly')
}

function testDefenseAnsweredCountIsSerialized() {
  const defense = file('src/app/api/defense/route.ts')
  assert(defense.includes('SELECT "id" FROM "ThesisSubmission" WHERE "id" = ${thesis.id} FOR UPDATE'), 'defense answer flow must lock the thesis row before counting answers')
  assert(defense.includes('const answeredCount = history.filter((m) => m.role === \'STUDENT\').length'), 'defense answer flow must compute answeredCount inside the locked transaction')
  assert(defense.includes('studentMessageId'), 'defense answer flow must reserve the student message inside the locked transaction')
  assert(defense.includes('where: { id: answerState.studentMessageId }'), 'defense answer score must update the reserved message rather than creating a second answer')
}

function testQuestionBankMethodologyUntouched() {
  const generation = file('src/app/api/admin/program-exams/generate/route.ts')
  assert(generation.includes('advanceProgramExamFromVerifiedBank'), 'program exam generation must still use the verified question-bank assembly path')
  assert(!generation.includes('Math.random()'), 'program exam generation must not switch to random question-bank methodology')
}

async function main() {
  await testFinalGradeBehaviorWithMockData()
  testCentralCompletionOnly()
  testEligibilityRequiresAllAcademicAndFinancialInputs()
  testAdminCertificatesUseCentralService()
  testUnitExamAttemptSafety()
  testProgramExamStartContract()
  testMaxAttemptsAndAnswerKeyDisclosure()
  testProgressCertificateUsesCentralServiceAndFullTuition()
  testDefenseIncompleteCriteriaNeedsReview()
  testDefenseAnsweredCountIsSerialized()
  testSchemaAndMigrationSafety()
  testQuestionBankMethodologyUntouched()
  console.log('✓ Stage C exam/certificate safety checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
